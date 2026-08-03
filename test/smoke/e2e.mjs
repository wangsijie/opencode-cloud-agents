/**
 * End-to-end smoke test against a running `wrangler dev`.
 *
 * The unit suite runs the store modules against `node:sqlite`, which is the
 * same SQL engine but not the same driver: Drizzle's D1 driver, the real
 * `D1Database` binding and the workerd runtime are all outside it. Every bug
 * this refactor could plausibly introduce that the unit tests would miss lives
 * in that gap — a statement D1 rejects but SQLite accepts, a bind parameter
 * shape only the real driver cares about, a `RETURNING` that comes back
 * differently.
 *
 * So this drives the deployed HTTP surface instead: sign in, write settings,
 * read them back, exercise the queries the session list and the settings page
 * issue, and confirm the rows the API reports are the rows in the database.
 *
 * Not part of `pnpm test` — it needs a server. Run it with:
 *
 *   pnpm run build:web
 *   wrangler d1 migrations apply opencode-cloud --local
 *   wrangler dev --port 8787          # in another shell
 *   node test/smoke/e2e.mjs
 */
import assert from 'node:assert/strict';

const BASE = process.env.SMOKE_BASE_URL ?? 'http://localhost:8787';
const PASSWORD = 'smoke-test-password';

let cookie = '';
let passed = 0;

async function api(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie.split(';')[0];
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    console.error(error);
    process.exitCode = 1;
    throw error;
  }
}

console.log(`smoke test against ${BASE}\n`);

// The suite is written to run twice against the same database, so a repeat run
// after a failure does not need the state wiped first.
await step('the API is reachable and closed to anyone without a password', async () => {
  const auth = await api('/api/auth');
  assert.equal(auth.status, 200);
  assert.equal(typeof auth.body.authenticated, 'boolean');

  const closed = await api('/api/settings');
  assert.equal(closed.status, 401, 'settings must be closed before sign-in');
});

await step('setup or sign-in issues a session cookie', async () => {
  const auth = await api('/api/auth');
  if (!auth.body.passwordConfigured) {
    const setup = await api('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
  } else {
    const signIn = await api('/api/auth', {
      method: 'POST',
      body: JSON.stringify({ password: PASSWORD })
    });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  }
  assert.ok(cookie, 'no session cookie was issued');

  // The cookie is what the admin_sessions row grants: this read proves the
  // token hash was stored and matched back.
  const check = await api('/api/auth');
  assert.equal(check.body.authenticated, true);
});

await step('the settings list reads back through Drizzle', async () => {
  const { status, body } = await api('/api/settings');
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body.settings));
  assert.ok(body.settings.length > 0);
  for (const entry of body.settings) {
    assert.equal(typeof entry.key, 'string');
    assert.equal(typeof entry.configured, 'boolean');
  }
});

await step('a setting round trips: upsert, read, overwrite, delete', async () => {
  const key = 'docker.image';
  const put = async (value) =>
    api(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value })
    });
  const read = async () => {
    const { body } = await api('/api/settings');
    return body.settings.find((entry) => entry.key === key);
  };

  const first = await put('smoke-image:v1');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  let entry = await read();
  assert.equal(entry.configured, true);
  assert.equal(entry.value, 'smoke-image:v1');
  const firstUpdatedAt = entry.updatedAt;
  assert.ok(firstUpdatedAt);

  // The ON CONFLICT path: the same key must be replaced, never duplicated.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await put('smoke-image:v2');
  assert.equal(second.status, 200);
  entry = await read();
  assert.equal(entry.value, 'smoke-image:v2');
  assert.ok(entry.updatedAt >= firstUpdatedAt, 'the upsert must move updated_at');

  const cleared = await put(null);
  assert.equal(cleared.status, 200);
  entry = await read();
  assert.equal(entry.configured, false);
  assert.ok(!('value' in entry));
});

await step('a required setting refuses to be cleared', async () => {
  const { status } = await api(
    `/api/settings/${encodeURIComponent('github.token')}`,
    { method: 'PUT', body: JSON.stringify({ value: null }) }
  );
  assert.equal(status, 400);
});

await step('an unknown setting key is refused', async () => {
  const { status } = await api('/api/settings/not.a.real.setting', {
    method: 'PUT',
    body: JSON.stringify({ value: 'x' })
  });
  assert.equal(status, 404);
});

