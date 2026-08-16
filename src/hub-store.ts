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
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  not,
  notInArray,
  or,
  sql
} from 'drizzle-orm';
import type { SessionProvider } from '../protocol/types.ts';
import {
  db,
  lastActivityAt,
  pinnedFirst,
  sessionActivityAt,
  sessions
} from './db/index.ts';
import {
  REPO_CATALOG_TTL_MS,
  fetchGithubRepoCatalog,
  orderReposByLastUse,
  withReposInUse
} from './github-catalog.ts';
import {
  parseRepoJson,
  rowToInstance,
  rowToSession,
  sessionPatchAssignments,
  type SessionRow
} from './hub-rows.ts';
import { HUB_DURABLE_OBJECT_ID, type InstanceRecord } from './instances.ts';
import type { LifecycleCoordinator } from './lifecycle.ts';
import type { ModelCatalog, ModelSelection } from './model-catalog.ts';
import {
  isSafeRepoDefinition,
  workspaceDirectory,
  type RepoDefinition
} from './repos.ts';
import {
  markSessionStatusQuery,
  patchSessionRuntimeStatus,
  type SessionRuntimeStatusPatch
} from './session-runtime-cache.ts';
import { SETTING_KEYS, readSetting, writeSetting } from './settings.ts';
import {
  cleanupCutoff,
  type BootStep,
  type SessionRecord,
  type SessionStatePatch,
} from './sessions.ts';

export {
  markSessionStatusQuery,
  patchSessionRuntimeStatus,
  type SessionRuntimeStatusPatch
};

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
 * Both projections at once, in the sidebar's own order. The session list renders
 * instance state next to every session, and they come from the same row —
 * reading them as a pair is what keeps that list a single query.
 *
 * The order is the one the sidebar draws — pinned first, then most recently
 * touched — because `limit` cuts the list here, and a limit applied to a
 * different order would drop exactly the rows the sidebar wanted at the top: an
 * old session answered a minute ago, or a pinned one from last month. Ordering
 * and paging have to be the same question, so the client sorts what it gets and
 * never reorders across a page boundary.
 *
 * Ordering on expressions gives up `idx_sessions_created_at`, so this is a scan
 * and a sort. That is the cheap half: the route calibrates runtime status per
 * row it returns, and not paying that for a whole history is what the limit is
 * for.
 */
export async function listRegistry(
  env: Env,
  limit?: number
): Promise<RegistryEntry[]> {
  const query = db(env)
    .select()
    .from(sessions)
    .orderBy(
      pinnedFirst,
      desc(sessionActivityAt),
      desc(sessions.createdAt),
      desc(sessions.id)
    );
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map((row) => ({
    session: rowToSession(row),
    instance: rowToInstance(row)
  }));
}

async function listRows(env: Env): Promise<SessionRow[]> {
  return db(env).select().from(sessions).orderBy(desc(sessions.createdAt));
}

async function getRow(env: Env, id: string): Promise<SessionRow | undefined> {
  const [row] = await db(env)
    .select()
    .from(sessions)
    .where(eq(sessions.id, id))
    .limit(1);
  return row;
}

/**
 * Everything a new session is, before any of it is durable.
 *
 * The session id is the instance id: one session always owns exactly one
 * container. Nothing here touches storage — creating a session is one write, to
 * the session's SessionAgent, and the agent replays this shape into the
 * registry and the Sandbox from its own alarm (see `insertSessionRow`).
 */
export interface NewSession {
  record: SessionRecord;
  /** The instance's display name, minted with the id and pinned on the row. */
  name: string;
  /**
   * The catalog entry the Sandbox needs to clone: the whole definition, not
   * just the key, because nothing downstream can look one up. Absent for a
   * session that works in `/workspace` without a checkout.
   */
  repo?: RepoDefinition;
}

/**
 * Mint a session, with the opening prompt already counted as pending.
 *
 * Pure: the caller hands the result to the SessionAgent, which is where a
 * session first becomes durable. That is what keeps creation to a single write
 * — a request that dies halfway through can leave a session unqueued, but never
 * a half-created one.
 */
