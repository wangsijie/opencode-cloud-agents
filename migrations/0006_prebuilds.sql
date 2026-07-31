-- Per-repo prebuilds: a warm workspace (checkout + node_modules + package
-- caches) new sessions of the same repository are seeded from, instead of
-- starting on an empty volume. See docs/prebuild-design.md.
--
-- One registry row per (repo, provider). `location` is provider-shaped: the
-- Docker agent's prebuild volume is authoritative on its own box, so the row
-- there is observability plus the timestamp the UI shows; the Cloudflare row
-- (phase 2) will carry the promoted snapshot handle and be load-bearing.
CREATE TABLE prebuilds (
  repo_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- Provider-shaped pointer: volume name for docker, R2 handle JSON later.
  location TEXT NOT NULL,
  -- Bytes of the promoted generation, measured at promote time.
  size_bytes INTEGER,
  -- What produced it: 'run' now, 'session' once automatic promotion lands.
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_key, provider)
);

-- One row per dedicated prebuild run, kept as history for debugging; the UI
-- reads only the latest per repo. `timings` is JSON ({cloneMs, installMs,
-- promoteMs, ...} as stages complete), `log_tail` the last install output.
CREATE TABLE prebuild_runs (
  id TEXT PRIMARY KEY,
  repo_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- 'running' | 'succeeded' | 'failed'; free-form like sessions.provider.
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  timings TEXT,
  error TEXT,
  log_tail TEXT
);

CREATE INDEX idx_prebuild_runs_repo ON prebuild_runs (repo_key, started_at);

-- Which wake path materialized this session's workspace: 'clone', 'prebuild'
-- or 'snapshot'. Presentation only — nothing branches on it. NULL for
-- sessions whose workspace predates the column.
ALTER TABLE sessions ADD COLUMN workspace_origin TEXT;

-- Transient wake progress ('seeding', 'cloning', ...) the boot screen words
-- itself with; cleared when the wake completes. Presentation only.
ALTER TABLE sessions ADD COLUMN boot_step TEXT;
