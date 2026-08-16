-- Prebuilds are gone.
--
-- The feature was a warm per-repo workspace new sessions were seeded from: a
-- settings tab, a Durable Object running the builds, a pair of host routes and
-- a volume on each Docker box. It bought a faster first wake and cost a second
-- copy of the whole wake path — seed, sanitize, wipe-and-fall-back — plus two
-- tables of its own. Removing it leaves the ordinary clone, which every
-- session already fell back to.
--
-- The volumes on the Docker boxes are not this migration's business: no agent
-- route reads them any more, and `docker volume rm` on the `oc-prebuild-*`
-- names is the operator's one-off cleanup.
--
-- `sessions.boot_step` stays: 'cloning' is still a step a wake reports, and the
-- boot screen still words itself with it. `workspace_origin` goes, because with
-- the seed path gone it can only ever say 'clone' — a detail line that reads
-- back the one thing that could have happened is not information.
DROP INDEX IF EXISTS idx_prebuild_runs_repo;
DROP TABLE IF EXISTS prebuild_runs;
DROP TABLE IF EXISTS prebuilds;

ALTER TABLE sessions DROP COLUMN workspace_origin;