export function buildNewSession(
  input: {
    /** Absent for a session that works in `/workspace` without a checkout. */
    repo?: RepoDefinition;
    /** Which sandbox host runs the container; absent means Cloudflare. */
    provider?: SessionProvider;
    model: string;
    variant?: string;
    title: string;
  },
  // Loaded by the route that already validated the request against it, so the
  // same catalog answers both checks.
  catalog: ModelCatalog,
  now = new Date().toISOString()
): NewSession {
  if (input.repo !== undefined && !isSafeRepoDefinition(input.repo)) {
    throw new Error('Unknown repository');
  }
  if (!catalog.isModelRef(input.model)) {
    throw new Error(`Unknown model: ${String(input.model)}`);
  }

  const id = `inst-${crypto.randomUUID()}`;
  return {
    name: randomInstanceName(),
    ...(input.repo ? { repo: input.repo } : {}),
    record: {
      id,
      instanceId: id,
      ...(input.repo ? { repoKey: input.repo.repoKey } : {}),
      // Pinned with the instance, so nothing this session does later depends on
      // the catalog still containing the repository it started from.
      directory: workspaceDirectory(input.repo?.repoKey),
      provider: input.provider ?? 'cloudflare',
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      title: input.title,
      phase: 'queued',
      pendingPromptCount: 1,
      // About to dispatch: the list must calibrate until idle/sleeping.
      statusQuery: true,
      createdAt: now,
      updatedAt: now
    }
  };
}

/**
 * Put a session in the registry, so the list and every id-addressed route can
 * find it.
 *
 * The SessionAgent owns this call and makes it before its first dispatch step,
 * because the row is what its own state reports mirror into. It is idempotent —
 * the agent's alarm and a read that arrives before the alarm can both make it,
 * and either may be a retry after a partial failure — so an existing row is
 * left exactly as it is rather than reset to these creation values.
 */
export async function insertSessionRow(
  env: Env,
  session: NewSession
): Promise<void> {
  const { record, repo } = session;
  await db(env)
    .insert(sessions)
    .values({
      id: record.id,
      name: session.name,
      // The column is NOT NULL, so "no repository" is the empty key; the row
      // projection turns it back into an absent field.
      repoKey: repo?.repoKey ?? '',
      repoJson: repo ? JSON.stringify(repo) : null,
      provider: record.provider,
      lifecycle: 'ready',
      directory: record.directory ?? workspaceDirectory(record.repoKey),
      model: record.model,
      variant: record.variant ?? null,
      title: record.title,
      phase: record.phase,
      pendingPromptCount: record.pendingPromptCount,
      createdAt: record.createdAt,
      updatedAt: record.createdAt
    })
    // An existing row is left exactly as it is: this call is a replay, not a
    // reset to creation values.
    .onConflictDoNothing({ target: sessions.id });
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
  const [row] = await db(env)
    .update(sessions)
    .set(sessionPatchAssignments(patch, new Date().toISOString()))
    .where(eq(sessions.id, id))
    .returning();
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
  const [row] = await db(env)
    .update(sessions)
    .set({ title, titleLocked: 1, updatedAt: new Date().toISOString() })
    .where(eq(sessions.id, id))
    .returning();
  return row ? rowToSession(row) : undefined;
}

/**
 * Mark a session unread: the agent stopped or asked something while nobody
 * was necessarily watching.
 *
 * COALESCE keeps the earliest unread moment through a burst of stop events,
 * which is also what lets `markSessionRead` compare-and-clear against the
 * value the client saw. Deliberately does not touch `updated_at`: an unread
 * marker is not activity, and bumping it would reorder the list and reset the
 * cleanup clock.
 */
export async function markSessionUnread(
  env: Env,
  id: string,
  at = new Date().toISOString()
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({ unreadAt: sql`COALESCE(${sessions.unreadAt}, ${at})` })
    .where(eq(sessions.id, id));
}

/**
 * Clear the unread marker the client saw.
 *
 * The compare-and-clear means a marker set after the client's snapshot
 * survives: the client clears exactly what it read, never a newer one. The
 * session page re-marks on its next poll, so nothing sticks while the user is
 * actually looking. Like `markSessionUnread`, never touches `updated_at`.
 */
export async function markSessionRead(
  env: Env,
  id: string,
  seenAt: string
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({ unreadAt: null })
    .where(and(eq(sessions.id, id), eq(sessions.unreadAt, seenAt)));
}

/**
 * Drop the unread marker unconditionally. For writes that prove the user is
 * looking at the session — sending a prompt, answering a question.
 */
export async function clearSessionUnread(env: Env, id: string): Promise<void> {
  await db(env)
    .update(sessions)
    .set({ unreadAt: null })
    .where(eq(sessions.id, id));
}

/**
 * Pin a session to the top of the sidebar, or unpin it.
 *
 * COALESCE keeps the first pinned moment through redundant pin presses; the
 * value only matters as a "when was it pinned" marker, and the sidebar sorts
 * pinned sessions by activity like every other group. Like the unread marker,
 * deliberately does not touch `updated_at`: pinning is not activity, and
 * bumping it would reorder the recency list and reset the cleanup clock.
 */
