/**
 * The session registry, stored in D1.
 *
 * A session and its instance are 1:1 by design — the session id is the
 * instance id — so both live in one `sessions` row, and the two record shapes
 * the rest of the code speaks (`SessionRecord`, `InstanceRecord`) are
 * projections of that row. The Worker routes, the SessionAgent and the Sandbox
 * all read and write here directly; what used to be the Hub Durable Object's
 * storage transactions are single conditional statements, so no caller ever
 * holds a read-modify-write window. The Hub object itself survives only as the
 * alarm that drains the deletion queue (see [hub.ts](hub.ts)).
 *
 * Every query goes through the primary: the D1 Sessions API (read
 * replication) is deliberately unused, so reads here are strongly consistent
 * with the writes that precede them.
 */
import { getSandbox } from '@cloudflare/sandbox';
import {
  REPO_CATALOG_TTL_MS,
  fetchGithubRepoCatalog,
  orderReposByLastUse,
  withReposInUse
} from './github-catalog';
import {
  parseRepoJson,
  rowToInstance,
  rowToSession,
  sessionPatchBindings,
  type SessionRow
} from './hub-rows';
import { HUB_DURABLE_OBJECT_ID, type InstanceRecord } from './instances';
import type { LifecycleCoordinator } from './lifecycle';
import type { ModelCatalog } from './model-catalog';
import {
  isSafeRepoDefinition,
  repoWorkspaceDirectory,
  type RepoDefinition
} from './repos';
import { SETTING_KEYS, readSetting, writeSetting } from './settings';
import type { SessionRecord, SessionStatePatch } from './sessions';

const REPO_CATALOG_SETTING_KEY = 'repo-catalog';

/** Both projections of one row, for callers that need the pair. */
export interface RegistryEntry {
  session: SessionRecord;
  instance: InstanceRecord;
}

/** The stored answer from GitHub, kept until the next successful refresh. */
interface CachedRepoCatalog {
  fetchedAt: string;
  repos: RepoDefinition[];
}

/** The catalog as the composer sees it, with the age it needs to act on. */
export interface RepoCatalogView {
  repos: RepoDefinition[];
  /** When GitHub was last read successfully. */
  fetchedAt: string;
  /** True once the stored answer is older than the TTL: refresh when idle. */
  stale: boolean;
}

export async function listInstances(env: Env): Promise<InstanceRecord[]> {
  return (await listRows(env)).map(rowToInstance);
}

export async function getInstance(
  env: Env,
  id: string
): Promise<InstanceRecord | undefined> {
  const row = await getRow(env, id);
  return row ? rowToInstance(row) : undefined;
}

export async function listSessions(env: Env): Promise<SessionRecord[]> {
  return (await listRows(env)).map(rowToSession);
}

export async function getSession(
  env: Env,
  id: string
): Promise<SessionRecord | undefined> {
  const row = await getRow(env, id);
  return row ? rowToSession(row) : undefined;
}

/**
 * Both projections at once, newest first. The session list renders instance
 * state next to every session, and they come from the same row — reading them
 * as a pair is what keeps that list a single query.
 */
export async function listRegistry(env: Env): Promise<RegistryEntry[]> {
  return (await listRows(env)).map((row) => ({
    session: rowToSession(row),
    instance: rowToInstance(row)
  }));
}

async function listRows(env: Env): Promise<SessionRow[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM sessions ORDER BY created_at DESC'
  ).all<SessionRow>();
  return result.results;
}

async function getRow(env: Env, id: string): Promise<SessionRow | null> {
  return env.DB.prepare('SELECT * FROM sessions WHERE id = ?1')
    .bind(id)
    .first<SessionRow>();
}

/**
 * Create a session and the instance that runs it in one step. The session id
 * is the instance id: one session always owns exactly one container.
 *
 * The record starts with the opening prompt already counted as pending; the
 * caller then hands it to the session's SessionAgent for dispatch. The row is
 * only written once the Sandbox and the LifecycleCoordinator have both
 * initialized, so the registry never names a container that does not exist.
 */
