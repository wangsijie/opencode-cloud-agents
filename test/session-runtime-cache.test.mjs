/**
 * The runtime status columns mirrored onto the session row, against a real
 * database.
 *
 * The two properties that matter: the derivations (`statusQuery` and the
 * container hint) happen when the patch leaves them out, and no write here ever
 * touches `updated_at` — calibration is not activity, and bumping it would
 * reorder the list and reset the cleanup clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildNewSession, getSession, insertSessionRow } from '../src/hub-store.ts';
import {
  markSessionStatusQuery,
  patchSessionRuntimeStatus
} from '../src/session-runtime-cache.ts';
import { createTestEnv } from './helpers/d1.mjs';

const CATALOG = { isModelRef: () => true };

async function seed(env) {
  const session = buildNewSession(
    {
      repo: {
        repoKey: 'opencode-cloud',
        displayName: 'octocat/opencode-cloud',
        cloneUrl: 'git@github.com:octocat/opencode-cloud.git',
        defaultBranch: 'master'
      },
      model: 'anthropic/claude-fable-5',
      title: 'Opening prompt'
    },
    CATALOG
  );
  await insertSessionRow(env, session);
  return session.record.id;
}

test('a fresh row is flagged for live status queries', async () => {
  const env = createTestEnv();
  const id = await seed(env);
  const session = await getSession(env, id);
  assert.equal(session.statusQuery, true);
  assert.ok(!('runtimeLifecycle' in session));
  assert.ok(!('statusObservedAt' in session));
});

test('an idle or sleeping runtime clears the flag; anything else sets it', async () => {
  const env = createTestEnv();
  const id = await seed(env);

  await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: 'idle' });
  let session = await getSession(env, id);
  assert.equal(session.runtimeLifecycle, 'idle');
  assert.equal(session.statusQuery, false);
  assert.ok(session.statusObservedAt);

  await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: 'sleeping' });
  session = await getSession(env, id);
  assert.equal(session.statusQuery, false);

  await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: 'starting' });
  session = await getSession(env, id);
  assert.equal(session.runtimeLifecycle, 'starting');
  assert.equal(session.statusQuery, true);
});

test('the container hint is derived from the lifecycle when not given', async () => {
  const env = createTestEnv();
  const id = await seed(env);

  for (const [lifecycle, container] of [
    ['sleeping', 'stopped'],
    ['stopping', 'stopped'],
    ['quiescing', 'stopping'],
    ['checkpointing', 'stopping'],
    ['idle', 'running'],
    ['starting', 'running']
  ]) {
    await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: lifecycle });
    assert.equal((await getSession(env, id)).container, container, lifecycle);
  }
});

test('an explicit container or flag beats the derivation', async () => {
  const env = createTestEnv();
  const id = await seed(env);

  await patchSessionRuntimeStatus(env, id, {
    runtimeLifecycle: 'idle',
    container: 'healthy',
    statusQuery: true
  });
  const session = await getSession(env, id);
  assert.equal(session.runtimeLifecycle, 'idle');
  assert.equal(session.container, 'healthy');
  assert.equal(session.statusQuery, true);
});

test('marking a session for live queries sets the flag alone', async () => {
  const env = createTestEnv();
  const id = await seed(env);
  await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: 'idle' });
  const calibrated = await getSession(env, id);
  assert.equal(calibrated.statusQuery, false);

  await markSessionStatusQuery(env, id);
  const marked = await getSession(env, id);
  assert.equal(marked.statusQuery, true);
  // The rest of the cache is untouched: only the flag moved.
  assert.equal(marked.runtimeLifecycle, 'idle');
  assert.equal(marked.container, calibrated.container);
  assert.equal(marked.statusObservedAt, calibrated.statusObservedAt);
});

test('cache writes never count as activity', async () => {
  const env = createTestEnv();
  const id = await seed(env);
  const before = await getSession(env, id);

  await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: 'starting' });
  await patchSessionRuntimeStatus(env, id, { runtimeLifecycle: 'idle' });
  await markSessionStatusQuery(env, id);

  assert.equal((await getSession(env, id)).updatedAt, before.updatedAt);
});

test('writing the cache for a session that does not exist is harmless', async () => {
  const env = createTestEnv();
  await patchSessionRuntimeStatus(env, 'inst-nope', { runtimeLifecycle: 'idle' });
  await markSessionStatusQuery(env, 'inst-nope');
});

test('one session cache write does not touch another row', async () => {
  const env = createTestEnv();
  const first = await seed(env);
  const second = await seed(env);

  await patchSessionRuntimeStatus(env, first, { runtimeLifecycle: 'idle' });
  const other = await getSession(env, second);
  assert.equal(other.statusQuery, true);
  assert.ok(!('runtimeLifecycle' in other));
});
