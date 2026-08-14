-- One Docker sandbox host became several.
--
-- The four flat `docker.*` settings described exactly one box: its URL, its
-- token, its image, its idle window. A deployment with two boxes has nothing
-- to say in that shape, so they collapse into one `docker.hosts` list and a
-- session's provider names which entry it runs on (`docker:<id>`).
--
-- The old rows become the entry with id `default`, which is what bare
-- `docker` — the provider every session created before this resolves to.
-- Renaming that id later would orphan those sessions.
--
-- Nothing is inserted when the URL and the token are not both stored: a
-- half-configured provider was never usable, and carrying it forward would
-- only produce a host that 401s.
INSERT INTO settings (key, value, updated_at)
SELECT
  'docker.hosts',
  json_array(
    -- json_patch drops the keys whose value is NULL, so an image or a timeout
    -- that was never set stays absent rather than arriving as null.
    json_patch(
      json_object(
        'id', 'default',
        'label', 'Docker',
        'baseUrl', json_extract(url.value, '$'),
        'token', json_extract(token.value, '$')
      ),
      json_object(
        'image', (SELECT json_extract(value, '$') FROM settings WHERE key = 'docker.image'),
        'idleTimeoutMinutes', (SELECT json_extract(value, '$') FROM settings WHERE key = 'docker.idle-timeout-minutes')
      )
    )
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM settings AS url
JOIN settings AS token ON token.key = 'docker.agent-token'
WHERE url.key = 'docker.agent-url'
ON CONFLICT (key) DO NOTHING;

DELETE FROM settings
WHERE key IN (
  'docker.agent-url',
  'docker.agent-token',
  'docker.image',
  'docker.idle-timeout-minutes'
);

-- Prebuild rows are keyed by provider too, and a prebuild is a volume on one
-- box: the rows written before this migration belong to the host it just
-- created. Left as bare 'docker' they would show up under a host that is not
-- in settings — deletable but never rebuildable — so they move with it.
--
-- Session rows deliberately do NOT move. A session's provider is stored in its
-- Sandbox object's identity as well as in D1, and the two are compared on
-- every wake; rewriting one side would refuse to initialize. `resolveDockerHost`
-- reads bare 'docker' as the first configured host, which is this one.
UPDATE prebuilds SET provider = 'docker:default'
WHERE provider = 'docker'
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'docker.hosts');

UPDATE prebuild_runs SET provider = 'docker:default'
WHERE provider = 'docker'
  AND EXISTS (SELECT 1 FROM settings WHERE key = 'docker.hosts');