export async function createSession(
  env: Env,
  input: {
    repo: RepoDefinition;
    model: string;
    variant?: string;
    title: string;
  },
  // Loaded by the route that already validated the request against it, so the
  // same catalog answers both checks.
  catalog: ModelCatalog
): Promise<SessionRecord> {
  if (!isSafeRepoDefinition(input.repo)) {
    throw new Error('Unknown repository');
  }
  if (!catalog.isModelRef(input.model)) {
    throw new Error(`Unknown model: ${String(input.model)}`);
  }

  const now = new Date().toISOString();
  const id = `inst-${crypto.randomUUID()}`;
  const record: SessionRecord = {
    id,
    instanceId: id,
    repoKey: input.repo.repoKey,
    // Pinned with the instance, so nothing this session does later depends on
    // the catalog still containing the repository it started from.
    directory: repoWorkspaceDirectory(input.repo.repoKey),
    model: input.model,
    ...(input.variant ? { variant: input.variant } : {}),
    title: input.title,
    phase: 'queued',
    pendingPromptCount: 1,
    createdAt: now,
    updatedAt: now
  };

  const sandbox = resolveSandbox(env, id);
  const lifecycle = resolveLifecycle(env, id);
  await sandbox.initializeInstance(id, input.repo.repoKey, input.repo);
  try {
    await lifecycle.initializeInstance({ instanceId: id });
    await env.DB.prepare(
      `INSERT INTO sessions (
         id, name, repo_key, repo_json, lifecycle,
         directory, model, variant, title, phase, pending_prompt_count,
         created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, 'ready', ?5, ?6, ?7, ?8, 'queued', 1, ?9, ?9)`
    )
      .bind(
        id,
        randomInstanceName(),
        input.repo.repoKey,
        JSON.stringify(input.repo),
        record.directory,
        input.model,
        input.variant ?? null,
        input.title,
        now
      )
      .run();
  } catch (error) {
    await sandbox.purgeInstance().catch(() => undefined);
    await lifecycle.markDeleted().catch(() => undefined);
    throw error;
  }
  return record;
}

/**
 * Mirror of the SessionAgent's dispatch state; the agent stays canonical.
 *
 * One conditional UPDATE: every field is applied against the row as it is in
 * the database, so the three writers of session state (Worker routes, the
 * SessionAgent, the Sandbox's title sync) can interleave without losing each
 * other's fields. The title only lands while `title_locked` is unset — a name
 * a human chose outranks the automatic one.
 */
export async function updateSession(
  env: Env,
  id: string,
  patch: SessionStatePatch
): Promise<SessionRecord | undefined> {
  const row = await env.DB.prepare(
    `UPDATE sessions SET
       phase                = COALESCE(?2, phase),
       model                = COALESCE(?3, model),
       title                = CASE WHEN title_locked = 0 AND ?4 IS NOT NULL
                                   THEN ?4 ELSE title END,
       opencode_session_id  = COALESCE(?5, opencode_session_id),
       pending_prompt_count = COALESCE(?6, pending_prompt_count),
       last_prompt_at       = COALESCE(?7, last_prompt_at),
       variant    = CASE ?8  WHEN 'set' THEN ?9  WHEN 'clear' THEN NULL ELSE variant    END,
       last_error = CASE ?10 WHEN 'set' THEN ?11 WHEN 'clear' THEN NULL ELSE last_error END,
       updated_at = ?12
     WHERE id = ?1
     RETURNING *`
  )
    .bind(id, ...sessionPatchBindings(patch), new Date().toISOString())
    .first<SessionRow>();
  return row ? rowToSession(row) : undefined;
}

/**
 * Name a session by hand.
 *
 * This also stops the automatic title from applying: a session OpenCode would
 * have called something else keeps the name it was given.
 */
export async function renameSession(
  env: Env,
  id: string,
  title: string
): Promise<SessionRecord | undefined> {
  const row = await env.DB.prepare(
    `UPDATE sessions SET title = ?2, title_locked = 1, updated_at = ?3
     WHERE id = ?1
     RETURNING *`
  )
    .bind(id, title, new Date().toISOString())
    .first<SessionRow>();
  return row ? rowToSession(row) : undefined;
}

/**
 * Queue an instance for deletion and wake the Hub's delete alarm.
 *
 * The compare-and-swap claims the row for a fresh operation unless one is
 * already in flight, in which case that operation is reused — deleting twice
 * must not restart a purge that is already running. Both outcomes end with a
 * poke, and pokes are idempotent, so the interleavings are all harmless.
 */
