-- Which sandbox host runs this session's container. 'cloudflare' is the
-- Cloudflare Containers host every existing session uses; 'docker' is the
-- remote Docker agent. Free-form text rather than a CHECK list so a new
-- provider ships with the code that speaks it, not with a table rebuild.
ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'cloudflare';
