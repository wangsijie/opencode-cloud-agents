/**
 * The two database reads the settings API owns, against a real database.
 *
 * Neither lives in a store module, so neither had a test: the `DISTINCT model`
 * scan that refuses to strand a pinned session, and the wipe of every browser
 * session on a password change. Both are behaviours the Drizzle rewrite has to
 * keep.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminSession, handleSetupApi } from '../src/access.ts';
import { handleSettingsApi } from '../src/api-settings.ts';
import { buildNewSession, insertSessionRow } from '../src/hub-store.ts';
import { SETTING_KEYS, readSetting } from '../src/settings.ts';
import { REQUIRED_PERMISSION_KEYS } from '../src/settings-schema.ts';
import { createTestEnv } from './helpers/d1.mjs';

const URL_BASE = 'https://hub.example.com';
const CATALOG = { isModelRef: () => true };

/** A config that passes validation and defines exactly the models named. */
function configWithModels(models) {
  const provider = {};
  for (const ref of models) {
    const [providerID, modelID] = ref.split('/');
    provider[providerID] ??= { apiKey: 'sk-test', models: {} };
    provider[providerID].models[modelID] = {
      modalities: { input: ['text', 'image'] },
      attachment: true
    };
  }
  return {
    permission: Object.fromEntries(
      REQUIRED_PERMISSION_KEYS.map((key) => [key, 'allow'])
    ),
    model: models[0],
    provider
  };
}

async function seedSession(env, model) {
  const session = buildNewSession(
    { model, title: 'Opening prompt' },
    CATALOG
  );
  await insertSessionRow(env, session);
  return session.record.id;
}

async function putSetting(env, key, body) {
  const url = new URL(`${URL_BASE}/api/settings/${encodeURIComponent(key)}`);
  return handleSettingsApi(
    new Request(url, { method: 'PUT', body: JSON.stringify(body) }),
    env,
    url
  );
}

test('a config that still defines every pinned model is stored', async () => {
  const env = createTestEnv();
  await seedSession(env, 'anthropic/claude-fable-5');
  await seedSession(env, 'openai/gpt-example');

  const config = configWithModels([
    'anthropic/claude-fable-5',
    'openai/gpt-example'
  ]);
  const response = await putSetting(env, SETTING_KEYS.opencodeConfig, {
    value: config
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await readSetting(env, SETTING_KEYS.opencodeConfig), config);
});

test('dropping a model a session is pinned to is refused, and named', async () => {
  const env = createTestEnv();
  await seedSession(env, 'anthropic/claude-fable-5');
  await seedSession(env, 'openai/gpt-example');
  // Two sessions on the same model must be reported once, not twice.
  await seedSession(env, 'openai/gpt-example');

  const config = configWithModels(['anthropic/claude-fable-5']);
  const response = await putSetting(env, SETTING_KEYS.opencodeConfig, {
    value: config
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body.pinnedModels, ['openai/gpt-example']);
  // Nothing was stored: the refusal has to be total.
  assert.equal(await readSetting(env, SETTING_KEYS.opencodeConfig), undefined);
});

test('force stores the config anyway', async () => {
  const env = createTestEnv();
  await seedSession(env, 'openai/gpt-example');

  const config = configWithModels(['anthropic/claude-fable-5']);
  const refused = await putSetting(env, SETTING_KEYS.opencodeConfig, {
    value: config
  });
  assert.equal(refused.status, 400);

  const forced = await putSetting(env, SETTING_KEYS.opencodeConfig, {
    value: config,
    force: true
  });
  assert.equal(forced.status, 200);
  assert.deepEqual(await readSetting(env, SETTING_KEYS.opencodeConfig), config);
});

test('with no sessions at all nothing is orphaned', async () => {
  const env = createTestEnv();
  const config = configWithModels(['anthropic/claude-fable-5']);
  const response = await putSetting(env, SETTING_KEYS.opencodeConfig, {
    value: config
  });
  assert.equal(response.status, 200);
});

test('changing the password revokes every browser session', async () => {
  const env = createTestEnv();
  const url = new URL(`${URL_BASE}/api/settings/password`);
  await handleSetupApi(
    new Request(url, {
      method: 'POST',
      body: JSON.stringify({ password: 'first password' })
    }),
    url,
    env
  );
  await createAdminSession(env, url);
  await createAdminSession(env, url);
  const before = await env.DB.prepare('SELECT token_hash FROM admin_sessions').all();
  assert.equal(before.results.length, 3);

  const wrong = await handleSettingsApi(
    new Request(url, {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: 'not it',
        newPassword: 'second password'
      })
    }),
    env,
    url
  );
  assert.equal(wrong.status, 401);
  // A refused change must revoke nothing.
  const untouched = await env.DB.prepare('SELECT token_hash FROM admin_sessions').all();
  assert.equal(untouched.results.length, 3);

  const changed = await handleSettingsApi(
    new Request(url, {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: 'first password',
        newPassword: 'second password'
      })
    }),
    env,
    url
  );
  assert.equal(changed.status, 200);
  // Every old browser is gone; the caller's replacement cookie is the one row.
  const after = await env.DB.prepare('SELECT token_hash FROM admin_sessions').all();
  assert.equal(after.results.length, 1);
  assert.ok(changed.headers.get('set-cookie'));
});

test('the settings list reports configured keys and hides secret values', async () => {
  const env = createTestEnv();
  const url = new URL(`${URL_BASE}/api/settings`);

  const empty = await handleSettingsApi(new Request(url), env, url);
  const before = (await empty.json()).settings;
  assert.ok(before.length > 0);
  assert.ok(before.every((entry) => entry.configured === false));

  await putSetting(env, SETTING_KEYS.githubToken, { value: 'ghp_secret_value' });
  const filled = await handleSettingsApi(new Request(url), env, url);
  const token = (await filled.json()).settings.find(
    (entry) => entry.key === SETTING_KEYS.githubToken
  );
  assert.equal(token.configured, true);
  assert.ok(token.updatedAt);
  // A secret never reads back through the API.
  assert.notEqual(token.value, 'ghp_secret_value');
});

test('an optional setting can be cleared; a required one cannot', async () => {
  const env = createTestEnv();
  const hosts = [
    { id: 'mini', baseUrl: 'https://mini.example.com', token: 'tok' }
  ];
  await putSetting(env, SETTING_KEYS.dockerHosts, { value: hosts });
  assert.deepEqual(await readSetting(env, SETTING_KEYS.dockerHosts), hosts);

  const cleared = await putSetting(env, SETTING_KEYS.dockerHosts, { value: null });
  assert.equal(cleared.status, 200);
  assert.equal(await readSetting(env, SETTING_KEYS.dockerHosts), undefined);

  await putSetting(env, SETTING_KEYS.githubToken, { value: 'ghp_secret_value' });
  const refused = await putSetting(env, SETTING_KEYS.githubToken, { value: null });
  assert.equal(refused.status, 400);
  assert.equal(await readSetting(env, SETTING_KEYS.githubToken), 'ghp_secret_value');
});

test('an unknown setting key is a 404', async () => {
  const env = createTestEnv();
  const response = await putSetting(env, 'not.a.setting', { value: 'x' });
  assert.equal(response.status, 404);
});
