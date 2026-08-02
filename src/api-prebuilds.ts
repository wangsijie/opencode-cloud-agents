/**
 * `/api/prebuilds` — the manual face of per-repo prebuilds
 * (docs/prebuild-design.md, "Dedicated prebuild runs").
 *
 * GET is the whole observability story: the registry plus the newest run per
 * repo, everything the page needs beside the catalog it already has. POST
 * hands the run to the repo's PrebuildRunner Durable Object, whose identity
 * is what serializes runs per repo. DELETE asks the Docker agent to drop the
 * volume and then forgets the registry row.
 *
 * Docker-only for now; the provider field exists so phase 2 can add
 * 'cloudflare' without changing the shape.
 */
import { readDockerProviderConfig } from './sandbox-providers.ts';
import { HttpError, json } from './http.ts';
import { resolveHostClient } from './host-client.ts';
import { findCatalogRepo } from './hub-store.ts';
import {
  deletePrebuildRecord,
  deletePrebuildRuns,
  latestPrebuildRuns,
  listPrebuildRecords
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
    return removePrebuild(env, segments[2]!);
  }
  throw new HttpError(404, 'No such prebuild route');
}

async function listPrebuilds(env: Env): Promise<Response> {
  const [prebuilds, runs] = await Promise.all([
    listPrebuildRecords(env),
    latestPrebuildRuns(env)
  ]);
  return json({ prebuilds, runs: Object.fromEntries(runs) });
}

async function startRun(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => {
    throw new HttpError(400, 'Request body must be valid JSON');
  })) as { repoKey?: unknown; provider?: unknown };

  const { repoKey, provider } = body;
  if (!isSafeRepoKey(repoKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  if (provider !== undefined && provider !== 'docker') {
    throw new HttpError(400, 'Prebuilds run on the docker provider only');
  }
  if (!(await readDockerProviderConfig(env))) {
    throw new HttpError(
      409,
      'The Docker sandbox host is not configured; prebuilds need it'
    );
  }
  const repo = await findCatalogRepo(env, repoKey);
  if (!repo) {
    throw new HttpError(404, `No repository named ${repoKey} in the catalog`);
  }

  const runId = crypto.randomUUID();
  const runner = env.PrebuildRunner.getByName(repoKey);
  const result = await runner.startRun({ runId, repoKey, repo });
  if (!result.started) {
    throw new HttpError(409, 'A prebuild run is already underway for this repository');
  }
  return json({ runId }, 202);
}

async function removePrebuild(env: Env, rawKey: string): Promise<Response> {
  if (!isSafeRepoKey(rawKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  const runner = env.PrebuildRunner.getByName(rawKey);
  if (await runner.isRunning()) {
    throw new HttpError(409, 'A prebuild run is underway; wait for it to finish');
  }
  if (await readDockerProviderConfig(env)) {
    // The same throwaway id the runner uses; prebuild routes ignore it.
    const host = await resolveHostClient(
      env,
      `pbr-${rawKey.slice(0, 56)}`,
      'docker'
    );
    await host.prebuildRemove(rawKey);
  }
  await deletePrebuildRecord(env, rawKey, 'docker');
  // The run history goes too: the settings list shows any repo whose latest
  // run did not succeed, so a kept failure would be an undeletable row.
  await deletePrebuildRuns(env, rawKey);
  return json({ removed: true });
}
