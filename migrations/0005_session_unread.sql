-- When this session last produced something the user has not looked at: the
-- agent finished a turn, failed, or parked on a question. NULL means read.
-- Stored in D1 rather than the browser so the marker follows the user across
-- devices. ISO-8601 text like every other timestamp; writes deliberately do
-- not touch updated_at, which drives list ordering and the cleanup sweep.
ALTER TABLE sessions ADD COLUMN unread_at TEXT;
