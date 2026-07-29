-- Idle sessions get cleaned: the container and its snapshots are removed while
-- the row and the transcript mirror stay, so the conversation remains readable.
-- That adds lifecycle states ('cleaning', 'cleaned', 'clean_failed'), and
-- SQLite cannot alter a CHECK, so the table is rebuilt — this once — without
-- one: like `provider` (0003), a new lifecycle ships with the code that speaks
-- it, not with a table rebuild. The never-referenced `archived_at` column
-- becomes `cleaned_at`, the moment a session's container was cleaned away.
CREATE TABLE sessions_new (
  id                   TEXT PRIMARY KEY,
  -- instance side
  name                 TEXT NOT NULL,
  repo_key             TEXT NOT NULL,
  -- The pinned RepoDefinition, whole, as JSON. Never queried by sub-field.
  repo_json            TEXT,
  lifecycle            TEXT NOT NULL DEFAULT 'ready',
  -- Why deletion or cleanup failed; unrelated to the session's own last_error.
  lifecycle_error      TEXT,
  delete_operation_id  TEXT,
  -- session side
  directory            TEXT,
  model                TEXT NOT NULL,
  variant              TEXT,
  title                TEXT NOT NULL,
  title_locked         INTEGER NOT NULL DEFAULT 0,
  opencode_session_id  TEXT,
  phase                TEXT NOT NULL
                         CHECK (phase IN ('queued', 'starting', 'working', 'failed', 'lost')),
  pending_prompt_count INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  last_prompt_at       TEXT,
  cleaned_at           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  provider             TEXT NOT NULL DEFAULT 'cloudflare'
);
INSERT INTO sessions_new (
  id, name, repo_key, repo_json, lifecycle, lifecycle_error,
  delete_operation_id, directory, model, variant, title, title_locked,
  opencode_session_id, phase, pending_prompt_count, last_error,
  last_prompt_at, cleaned_at, created_at, updated_at, provider
)
SELECT
  id, name, repo_key, repo_json, lifecycle, lifecycle_error,
  delete_operation_id, directory, model, variant, title, title_locked,
  opencode_session_id, phase, pending_prompt_count, last_error,
  last_prompt_at, archived_at, created_at, updated_at, provider
FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_created_at   ON sessions (created_at DESC);
CREATE INDEX idx_sessions_repo_key     ON sessions (repo_key);
-- Also serves the cleanup queue and the idle sweep, which scan the same shape.
CREATE INDEX idx_sessions_delete_queue ON sessions (lifecycle, updated_at);
