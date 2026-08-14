/**
 * `/api/prebuilds` — the manual face of per-repo prebuilds
 * (docs/prebuild-design.md, "Dedicated prebuild runs").
 *
 * GET is the whole observability story: the registry plus the newest run per
 * (host, repo), everything the page needs beside the catalog it already has.
 * POST hands the run to that pair's PrebuildRunner Durable Object, whose
 * identity is what serializes runs. DELETE asks that host's Docker agent to
 * drop the volume and then forgets the registry row.
 *
 * A prebuild is a volume on one box, so everything here is addressed by host
 * as well as by repository: the same repository can be prebuilt on every
 * Docker host and each copy is its own row, its own run history and its own
 * delete. Docker-only for now; the provider field exists so phase 2 can add
 * 'cloudflare' without changing the shape.
 */
import type { SessionProvider } from '../protocol/types.ts';
import { listDockerHosts, resolveDockerHost } from './sandbox-providers.ts';
import { HttpError, json } from './http.ts';
import { resolveHostClient } from './host-client.ts';
import { findCatalogRepo } from './hub-store.ts';
import {
  deletePrebuildRecord,
  deletePrebuildRuns,
  latestPrebuildRuns,
  listPrebuildRecords,
  prebuildKey
} from './prebuilds.ts';
import { isSafeRepoKey } from './repos.ts';

export async function handlePrebuildsApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  // segments: ['api', 'prebuilds', maybe repoKey]

  if (segments.length === 2) {
    if (request.method === 'GET') {
      return listPrebuilds(env);
    }
    if (request.method === 'POST') {
      return startRun(request, env);
    }
    throw new HttpError(405, 'Use GET or POST');
  }

  if (segments.length === 3 && request.method === 'DELETE') {
    return removePrebuild(env, segments[2]!, url.searchParams.get('provider'));
  }
  throw new HttpError(404, 'No such prebuild route');
}

async function listPrebuilds(env: Env): Promise<Response> {
  const [prebuilds, runs, hosts] = await Promise.all([
    listPrebuildRecords(env),
    latestPrebuildRuns(env),
    listDockerHosts(env)
  ]);
  return json({
    prebuilds,
    // Keyed by `<provider>/<repoKey>`: the page draws one section per host and
    // a repository can have a prebuild on each.
    runs: Object.fromEntries(runs),
    // Which hosts can be built on at all, named. A row whose provider is not
    // in here belongs to a host that has since been removed — still deletable,
    // never buildable.
    hosts: hosts.map((host) => ({ provider: host.provider, label: host.label }))
  });
}

async function startRun(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => {
    throw new HttpError(400, 'Request body must be valid JSON');
  })) as { repoKey?: unknown; provider?: unknown };

  const { repoKey, provider } = body;
  if (!isSafeRepoKey(repoKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  const host = await resolveBuildHost(env, provider);
  const repo = await findCatalogRepo(env, repoKey);
  if (!repo) {
    throw new HttpError(404, `No repository named ${repoKey} in the catalog`);
  }

  const runId = crypto.randomUUID();
  const runner = env.PrebuildRunner.getByName(prebuildKey(host, repoKey));
  const result = await runner.startRun({ runId, repoKey, repo, provider: host });
  if (!result.started) {
    throw new HttpError(
      409,
      'A prebuild run is already underway for this repository on this host'
    );
  }
  return json({ runId }, 202);
}

/**
 * Which host a run is for. Omitting the field takes the first configured one,
 * which is what a deployment with a single box means by "build it"; naming a
 * host that is not configured is refused rather than silently redirected,
 * because the volume would land on the wrong box.
 */
async function resolveBuildHost(
  env: Env,
  provider: unknown
): Promise<SessionProvider> {
  if (provider === undefined || provider === null) {
    const [first] = await listDockerHosts(env);
    if (!first) {
      throw new HttpError(
        409,
        'No Docker sandbox host is configured; prebuilds need one'
      );
    }
    return first.provider;
  }
  if (typeof provider !== 'string') {
    throw new HttpError(400, 'Prebuilds run on a docker provider only');
  }
  const host = await resolveDockerHost(env, provider as SessionProvider);
  if (!host) {
    throw new HttpError(
      409,
      `Docker sandbox host "${provider}" is not configured`
    );
  }
  return host.provider;
}

/**
 * Drop one host's copy. The provider must be named — a repository can hold a
 * prebuild on every host, and there is no sensible "delete it somewhere".
 *
 * A row whose host is no longer configured still deletes: the volume is beyond
 * reach on a box the site can no longer address, but the registry row and its
 * run history are ours and would otherwise be permanent.
 */
async function removePrebuild(
  env: Env,
  rawKey: string,
  rawProvider: string | null
): Promise<Response> {
  if (!isSafeRepoKey(rawKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  if (rawProvider === null) {
    throw new HttpError(400, 'Name the host to delete from with ?provider=');
  }
  const provider = rawProvider as SessionProvider;
  const runner = env.PrebuildRunner.getByName(prebuildKey(provider, rawKey));
  if (await runner.isRunning()) {
    throw new HttpError(409, 'A prebuild run is underway; wait for it to finish');
  }
  if (await resolveDockerHost(env, provider)) {
    // The same throwaway id the runner uses; prebuild routes ignore it.
    const host = await resolveHostClient(
      env,
      `pbr-${rawKey.slice(0, 56)}`,
      provider
    );
    await host.prebuildRemove(rawKey);
  }
  await deletePrebuildRecord(env, rawKey, provider);
  // The run history goes too: the settings list shows any repo whose latest
  // run did not succeed, so a kept failure would be an undeletable row.
  await deletePrebuildRuns(env, rawKey, provider);
  return json({ removed: true });
}
