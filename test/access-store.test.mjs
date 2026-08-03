/**
 * `admin_sessions`, against a real database.
 *
 * The security-relevant properties are the ones worth pinning before the query
 * layer is rewritten: only the token *hash* is ever stored, an expired row
 * never authenticates, and sign-out deletes exactly one browser's row.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminSession, handleAuthApi, handleSetupApi } from '../src/access.ts';
import { hashToken } from '../src/password.ts';
import { SETTING_KEYS, readSetting } from '../src/settings.ts';
import { createTestEnv } from './helpers/d1.mjs';

const URL_HTTPS = new URL('https://hub.example.com/api/auth');

/** The token out of a `Set-Cookie` header, as a browser would keep it. */
function cookieToken(header) {
  const [pair] = header.split(';');
  return pair.slice(pair.indexOf('=') + 1);
}

function requestWithToken(token, init = {}) {
  return new Request(URL_HTTPS, {
    ...init,
    headers: { cookie: `hub_admin=${token}`, ...(init.headers ?? {}) }
  });
}

async function countAdminSessions(env) {
  const rows = await env.DB.prepare('SELECT token_hash FROM admin_sessions').all();
  return rows.results.length;
}

test('signing in stores the token hash, never the token', async () => {
  const env = createTestEnv();
  const { cookie } = await createAdminSession(env, URL_HTTPS);
  const token = cookieToken(cookie);

  const rows = await env.DB.prepare(
    'SELECT token_hash, created_at, expires_at FROM admin_sessions'
  ).all();
  assert.equal(rows.results.length, 1);
  const [row] = rows.results;
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, await hashToken(token));
  assert.ok(row.expires_at > row.created_at);
});

test('the cookie is HttpOnly and Secure over HTTPS', async () => {
  const env = createTestEnv();
  const { cookie } = await createAdminSession(env, URL_HTTPS);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);

  const local = await createAdminSession(env, new URL('http://localhost:8787/'));
  assert.doesNotMatch(local.cookie, /Secure/);
});

test('a stored session authenticates and an unknown token does not', async () => {
  const env = createTestEnv();
  const { cookie } = await createAdminSession(env, URL_HTTPS);
  const token = cookieToken(cookie);

  const signedIn = await handleAuthApi(requestWithToken(token), URL_HTTPS, env);
  assert.equal((await signedIn.json()).authenticated, true);

  const stranger = await handleAuthApi(
    requestWithToken('some-other-token'),
    URL_HTTPS,
    env
  );
  assert.equal((await stranger.json()).authenticated, false);

  const anonymous = await handleAuthApi(new Request(URL_HTTPS), URL_HTTPS, env);
  assert.equal((await anonymous.json()).authenticated, false);
});

test('an expired row never authenticates', async () => {
  const env = createTestEnv();
  const token = 'expired-token';
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, created_at, expires_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind(
      await hashToken(token),
      '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z'
    )
    .run();

  const response = await handleAuthApi(requestWithToken(token), URL_HTTPS, env);
  assert.equal((await response.json()).authenticated, false);
});

test('signing in sweeps rows that have already expired', async () => {
  const env = createTestEnv();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, created_at, expires_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind('stale-hash', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z')
    .run();
  // A live row from another browser must survive the sweep.
  await createAdminSession(env, URL_HTTPS);
  await createAdminSession(env, URL_HTTPS);

  const rows = await env.DB.prepare('SELECT token_hash FROM admin_sessions').all();
  assert.equal(rows.results.length, 2);
  assert.ok(!rows.results.some((row) => row.token_hash === 'stale-hash'));
});

test('signing out deletes only this browser row', async () => {
  const env = createTestEnv();
  const mine = cookieToken((await createAdminSession(env, URL_HTTPS)).cookie);
  const theirs = cookieToken((await createAdminSession(env, URL_HTTPS)).cookie);
  assert.equal(await countAdminSessions(env), 2);

  const response = await handleAuthApi(
    requestWithToken(mine, { method: 'DELETE' }),
    URL_HTTPS,
    env
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authenticated, false);
  assert.equal(await countAdminSessions(env), 1);

  const still = await handleAuthApi(requestWithToken(theirs), URL_HTTPS, env);
  assert.equal((await still.json()).authenticated, true);
});

test('setup stores a password record and signs the browser in', async () => {
  const env = createTestEnv();
  const auth = await handleAuthApi(new Request(URL_HTTPS), URL_HTTPS, env);
  assert.deepEqual(await auth.json(), {
    authenticated: false,
    passwordConfigured: false
  });

  const response = await handleSetupApi(
    new Request(URL_HTTPS, {
      method: 'POST',
      body: JSON.stringify({ password: 'correct horse battery' })
    }),
    URL_HTTPS,
    env
  );
  assert.equal(response.status, 200);

  const record = await readSetting(env, SETTING_KEYS.adminPassword);
  assert.equal(record.algorithm, 'pbkdf2-sha256');
  assert.ok(record.salt);
  assert.ok(record.hash);
  assert.equal(await countAdminSessions(env), 1);

  // The second setup attempt is refused forever.
  const again = await handleSetupApi(
    new Request(URL_HTTPS, {
      method: 'POST',
      body: JSON.stringify({ password: 'another password' })
    }),
    URL_HTTPS,
    env
  );
  assert.equal(again.status, 409);
});

test('the password gate accepts the password and refuses anything else', async () => {
  const env = createTestEnv();
  await handleSetupApi(
    new Request(URL_HTTPS, {
      method: 'POST',
      body: JSON.stringify({ password: 'correct horse battery' })
    }),
    URL_HTTPS,
    env
  );

  const wrong = await handleAuthApi(
    new Request(URL_HTTPS, {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong' })
    }),
    URL_HTTPS,
    env
  );
  assert.equal(wrong.status, 401);

  const right = await handleAuthApi(
    new Request(URL_HTTPS, {
      method: 'POST',
      body: JSON.stringify({ password: 'correct horse battery' })
    }),
    URL_HTTPS,
    env
  );
  assert.equal(right.status, 200);
  const token = cookieToken(right.headers.get('set-cookie'));
  const check = await handleAuthApi(requestWithToken(token), URL_HTTPS, env);
  assert.equal((await check.json()).authenticated, true);
});