export async function beginDelete(
  env: Env,
  id: string
): Promise<InstanceRecord | undefined> {
  const row = await env.DB.prepare(
    `UPDATE sessions SET
       lifecycle = 'deleting',
       delete_operation_id = ?2,
       lifecycle_error = NULL,
       updated_at = ?3
     WHERE id = ?1
       AND NOT (lifecycle = 'deleting' AND delete_operation_id IS NOT NULL)
     RETURNING *`
  )
    .bind(id, crypto.randomUUID(), new Date().toISOString())
    .first<SessionRow>();
  const record = row ? rowToInstance(row) : await getInstance(env, id);
  if (!record) {
    return undefined;
  }
  await env.Hub.getByName(HUB_DURABLE_OBJECT_ID).poke();
  await resolveLifecycle(env, id).beginDelete();
  return record;
}

/** The oldest queued deletion, which the Hub alarm works on next. */
export async function nextPendingDeletion(
  env: Env
): Promise<InstanceRecord | undefined> {
  const row = await env.DB.prepare(
    `SELECT * FROM sessions
     WHERE lifecycle = 'deleting' AND delete_operation_id IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT 1`
  ).first<SessionRow>();
  return row ? rowToInstance(row) : undefined;
}

export async function hasPendingDeletion(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS pending FROM sessions
     WHERE lifecycle = 'deleting' AND delete_operation_id IS NOT NULL
     LIMIT 1`
  ).first<{ pending: number }>();
  return row !== null;
}

/**
 * The three ways a delete attempt ends. Each is fenced on the operation id, so
 * an attempt that lost its claim while it was purging cannot write over the
 * operation that replaced it.
 */
export async function markDeleteFailed(
  env: Env,
  id: string,
  operationId: string,
  error: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET lifecycle = 'delete_failed', lifecycle_error = ?3, updated_at = ?4
     WHERE id = ?1 AND delete_operation_id = ?2`
  )
    .bind(id, operationId, error, new Date().toISOString())
    .run();
}