export async function setSessionPinned(
  env: Env,
  id: string,
  pinned: boolean
): Promise<SessionRecord | undefined> {
  const [row] = await db(env)
    .update(sessions)
    .set({
      pinnedAt: pinned
        ? sql`COALESCE(${sessions.pinnedAt}, ${new Date().toISOString()})`
        : null
    })
    .where(eq(sessions.id, id))
    .returning();
  return row ? rowToSession(row) : undefined;
}

/**
 * Advance (or, with `null`, clear) the transient wake step the boot screen
 * words itself with. Presentation only, so like the unread marker it never
 * touches `updated_at` — and a write that fails must never fail a wake, which
 * is the caller's job to guarantee.
 */
export async function setSessionBootStep(
  env: Env,
  id: string,
  step: BootStep | null
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({ bootStep: step })
    .where(eq(sessions.id, id));
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
  const [row] = await db(env)
    .update(sessions)
    .set({
      lifecycle: 'deleting',
      deleteOperationId: crypto.randomUUID(),
      lifecycleError: null,
      updatedAt: new Date().toISOString()
    })
    .where(
      and(
        eq(sessions.id, id),
        // The claim fails when an operation is already in flight, and the
        // caller falls through to reading that operation instead of starting
        // a second one.
        not(
          and(
            eq(sessions.lifecycle, 'deleting'),
            isNotNull(sessions.deleteOperationId)
          )!
        )
      )
    )
    .returning();
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
  const [row] = await db(env)
    .select()
    .from(sessions)
    .where(claimedFor('deleting'))
    .orderBy(sessions.updatedAt)
    .limit(1);
  return row ? rowToInstance(row) : undefined;
}

export async function hasPendingDeletion(env: Env): Promise<boolean> {
  const [row] = await db(env)
    .select({ id: sessions.id })
    .from(sessions)
    .where(claimedFor('deleting'))
    .limit(1);
  return row !== undefined;
}

/** A row claimed by a live operation of this lifecycle — the queue's shape. */
function claimedFor(lifecycle: 'deleting' | 'cleaning') {
  return and(
    eq(sessions.lifecycle, lifecycle),
    isNotNull(sessions.deleteOperationId)
  );
}

/** Every write that ends an attempt is fenced on the operation that claimed it. */
function fencedOn(id: string, operationId: string) {
  return and(
    eq(sessions.id, id),
    eq(sessions.deleteOperationId, operationId)
  );
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
  await db(env)
    .update(sessions)
    .set({
      lifecycle: 'delete_failed',
      lifecycleError: error,
      updatedAt: new Date().toISOString()
    })
    .where(fencedOn(id, operationId));
}

export async function deferDelete(
  env: Env,
  id: string,
  operationId: string,
  message: string
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({
      lifecycleError: `${message}; retry scheduled`,
      updatedAt: new Date().toISOString()
    })
    .where(fencedOn(id, operationId));
}

export async function finishDelete(
  env: Env,
  id: string,
  operationId: string
): Promise<void> {
  // A session and its instance share one row, so deletion is one statement.
  await db(env).delete(sessions).where(fencedOn(id, operationId));
}

/**
 * Queue every session idle past the cleanup cutoff and wake the Hub alarm.
 *
 * Cleanup is deletion's quieter sibling: the container and its snapshots go,
 * the row and the transcript mirror stay, so the conversation remains readable.
 * Each claim is a compare-and-swap that re-checks eligibility, so a prompt
 * landing between the scan and the claim keeps its session. Neither the claim
 * nor its completion touches `updated_at` — cleanup is not activity, and
 * bumping it would resurface a long-idle session at the top of the list.
 */
export async function sweepIdleSessions(
  env: Env,
  now = new Date()
): Promise<number> {
  const cutoff = cleanupCutoff(now);
  const candidates = await db(env)
    .select({ id: sessions.id })
    .from(sessions)
    .where(cleanupEligible(cutoff));

  let claimed = 0;
  for (const { id } of candidates) {
    // The same predicate again, as a compare-and-swap: a prompt landing
    // between the scan and this claim keeps its session.
    const [row] = await db(env)
      .update(sessions)
      .set({
        lifecycle: 'cleaning',
        deleteOperationId: crypto.randomUUID(),
        lifecycleError: null
      })
      .where(and(eq(sessions.id, id), cleanupEligible(cutoff)))
      .returning({ id: sessions.id });
    if (!row) {
      continue;
    }
    claimed += 1;
    // Same as beginDelete: close admission and cancel wakes before the Hub
    // alarm gets to the container. Idempotent, so a re-sweep is harmless.
    await resolveLifecycle(env, id).beginDelete();
  }
  if (claimed > 0) {
    await env.Hub.getByName(HUB_DURABLE_OBJECT_ID).poke();
  }
  return claimed;
}

