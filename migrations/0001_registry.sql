-- The session registry, moved out of the Hub Durable Object.
--
-- A session and its instance are 1:1 by design — the session id is the
-- instance id — so both live in one row. Instance-side columns describe the
-- container binding and the deletion state machine; session-side columns
-- describe the conversation. Timestamps are ISO-8601 strings compared
-- lexicographically, as everywhere else in this codebase.
CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  -- instance side
  name                 TEXT NOT NULL,
  repo_key             TEXT NOT NULL,
  -- The pinned RepoDefinition, whole, as JSON. Never queried by sub-field.
  repo_json            TEXT,
  lifecycle            TEXT NOT NULL DEFAULT 'ready'
                         CHECK (lifecycle IN ('ready', 'deleting', 'delete_failed')),
  -- Why deletion failed; unrelated to the session's own last_error.
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
  archived_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_sessions_created_at   ON sessions (created_at DESC);
CREATE INDEX idx_sessions_repo_key     ON sessions (repo_key);
CREATE INDEX idx_sessions_delete_queue ON sessions (lifecycle, updated_at);

-- Singleton values and future configuration (opencode config files, tokens).
-- The GitHub repo catalog cache is the first tenant, under key 'repo-catalog'.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
