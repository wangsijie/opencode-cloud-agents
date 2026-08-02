-- Browser sessions for the admin password, one row per signed-in browser.
--
-- The cookie carries the raw token; only its SHA-256 is stored, so reading
-- this table does not grant access. Revoking a browser is deleting its row,
-- and changing the password clears the table.
CREATE TABLE admin_sessions (
  token_hash   TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions (expires_at);
