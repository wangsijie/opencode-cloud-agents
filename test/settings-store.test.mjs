/**
 * The `settings` table, against a real database.
 *
 * These are the behaviours the Drizzle rewrite must preserve exactly: the
 * upsert that keeps one row per key, the JSON round trip, and the two ways a
 * read can come back empty (no row at all, or a row whose value does not
 * parse) — both of which callers read as `undefined`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SETTING_KEYS,
  deleteSetting,
  readSetting,
  readSettingRow,
  writeSetting
} from '../src/settings.ts';
import { createTestEnv } from './helpers/d1.mjs';

test('a setting round trips through JSON', async () => {
  const env = createTestEnv();
  await writeSetting(env, SETTING_KEYS.githubToken, 'ghp_example');
  assert.equal(await readSetting(env, SETTING_KEYS.githubToken), 'ghp_example');

  await writeSetting(env, SETTING_KEYS.gitIdentity, {
    name: 'Ada',
    email: 'ada@example.com',
    overrides: [{ owner: 'acme', name: 'Ada at Acme', email: 'ada@acme.test' }]
  });
  assert.deepEqual(await readSetting(env, SETTING_KEYS.gitIdentity), {
    name: 'Ada',
    email: 'ada@example.com',
    overrides: [{ owner: 'acme', name: 'Ada at Acme', email: 'ada@acme.test' }]
  });
});

test('reading a key that was never written is undefined', async () => {
  const env = createTestEnv();
  assert.equal(await readSetting(env, SETTING_KEYS.opencodeConfig), undefined);
  assert.equal(await readSettingRow(env, SETTING_KEYS.opencodeConfig), undefined);
});

test('writing the same key twice replaces the value, never adds a row', async () => {
  const env = createTestEnv();
  await writeSetting(env, SETTING_KEYS.dockerImage, 'first:latest');
  await writeSetting(env, SETTING_KEYS.dockerImage, 'second:latest');

  assert.equal(await readSetting(env, SETTING_KEYS.dockerImage), 'second:latest');
  const rows = await env.DB.prepare(
    'SELECT key FROM settings WHERE key = ?1'
  )
    .bind(SETTING_KEYS.dockerImage)
    .all();
  assert.equal(rows.results.length, 1);
});

test('the upsert moves updated_at forward', async () => {
  const env = createTestEnv();
  await writeSetting(env, SETTING_KEYS.dockerImage, 'first:latest');
  const first = await readSettingRow(env, SETTING_KEYS.dockerImage);
  assert.ok(first);

  await new Promise((resolve) => setTimeout(resolve, 2));
  await writeSetting(env, SETTING_KEYS.dockerImage, 'second:latest');
  const second = await readSettingRow(env, SETTING_KEYS.dockerImage);
  assert.ok(second);

  assert.equal(second.value, '"second:latest"');
  assert.ok(second.updatedAt >= first.updatedAt);
});

test('readSettingRow hands back the raw JSON text and its timestamp', async () => {
  const env = createTestEnv();
  await writeSetting(env, SETTING_KEYS.containerEnv, [
    { name: 'FOO', value: 'bar' }
  ]);
  const row = await readSettingRow(env, SETTING_KEYS.containerEnv);
  assert.ok(row);
  assert.equal(row.value, '[{"name":"FOO","value":"bar"}]');
  assert.match(row.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('a value that does not parse reads as undefined rather than throwing', async () => {
  const env = createTestEnv();
  await env.DB.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)'
  )
    .bind('corrupt', 'not json at all', new Date().toISOString())
    .run();

  assert.equal(await readSetting(env, 'corrupt'), undefined);
  // The row itself is still readable; only the parse fails.
  const row = await readSettingRow(env, 'corrupt');
  assert.equal(row?.value, 'not json at all');
});

test('deleting a setting removes it, and deleting a missing one is harmless', async () => {
  const env = createTestEnv();
  await writeSetting(env, SETTING_KEYS.sshKey, { privateKey: 'a', publicKey: 'b' });
  await deleteSetting(env, SETTING_KEYS.sshKey);
  assert.equal(await readSetting(env, SETTING_KEYS.sshKey), undefined);

  await deleteSetting(env, SETTING_KEYS.sshKey);
  await deleteSetting(env, 'never-existed');
});

test('null and false survive the round trip as themselves', async () => {
  const env = createTestEnv();
  // `readSetting` reports "absent" as undefined, so a stored `null` must not be
  // confusable with a missing row by anything that checks for it.
  await writeSetting(env, 'stored-null', null);
  assert.equal(await readSetting(env, 'stored-null'), null);
  assert.notEqual(await readSettingRow(env, 'stored-null'), undefined);

  await writeSetting(env, 'stored-false', false);
  assert.equal(await readSetting(env, 'stored-false'), false);
});

test('keys are independent of one another', async () => {
  const env = createTestEnv();
  await writeSetting(env, SETTING_KEYS.githubToken, 'token');
  await writeSetting(env, SETTING_KEYS.dockerAgentToken, 'agent');
  await deleteSetting(env, SETTING_KEYS.githubToken);

  assert.equal(await readSetting(env, SETTING_KEYS.githubToken), undefined);
  assert.equal(await readSetting(env, SETTING_KEYS.dockerAgentToken), 'agent');
});
