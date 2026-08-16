/**
 * `prebuilds` and `prebuild_runs`, against a real database.
 *
 * Two shapes carry the weight here and both must survive the Drizzle rewrite:
 * the composite `(repo_key, provider)` primary key the registry upsert conflicts
 * on, and the `COALESCE` patch on a run, which lets a caller touch one field
 * without clearing the rest.
 *
 * The provider is a whole host now (`docker:<id>`), not just "docker", so the
 * pair is what everything here is keyed by — a repository can hold a prebuild
 * on every host and each is its own row, its own history and its own delete.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deletePrebuildRecord,
  deletePrebuildRuns,
  findActivePrebuildRun,
  getPrebuildRun,
  insertPrebuildRun,
  latestPrebuildRuns,
  listPrebuildRecords,
  updatePrebuildRun,
  upsertPrebuildRecord
} from '../src/prebuilds.ts';
import { createTestEnv } from './helpers/d1.mjs';

function record(overrides = {}) {
  return {
    repoKey: 'opencode-cloud',
    provider: 'docker',
    location: 'oc-prebuild-opencode-cloud',
    sizeBytes: 1024,
    source: 'run',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

test('a prebuild round trips, and an absent size is an absent field', async () => {
  const env = createTestEnv();
  await upsertPrebuildRecord(env, record());
  assert.deepEqual(await listPrebuildRecords(env), [record()]);

  await upsertPrebuildRecord(
    env,
    record({ repoKey: 'other-repo', sizeBytes: undefined })
  );
  const [, other] = await listPrebuildRecords(env);
  assert.equal(other.repoKey, 'other-repo');
  assert.ok(!('sizeBytes' in other));
});

test('the registry is listed by repo key', async () => {
  const env = createTestEnv();
  await upsertPrebuildRecord(env, record({ repoKey: 'zebra' }));
  await upsertPrebuildRecord(env, record({ repoKey: 'alpha' }));
  await upsertPrebuildRecord(env, record({ repoKey: 'middle' }));

  assert.deepEqual(
    (await listPrebuildRecords(env)).map((entry) => entry.repoKey),
    ['alpha', 'middle', 'zebra']
  );
});

test('the upsert conflicts on the repo/provider pair, not the repo alone', async () => {
  const env = createTestEnv();
  await upsertPrebuildRecord(env, record({ location: 'first', sizeBytes: 1 }));
  await upsertPrebuildRecord(
    env,
    record({
      location: 'second',
      sizeBytes: 2,
      source: 'session',
      updatedAt: '2026-07-02T00:00:00.000Z'
    })
  );

  const rows = await listPrebuildRecords(env);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    repoKey: 'opencode-cloud',
    provider: 'docker',
    location: 'second',
    sizeBytes: 2,
    source: 'session',
    updatedAt: '2026-07-02T00:00:00.000Z'
  });

  // The same repository under another provider is a different row.
  await upsertPrebuildRecord(env, record({ provider: 'cloudflare' }));
  assert.equal((await listPrebuildRecords(env)).length, 2);
});

test('deleting a prebuild takes only that provider row', async () => {
  const env = createTestEnv();
  await upsertPrebuildRecord(env, record({ provider: 'docker' }));
  await upsertPrebuildRecord(env, record({ provider: 'cloudflare' }));

  await deletePrebuildRecord(env, 'opencode-cloud', 'docker');
  const rows = await listPrebuildRecords(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'cloudflare');

  // Deleting something that is not there is not an error.
  await deletePrebuildRecord(env, 'never-existed', 'docker');
});

test('a run is inserted with only its opening fields set', async () => {
  const env = createTestEnv();
  await insertPrebuildRun(env, {
    id: 'run-1',
    repoKey: 'opencode-cloud',
    provider: 'docker',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z'
  });

  const latest = await latestPrebuildRuns(env);
  assert.deepEqual(latest.get('docker/opencode-cloud'), {
    id: 'run-1',
    repoKey: 'opencode-cloud',
    provider: 'docker',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z',
    attempts: 0
  });
});

test('a run patch touches only the fields it names', async () => {
  const env = createTestEnv();
  await insertPrebuildRun(env, {
    id: 'run-1',
    repoKey: 'opencode-cloud',
    provider: 'docker',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z'
  });

  await updatePrebuildRun(env, 'run-1', { logTail: 'installing…' });
  let run = (await latestPrebuildRuns(env)).get('docker/opencode-cloud');
  assert.equal(run.logTail, 'installing…');
  assert.equal(run.status, 'running');
  assert.ok(!('finishedAt' in run));

  await updatePrebuildRun(env, 'run-1', {
    status: 'succeeded',
    finishedAt: '2026-07-01T00:05:00.000Z',
    timings: { cloneMs: 1200, installMs: 30_000, totalMs: 31_200 }
  });
  run = (await latestPrebuildRuns(env)).get('docker/opencode-cloud');
  assert.equal(run.status, 'succeeded');
  assert.equal(run.finishedAt, '2026-07-01T00:05:00.000Z');
  assert.deepEqual(run.timings, {
    cloneMs: 1200,
    installMs: 30_000,
    totalMs: 31_200
  });
  // The earlier log tail is still there: a patch never clears what it omits.
  assert.equal(run.logTail, 'installing…');
});

test('a patch of a run id that does not exist changes nothing', async () => {
  const env = createTestEnv();
  await updatePrebuildRun(env, 'no-such-run', { status: 'failed' });
  assert.equal((await latestPrebuildRuns(env)).size, 0);
});

test('the same repository on two hosts keeps two runs', async () => {
  const env = createTestEnv();
  for (const provider of ['docker:mini', 'docker:shop']) {
    await insertPrebuildRun(env, {
      id: `run-${provider}`,
      repoKey: 'opencode-cloud',
      provider,
      status: 'running',
      startedAt: '2026-07-01T00:00:00.000Z'
    });
  }
  const latest = await latestPrebuildRuns(env);
  assert.equal(latest.size, 2);
  assert.equal(latest.get('docker:mini/opencode-cloud').id, 'run-docker:mini');
  assert.equal(latest.get('docker:shop/opencode-cloud').id, 'run-docker:shop');

  // Deleting one host's history leaves the other host's alone, the same way
  // the registry rows are per host.
  await deletePrebuildRuns(env, 'opencode-cloud', 'docker:mini');
  const remaining = await latestPrebuildRuns(env);
  assert.equal(remaining.size, 1);
  assert.ok(remaining.has('docker:shop/opencode-cloud'));
});

test('only the newest run per repository is reported', async () => {
  const env = createTestEnv();
  for (const [id, startedAt, status] of [
    ['run-old', '2026-07-01T00:00:00.000Z', 'failed'],
    ['run-new', '2026-07-03T00:00:00.000Z', 'succeeded'],
    ['run-mid', '2026-07-02T00:00:00.000Z', 'failed']
  ]) {
    await insertPrebuildRun(env, {
      id,
      repoKey: 'opencode-cloud',
      provider: 'docker',
      status,
      startedAt
    });
  }
  await insertPrebuildRun(env, {
    id: 'other-run',
    repoKey: 'other-repo',
    provider: 'docker',
    status: 'running',
    startedAt: '2026-06-01T00:00:00.000Z'
  });

  const latest = await latestPrebuildRuns(env);
  assert.equal(latest.size, 2);
  assert.equal(latest.get('docker/opencode-cloud').id, 'run-new');
  assert.equal(latest.get('docker/other-repo').id, 'other-run');
});

test('deleting a repo run history leaves other repositories alone', async () => {
  const env = createTestEnv();
  await insertPrebuildRun(env, {
    id: 'run-1',
    repoKey: 'opencode-cloud',
    provider: 'docker',
    status: 'failed',
    startedAt: '2026-07-01T00:00:00.000Z'
  });
  await insertPrebuildRun(env, {
    id: 'run-2',
    repoKey: 'other-repo',
    provider: 'docker',
    status: 'succeeded',
    startedAt: '2026-07-01T00:00:00.000Z'
  });

  await deletePrebuildRuns(env, 'opencode-cloud', 'docker');
  const latest = await latestPrebuildRuns(env);
  assert.equal(latest.size, 1);
  assert.ok(latest.has('docker/other-repo'));
});

test('timings that are not valid JSON degrade to an empty object', async () => {
  const env = createTestEnv();
  await insertPrebuildRun(env, {
    id: 'run-1',
    repoKey: 'opencode-cloud',
    provider: 'docker',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z'
  });
  await env.DB.prepare('UPDATE prebuild_runs SET timings = ?2 WHERE id = ?1')
    .bind('run-1', 'not json')
    .run();

  const run = (await latestPrebuildRuns(env)).get('docker/opencode-cloud');
  assert.deepEqual(run.timings, {});
});

test('getPrebuildRun and findActivePrebuildRun query execution state from D1', async () => {
  const env = createTestEnv();
  await insertPrebuildRun(env, {
    id: 'run-1',
    repoKey: 'opencode-cloud',
    provider: 'docker:mini',
    status: 'running',
    startedAt: '2026-07-01T00:00:00.000Z',
    step: 'provision',
    stepStartedAt: 1700000000000,
    attempts: 1
  });

  const run = await getPrebuildRun(env, 'run-1');
  assert.equal(run?.id, 'run-1');
  assert.equal(run?.step, 'provision');
  assert.equal(run?.stepStartedAt, 1700000000000);
  assert.equal(run?.attempts, 1);

  const active = await findActivePrebuildRun(env, 'opencode-cloud', 'docker:mini');
  assert.equal(active?.id, 'run-1');

  await updatePrebuildRun(env, 'run-1', {
    step: 'install',
    stepStartedAt: 1700000050000,
    attempts: 0,
    status: 'succeeded'
  });

  const updated = await getPrebuildRun(env, 'run-1');
  assert.equal(updated?.step, 'install');
  assert.equal(updated?.stepStartedAt, 1700000050000);
  assert.equal(updated?.attempts, 0);
  assert.equal(updated?.status, 'succeeded');

  const noActive = await findActivePrebuildRun(env, 'opencode-cloud', 'docker:mini');
  assert.equal(noActive, undefined);
});
