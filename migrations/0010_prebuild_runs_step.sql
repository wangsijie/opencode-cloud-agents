-- Stage 1 of durable object diet: move prebuild run execution state
-- from DO storage to prebuild_runs table columns.

ALTER TABLE prebuild_runs ADD COLUMN step TEXT;
ALTER TABLE prebuild_runs ADD COLUMN step_started_at INTEGER;
ALTER TABLE prebuild_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