/**
 * What makes a session eligible to be cleaned: nothing is in flight, nothing is
 * queued, neither the row nor its last prompt has been touched since the
 * cutoff, and the runtime has settled — a dispatch phase alone says nothing,
 * because `phase` stays `working` from the moment the last prompt was handed
 * over until the next one arrives. A row whose runtime was never observed is
 * left alone rather than guessed about. `cleaned` is absent from the lifecycles
 * on purpose — a session whose container is already gone is never swept again —
 * while `clean_failed` is present, so a failed attempt is retried on the next
 * sweep.
 *
 * `error` is settled too. It is the cache of `error_running`, which the policy
 * reaches whenever it cannot reach OpenCode, and leaving it out is what let
 * unreachable containers accumulate: the coordinator fails open by design and
 * this sweep was the only other thing that could have reclaimed them. The
 * policy now stops such a container itself after an hour, so a row still in
 * `error` three days later is one whose stop never took — precisely the row a
 * sweep should claim.
 */
function cleanupEligible(cutoff: string) {
  return and(
    inArray(sessions.lifecycle, ['ready', 'clean_failed']),
    eq(sessions.pendingPromptCount, 0),
    notInArray(sessions.phase, ['queued', 'starting']),
    lt(sessions.updatedAt, cutoff),
    or(isNull(sessions.lastPromptAt), lt(sessions.lastPromptAt, cutoff)),
    inArray(sessions.runtimeLifecycle, ['idle', 'sleeping', 'error'])
  );
}

/** The oldest queued cleanup, which the Hub alarm works on after deletions. */
export async function nextPendingCleanup(
  env: Env
): Promise<InstanceRecord | undefined> {
  const [row] = await db(env)
    .select()
    .from(sessions)
    .where(claimedFor('cleaning'))
    .orderBy(sessions.updatedAt)
    .limit(1);
  return row ? rowToInstance(row) : undefined;
}

export async function hasPendingCleanup(env: Env): Promise<boolean> {
  const [row] = await db(env)
    .select({ id: sessions.id })
    .from(sessions)
    .where(claimedFor('cleaning'))
    .limit(1);
  return row !== undefined;
}

/** Fenced like finishDelete, but the row is kept and marked rather than gone. */
export async function finishClean(
  env: Env,
  id: string,
  operationId: string
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({
      lifecycle: 'cleaned',
      deleteOperationId: null,
      lifecycleError: null,
      cleanedAt: new Date().toISOString()
    })
    .where(fencedOn(id, operationId));
}

export async function markCleanFailed(
  env: Env,
  id: string,
  operationId: string,
  error: string
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({ lifecycle: 'clean_failed', lifecycleError: error })
    .where(fencedOn(id, operationId));
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

/** The model and effort attached to the session worked in most recently. */
export async function lastModelSelection(
  env: Env
): Promise<ModelSelection | undefined> {
  const [row] = await db(env)
    .select({ model: sessions.model, variant: sessions.variant })
    .from(sessions)
    // A prompt counts as use, not only creation, so going back to an old
    // session makes its selection the current one. The trailing keys only
    // break ties deterministically.
    .orderBy(desc(lastActivityAt), desc(sessions.createdAt), desc(sessions.id))
    .limit(1);
  return row
    ? { model: row.model, ...(row.variant ? { variant: row.variant } : {}) }
    : undefined;
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
  const rows = await db(env)
    .select({ repoJson: sessions.repoJson })
    .from(sessions)
    .where(isNotNull(sessions.repoJson));
  return rows
    .map((row) => parseRepoJson(row.repoJson))
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
  const rows = await db(env)
    .select({
      repoKey: sessions.repoKey,
      lastUsed: max(lastActivityAt)
    })
    .from(sessions)
    // The empty key is "no repository", which is not a repository to order.
    .where(ne(sessions.repoKey, ''))
    .groupBy(sessions.repoKey);
  return new Map(
    rows
      .filter((row): row is { repoKey: string; lastUsed: string } =>
        row.lastUsed !== null
      )
      .map((row) => [row.repoKey, row.lastUsed])
  );
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