await step('the OpenCode config is validated and stored', async () => {
  const config = {
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      doom_loop: 'allow',
      external_directory: 'allow',
      task: 'allow'
    },
    model: 'anthropic/claude-smoke',
    provider: {
      anthropic: {
        apiKey: 'sk-smoke',
        models: {
          'claude-smoke': {
            modalities: { input: ['text', 'image'] },
            attachment: true
          }
        }
      }
    }
  };
  const { status, body } = await api(
    `/api/settings/${encodeURIComponent('opencode.config')}`,
    { method: 'PUT', body: JSON.stringify({ value: config }) }
  );
  assert.equal(status, 200, JSON.stringify(body));

  // A config missing a permission key is refused: the validation gate is in
  // front of the same write path.
  const broken = await api(
    `/api/settings/${encodeURIComponent('opencode.config')}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        value: { ...config, permission: { edit: 'allow' } }
      })
    }
  );
  assert.equal(broken.status, 400);
});

await step('the session list is served (the SELECT * ORDER BY path)', async () => {
  const { status, body } = await api('/api/sessions');
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body), JSON.stringify(body));

  // Newest first, by created_at — the ordering the list depends on.
  const created = body.map((session) => session.createdAt);
  const sorted = [...created].sort().reverse();
  assert.deepEqual(created, sorted, 'sessions must come back newest first');
});

await step('the instance list is served from the same rows', async () => {
  const { status, body } = await api('/api/instances');
  assert.equal(status, 200, JSON.stringify(body));
  assert.ok(Array.isArray(body), JSON.stringify(body));
});

await step('a session id that does not exist is a clean 404', async () => {
  const { status } = await api('/api/sessions/inst-does-not-exist');
  assert.equal(status, 404);
});

// The rest of the session queries — the INSERT, the conditional UPDATE, the
// COALESCE writes and the fenced delete claim — only run against a real row, so
// one is created here. No container is ever started: the session is left in
// `queued`, which is enough to exercise every statement.
await step('a session is created, patched and deleted through Drizzle', async () => {
  const created = await api('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'smoke test prompt',
      model: 'anthropic/claude-smoke'
    })
  });
  // 202: the row is written and the agent is queued, nothing has started yet.
  assert.equal(created.status, 202, JSON.stringify(created.body));
  const id = created.body.id;
  assert.match(id, /^inst-/);
  // The INSERT wrote what the record says it did.
  assert.equal(created.body.title, 'smoke test prompt');
  assert.equal(created.body.phase, 'queued');
  assert.equal(created.body.pendingPromptCount, 1);
  assert.equal(created.body.statusQuery, true);
  // No repository was named, so the row carries the empty key and the record
  // reports no `repoKey` at all.
  assert.ok(!('repoKey' in created.body));
  assert.equal(created.body.directory, '/workspace');

  try {
    // The row is readable by id and appears in the list.
    const read = await api(`/api/sessions/${id}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.id, id);

    const list = await api('/api/sessions');
    assert.ok(
      list.body.some((session) => session.id === id),
      'the new session must be in the list'
    );
    // Newest first still holds with a row in the table.
    const created_ats = list.body.map((session) => session.createdAt);
    assert.deepEqual(created_ats, [...created_ats].sort().reverse());

    // A rename is the UPDATE ... RETURNING path, and it takes the title lock.
    const renamed = await api(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'renamed by the smoke test' })
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.title, 'renamed by the smoke test');

    // Pinning is the COALESCE write, and it must not count as activity.
    const before = (await api(`/api/sessions/${id}`)).body;
    const pinned = await api(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned: true })
    });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    assert.ok(pinned.body.pinnedAt, 'pinning must record when');
    assert.equal(
      pinned.body.updatedAt,
      before.updatedAt,
      'pinning must not bump updated_at'
    );

    const unpinned = await api(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned: false })
    });
    assert.equal(unpinned.status, 200);
    assert.ok(!('pinnedAt' in unpinned.body));
  } finally {
    // The fenced delete claim, and the row is gone afterwards.
    const deleted = await api(`/api/sessions/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
    assert.ok(deleted.body.operationId, 'the delete claim must mint an operation');
  }
});

await step('the prebuild registry and run history are served', async () => {
  const { status, body } = await api('/api/prebuilds');
  assert.equal(status, 200, JSON.stringify(body));
  // Both halves come from D1: the registry table and the latest run per repo.
  assert.ok(Array.isArray(body.prebuilds), JSON.stringify(body));
  assert.equal(typeof body.runs, 'object');
});

await step('signing out deletes the row and closes the API again', async () => {
  const out = await api('/api/auth', { method: 'DELETE' });
  assert.equal(out.status, 200);
  assert.equal(out.body.authenticated, false);

  const check = await api('/api/auth');
  assert.equal(check.body.authenticated, false);

  const closed = await api('/api/settings');
  assert.equal(closed.status, 401, 'the API must be closed after sign-out');
});

console.log(`\n${passed} smoke checks passed`);
