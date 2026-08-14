/**
 * The D1 half of per-repo prebuilds: the registry the UI lists and the run
 * history behind it. See docs/prebuild-design.md.
 *
 * The registry row is observability for the Docker provider — the agent's
 * volume is authoritative on its own box, and seeding works off the volume
 * whether or not this table agrees. It exists so the page can answer "which
 * repos have one, how old, how big" without a round trip to the agent, and so
 * phase 2 has a place to keep the Cloudflare handle that *will* be
 * load-bearing.
 *
 * Pure D1 reads and writes; the machinery that produces prebuilds lives in
 * [prebuild-runner.ts](prebuild-runner.ts).
 */
import { and, desc, eq } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import type { SessionProvider } from '../protocol/types.ts';
import { db, prebuildRuns, prebuilds } from './db/index.ts';

export interface PrebuildRecord {
  repoKey: string;
  provider: SessionProvider;
  /** Provider-shaped pointer: the volume name for docker. */
  location: string;
  sizeBytes?: number;
  /** What produced it: 'run' now, 'session' once automatic promotion lands. */
  source: string;
  updatedAt: string;
}

export type PrebuildRunStatus = 'running' | 'succeeded' | 'failed';

/** Stage durations, written as each stage completes. */
export interface PrebuildRunTimings {
  /** Clone (or seed-refresh) of the checkout. */
  cloneMs?: number;
  installMs?: number;
  promoteMs?: number;
  totalMs?: number;
}

export interface PrebuildRunRecord {
  id: string;
  repoKey: string;
  provider: SessionProvider;
  status: PrebuildRunStatus;
  startedAt: string;
  finishedAt?: string;
  timings?: PrebuildRunTimings;
  error?: string;
  /** Last lines of the install log, refreshed while the run is live. */
  logTail?: string;
}

/** A `prebuilds` row as Drizzle selects it. */
type PrebuildRow = typeof prebuilds.$inferSelect;

/** A `prebuild_runs` row as Drizzle selects it. */
type PrebuildRunRow = typeof prebuildRuns.$inferSelect;

export async function listPrebuildRecords(env: Env): Promise<PrebuildRecord[]> {
  const rows = await db(env)
    .select()
    .from(prebuilds)
    .orderBy(prebuilds.repoKey);
  return rows.map(rowToPrebuild);
}

export async function upsertPrebuildRecord(
  env: Env,
  record: PrebuildRecord
): Promise<void> {
  const row = {
    repoKey: record.repoKey,
    provider: record.provider,
    location: record.location,
    sizeBytes: record.sizeBytes ?? null,
    source: record.source,
    updatedAt: record.updatedAt
  };
  await db(env)
    .insert(prebuilds)
    .values(row)
    // The key is the pair, so the same repository under another provider is a
    // different row rather than a conflict.
    .onConflictDoUpdate({
      target: [prebuilds.repoKey, prebuilds.provider],
      set: {
        location: row.location,
        sizeBytes: row.sizeBytes,
        source: row.source,
        updatedAt: row.updatedAt
      }
    });
}

export async function deletePrebuildRecord(
  env: Env,
  repoKey: string,
  provider: SessionProvider
): Promise<void> {
  await db(env)
    .delete(prebuilds)
    .where(
      and(eq(prebuilds.repoKey, repoKey), eq(prebuilds.provider, provider))
    );
}

/**
 * Forget a repo's run history on one host.
 *
 * Deleting a prebuild is how a repository leaves the settings list, and the
 * list is drawn from the registry *plus* any repo whose latest run has not
 * succeeded — so a failed attempt that produced nothing would sit there
 * permanently if its runs outlived the delete. Scoped to the provider like the
 * registry row it accompanies: the same repository prebuilt on another host
 * keeps its own history.
 */
export async function deletePrebuildRuns(
  env: Env,
  repoKey: string,
  provider: SessionProvider
): Promise<void> {
  await db(env)
    .delete(prebuildRuns)
    .where(
      and(
        eq(prebuildRuns.repoKey, repoKey),
        eq(prebuildRuns.provider, provider)
      )
    );
}

export async function insertPrebuildRun(
  env: Env,
  run: PrebuildRunRecord
): Promise<void> {
  // Only the opening fields: everything else is filled in by patches as the
  // run progresses.
  await db(env).insert(prebuildRuns).values({
    id: run.id,
    repoKey: run.repoKey,
    provider: run.provider,
    status: run.status,
    startedAt: run.startedAt
  });
}

/** Fields a run patch may touch; absent fields keep their columns. */
export interface PrebuildRunPatch {
  status?: PrebuildRunStatus;
  finishedAt?: string;
  timings?: PrebuildRunTimings;
  error?: string;
  logTail?: string;
}

export async function updatePrebuildRun(
  env: Env,
  id: string,
  patch: PrebuildRunPatch
): Promise<void> {
  // The statement this replaced wrapped every column in COALESCE against its
  // own bind parameter, which is the SQL way of saying "leave out what the
  // patch does not name". Building the assignment list says it directly, and
  // means an empty patch writes nothing at all rather than rewriting the row
  // with its own values.
  const set: SQLiteUpdateSetSource<typeof prebuildRuns> = {
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
    ...(patch.timings === undefined
      ? {}
      : { timings: JSON.stringify(patch.timings) }),
    ...(patch.error === undefined ? {} : { error: patch.error }),
    ...(patch.logTail === undefined ? {} : { logTail: patch.logTail })
  };
  if (Object.keys(set).length === 0) {
    return;
  }
  await db(env)
    .update(prebuildRuns)
    .set(set)
    .where(eq(prebuildRuns.id, id));
}

/**
 * How a (host, repository) pair is addressed wherever the two have to travel
 * as one string: the run map below, the JSON object the API serves it as, and
 * the PrebuildRunner Durable Object's name. Both halves are `[a-z0-9-]` (plus
 * the provider's own colon), so the slash never appears inside either.
 */
export function prebuildKey(
  provider: SessionProvider,
  repoKey: string
): string {
  return `${provider}/${repoKey}`;
}

/**
 * The newest run per repo *per host* — the only history the page shows. One
 * query, newest-first, first row per pair wins.
 */
export async function latestPrebuildRuns(
  env: Env
): Promise<Map<string, PrebuildRunRecord>> {
  const rows = await db(env)
    .select()
    .from(prebuildRuns)
    .orderBy(desc(prebuildRuns.startedAt));
  const latest = new Map<string, PrebuildRunRecord>();
  for (const row of rows) {
    const key = prebuildKey(row.provider as SessionProvider, row.repoKey);
    if (!latest.has(key)) {
      latest.set(key, rowToRun(row));
    }
  }
  return latest;
}

function rowToPrebuild(row: PrebuildRow): PrebuildRecord {
  return {
    repoKey: row.repoKey,
    provider: row.provider as SessionProvider,
    location: row.location,
    ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
    source: row.source,
    updatedAt: row.updatedAt
  };
}

function rowToRun(row: PrebuildRunRow): PrebuildRunRecord {
  return {
    id: row.id,
    repoKey: row.repoKey,
    provider: row.provider as SessionProvider,
    status: row.status as PrebuildRunStatus,
    startedAt: row.startedAt,
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt }),
    ...(row.timings === null ? {} : { timings: parseTimings(row.timings) }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.logTail === null ? {} : { logTail: row.logTail })
  };
}

function parseTimings(value: string): PrebuildRunTimings {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PrebuildRunTimings)
      : {};
  } catch {
    return {};
  }
}
