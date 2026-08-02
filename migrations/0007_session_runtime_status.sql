-- Cached runtime status for the session list.
--
-- The list used to live-query every ready session's Durable Objects and host
-- on every poll. Most rows are sleeping or idle and do not change until a
-- user action or a lifecycle transition, so the interesting fields are
-- mirrored here and a flag says whether the list still needs to ask.
--
-- status_query = 1 means "keep calibrating on list polls"; 0 means the row
-- is stable enough to serve from these columns alone. Writers that can change
-- runtime state (send, retry, abort, wake, …) set the flag; the
-- LifecycleCoordinator clears it when the runtime reaches idle or sleeping.
-- status_observed_at is when the cache was last written; a NULL means the
-- row has never been calibrated and the list must ask once.
--
-- Deliberately does not touch updated_at on cache writes — that column drives
-- list ordering and the cleanup sweep, and a status calibration is not
-- activity.
ALTER TABLE sessions ADD COLUMN runtime_lifecycle TEXT;
ALTER TABLE sessions ADD COLUMN container TEXT;
ALTER TABLE sessions ADD COLUMN status_query INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN status_observed_at TEXT;

-- Hot rows are the ones the list still fans out to; there should not be many.
CREATE INDEX idx_sessions_status_query ON sessions (status_query)
  WHERE status_query = 1;
