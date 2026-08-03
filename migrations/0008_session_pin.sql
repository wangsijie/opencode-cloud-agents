-- When this session was pinned to the top of the sidebar by hand. NULL means
-- not pinned. Stored in D1 rather than the browser so the pin follows the
-- user across devices. ISO-8601 text like every other timestamp; writes
-- deliberately do not touch updated_at, which drives list ordering and the
-- cleanup sweep.
ALTER TABLE sessions ADD COLUMN pinned_at TEXT;