export async function deferDelete(
  env: Env,
  id: string,
  operationId: string,
  message: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET lifecycle_error = ?3, updated_at = ?4
     WHERE id = ?1 AND delete_operation_id = ?2`
  )
    .bind(id, operationId, `${message}; retry scheduled`, new Date().toISOString())
    .run();
}

export async function finishDelete(
  env: Env,
  id: string,
  operationId: string
): Promise<void> {
  // A session and its instance share one row, so deletion is one statement.
  await env.DB.prepare(
    'DELETE FROM sessions WHERE id = ?1 AND delete_operation_id = ?2'
  )
    .bind(id, operationId)
    .run();
}

/**
 * The repositories a new session may choose from.
 *
 * GitHub is the only source, and the last answer it gave is kept in the
 * `settings` table for good — the same durable place the session records live,
 * not a cache that expires into nothing. A read never waits on GitHub once
 * there is something stored: the stored list is returned immediately and
 * `stale` says it is older than the TTL, which the composer turns into one
 * refresh after the page has rendered. Only the very first read of a fresh
 * deployment, and an explicit `force`, go to GitHub with somebody waiting.
 *
 * A failed refresh serves the last good answer, because a GitHub outage
 * should not stop somebody starting a session on a repository that has been
 * there all along. With nothing stored it raises: an empty picker that looks
 * like "you have no repositories" would be worse than an error saying the
 * listing failed.
 *
 * The answer is ordered by what this Hub has actually been used for, so the
 * composer's default is the repository the last session ran in. That is
 * derived from the session records rather than stored beside the catalog:
 * sessions already are the record of what was used and when, and they are the
 * same on every browser somebody opens the Hub from.
 */
export async function listRepoCatalog(
  env: Env,
  force = false
): Promise<RepoCatalogView> {
  const stored = await readRepoCatalog(env, force);
  const [lastUsed, inUse] = await Promise.all([
    repoLastUse(env),
    reposInUse(env)
  ]);
  return {
    repos: orderReposByLastUse(withReposInUse(stored.repos, inUse), lastUsed),
    fetchedAt: stored.fetchedAt,
    stale: Date.now() - Date.parse(stored.fetchedAt) >= REPO_CATALOG_TTL_MS
  };
}

/** Resolve a repository key against the catalog a session may be created from. */
export async function findCatalogRepo(
  env: Env,
  repoKey: string
): Promise<RepoDefinition | undefined> {
  return (await listRepoCatalog(env)).repos.find(
    (repo) => repo.repoKey === repoKey
  );
}

/** The stored catalog, in GitHub's own order, refreshed only when asked. */
async function readRepoCatalog(
  env: Env,
  force: boolean
): Promise<CachedRepoCatalog> {
  const stored = await readSetting<CachedRepoCatalog>(
    env,
    REPO_CATALOG_SETTING_KEY
  );
  if (stored && !force) {
    return stored;
  }
  // A `GITHUB_TOKEN` wrangler secret still wins as an escape hatch (it is not
  // declared in wrangler.jsonc, because it exists only where somebody has set
  // one); the normal home for the token is the settings table.
  const token =
    (env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN ||
    (await readSetting<string>(env, SETTING_KEYS.githubToken));
  try {
    if (!token) {
      throw new Error(
        'No GitHub token is configured; set one on the settings page'
      );
    }
    const repos = await fetchGithubRepoCatalog(token);
    if (repos.length === 0) {
      throw new Error('GitHub returned no repositories this token can push to');
    }
    const refreshed: CachedRepoCatalog = {
      fetchedAt: new Date().toISOString(),
      repos
    };
    await writeSetting(env, REPO_CATALOG_SETTING_KEY, refreshed);
    return refreshed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stored) {
      console.warn('Serving a stale repository catalog', message);
      return stored;
    }
    throw new Error(`Failed to read the repository catalog: ${message}`);
  }
}

/**
 * The repository entries pinned on existing sessions.
 *
 * A repository somebody is working in has to stay in the picker even when
 * GitHub stops listing it — a transfer, a revoked grant, a token swap — since
 * the alternative is that starting another session in the repository you are
 * currently living in becomes impossible.
 */
async function reposInUse(env: Env): Promise<RepoDefinition[]> {
  const result = await env.DB.prepare(
    'SELECT repo_json FROM sessions WHERE repo_json IS NOT NULL'
  ).all<{ repo_json: string }>();
  return result.results
    .map((row) => parseRepoJson(row.repo_json))
    .filter((repo): repo is RepoDefinition => repo !== undefined);
}

/**
 * When each repository was last worked in, by key.
 *
 * A session counts as used at its most recent prompt, not its creation: going
 * back to a month-old session is exactly as good a signal that this is the
 * repository somebody is living in. ISO timestamps compare lexicographically,
 * so MAX over the strings is MAX over the moments.
 */
async function repoLastUse(env: Env): Promise<Map<string, string>> {
  const result = await env.DB.prepare(
    `SELECT repo_key,
            MAX(CASE WHEN last_prompt_at > created_at
                     THEN last_prompt_at ELSE created_at END) AS last_used
     FROM sessions
     GROUP BY repo_key`
  ).all<{ repo_key: string; last_used: string }>();
  return new Map(result.results.map((row) => [row.repo_key, row.last_used]));
}

function resolveSandbox(env: Env, id: string) {
  return getSandbox(env.Sandbox, id, {
    normalizeId: true,
    keepAlive: true
  });
}

function resolveLifecycle(env: Env, id: string) {
  const lifecycleEnv = env as Env & {
    LifecycleCoordinator: DurableObjectNamespace<LifecycleCoordinator>;
  };
  return lifecycleEnv.LifecycleCoordinator.getByName(id);
}

const ADJECTIVES = [
  'amber',
  'bright',
  'calm',
  'cobalt',
  'coral',
  'gentle',
  'golden',
  'lucky',
  'lunar',
  'mint',
  'quiet',
  'rapid',
  'silver',
  'solar',
  'swift',
  'violet'
] as const;

const NOUNS = [
  'badger',
  'cedar',
  'comet',
  'falcon',
  'fjord',
  'fox',
  'heron',
  'lynx',
  'maple',
  'otter',
  'panda',
  'pine',
  'raven',
  'reef',
  'sparrow',
  'wolf'
] as const;

function randomInstanceName(): string {
  const adjective = ADJECTIVES[randomIndex(ADJECTIVES.length)];
  const noun = NOUNS[randomIndex(NOUNS.length)];
  const suffix = randomIndex(36 ** 4).toString(36).padStart(4, '0');
  return `${adjective}-${noun}-${suffix}`;
}

function randomIndex(length: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % length;
}
