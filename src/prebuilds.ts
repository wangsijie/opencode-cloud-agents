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
import type { SessionProvider } from '../protocol/types.ts';

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

interface PrebuildRow {
  repo_key: string;
  provider: string;
  location: string;
  size_bytes: number | null;
  source: string;
  updated_at: string;
}

interface PrebuildRunRow {
  id: string;
  repo_key: string;
  provider: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  timings: string | null;
  error: string | null;
  log_tail: string | null;
}

export async function listPrebuildRecords(env: Env): Promise<PrebuildRecord[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM prebuilds ORDER BY repo_key'
  ).all<PrebuildRow>();
  return (rows.results ?? []).map(rowToPrebuild);
}

export async function upsertPrebuildRecord(
  env: Env,
  record: PrebuildRecord
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prebuilds (repo_key, provider, location, size_bytes, source, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (repo_key, provider) DO UPDATE SET
       location = excluded.location,
       size_bytes = excluded.size_bytes,
       source = excluded.source,
       updated_at = excluded.updated_at`
  )
    .bind(
      record.repoKey,
      record.provider,
      record.location,
      record.sizeBytes ?? null,
      record.source,
      record.updatedAt
    )
    .run();
}

export async function deletePrebuildRecord(
  env: Env,
  repoKey: string,
  provider: SessionProvider
): Promise<void> {
  await env.DB.prepare(
    'DELETE FROM prebuilds WHERE repo_key = ?1 AND provider = ?2'
  )
    .bind(repoKey, provider)
    .run();
}

export async function insertPrebuildRun(
  env: Env,
  run: PrebuildRunRecord
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO prebuild_runs (id, repo_key, provider, status, started_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(run.id, run.repoKey, run.provider, run.status, run.startedAt)
    .run();
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
  await env.DB.prepare(
    `UPDATE prebuild_runs SET
       status = COALESCE(?2, status),
       finished_at = COALESCE(?3, finished_at),
       timings = COALESCE(?4, timings),
       error = COALESCE(?5, error),
       log_tail = COALESCE(?6, log_tail)
     WHERE id = ?1`
  )
    .bind(
      id,
      patch.status ?? null,
      patch.finishedAt ?? null,
      patch.timings === undefined ? null : JSON.stringify(patch.timings),
      patch.error ?? null,
      patch.logTail ?? null
    )
    .run();
}

/**
 * The newest run per repo — the only history the page shows. One query,
 * newest-first, first row per repo wins.
 */
export async function latestPrebuildRuns(
  env: Env
): Promise<Map<string, PrebuildRunRecord>> {
  const rows = await env.DB.prepare(
    'SELECT * FROM prebuild_runs ORDER BY started_at DESC'
  ).all<PrebuildRunRow>();
  const latest = new Map<string, PrebuildRunRecord>();
  for (const row of rows.results ?? []) {
    if (!latest.has(row.repo_key)) {
      latest.set(row.repo_key, rowToRun(row));
    }
  }
  return latest;
}

function rowToPrebuild(row: PrebuildRow): PrebuildRecord {
  return {
    repoKey: row.repo_key,
    provider: row.provider as SessionProvider,
    location: row.location,
    ...(row.size_bytes === null ? {} : { sizeBytes: row.size_bytes }),
    source: row.source,
    updatedAt: row.updated_at
  };
}

function rowToRun(row: PrebuildRunRow): PrebuildRunRecord {
  return {
    id: row.id,
    repoKey: row.repo_key,
    provider: row.provider as SessionProvider,
    status: row.status as PrebuildRunStatus,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.timings === null ? {} : { timings: parseTimings(row.timings) }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.log_tail === null ? {} : { logTail: row.log_tail })
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
