/**
 * The session registry, against a real database.
 *
 * `hub-store.ts` is the file where the raw SQL was doing real work rather than
 * shuttling values: conditional patches that skip absent fields, compare-and-swap
 * claims that fence the lifecycle queues on an operation id, and the derived
 * orderings the composer reads. Every one of those is a behaviour, not a query,
 * so they are pinned here before the statements are rewritten.
 *
 * The store pokes the Hub Durable Object and the LifecycleCoordinator on the
 * deletion paths; both are stubbed, and the calls are asserted where they are
 * part of the contract.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginDelete,
  buildNewSession,
  clearSessionUnread,
  deferDelete,
  finishClean,
  finishDelete,
  getInstance,
  getSession,
  hasPendingCleanup,
  hasPendingDeletion,
  insertSessionRow,
  lastModelSelection,
  listInstances,
  listRegistry,
  listSessions,
  markCleanFailed,
  markDeleteFailed,
  markSessionRead,
  markSessionUnread,
  nextPendingCleanup,
  nextPendingDeletion,
  renameSession,
  setSessionBootStep,
  setSessionPinned,
  setSessionWorkspaceOrigin,
  sweepIdleSessions,
  updateSession
} from '../src/hub-store.ts';
import { CLEANUP_IDLE_DAYS } from '../src/sessions.ts';
import { createTestEnv } from './helpers/d1.mjs';

const REPO = {
  repoKey: 'opencode-cloud',
  displayName: 'octocat/opencode-cloud',
  cloneUrl: 'git@github.com:octocat/opencode-cloud.git',
  defaultBranch: 'master'
};

const OTHER_REPO = {
  repoKey: 'other-repo',
  displayName: 'octocat/other-repo',
  cloneUrl: 'git@github.com:octocat/other-repo.git',
  defaultBranch: 'main'
};

/** A catalog that accepts the two models these tests use. */
const CATALOG = {
  isModelRef: (ref) =>
    ref === 'anthropic/claude-fable-5' || ref === 'openai/gpt-example'
};

/** `env` plus the Durable Object stubs the deletion paths reach for. */
function testEnv() {
  const pokes = [];
  const lifecycleCalls = [];
  const env = createTestEnv({
    Hub: {
      getByName: () => ({
        poke: async () => {
          pokes.push(true);
        }
      })
    },
    LifecycleCoordinator: {
      getByName: (id) => ({
        beginDelete: async () => {
          lifecycleCalls.push(id);
        }
      })
    }
  });
  return { env, pokes, lifecycleCalls };
}

/**
 * Create a session row and hand back its id. `repo` defaults to {@link REPO};
 * passing it explicitly as `undefined` is how a repository-less session is
 * asked for, so the default must not fill it back in.
 */
async function seed(env, overrides = {}) {
  const { createdAt, ...input } = overrides;
  const repo = 'repo' in overrides ? overrides.repo : REPO;
  delete input.repo;
  const session = buildNewSession(
    {
      ...(repo ? { repo } : {}),
      model: 'anthropic/claude-fable-5',
      title: 'Opening prompt',
      ...input
    },
    CATALOG,
    createdAt
  );
  await insertSessionRow(env, session);
  return session.record.id;
}

/** Set columns the store has no writer for, so a scenario can be arranged. */
async function forceColumns(env, id, columns) {
  const names = Object.keys(columns);
  const assignments = names
    .map((name, index) => `${name} = ?${index + 2}`)
    .join(', ');
  await env.DB.prepare(`UPDATE sessions SET ${assignments} WHERE id = ?1`)
    .bind(id, ...names.map((name) => columns[name]))
    .run();
}

test('a new session is minted queued, with its opening prompt counted', () => {
  const session = buildNewSession(
    { repo: REPO, model: 'anthropic/claude-fable-5', title: 'Fix lint' },
    CATALOG,
    '2026-07-01T00:00:00.000Z'
  );
  assert.match(session.record.id, /^inst-/);
  assert.equal(session.record.instanceId, session.record.id);
  assert.equal(session.record.repoKey, 'opencode-cloud');
  assert.equal(session.record.directory, '/workspace/opencode-cloud');
  assert.equal(session.record.provider, 'cloudflare');
  assert.equal(session.record.phase, 'queued');
  assert.equal(session.record.pendingPromptCount, 1);
  assert.equal(session.record.statusQuery, true);
  assert.match(session.name, /^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
});

test('an unknown model or repository is refused before anything is stored', () => {
  assert.throws(
    () => buildNewSession({ repo: REPO, model: 'nope/nope', title: 't' }, CATALOG),
    /Unknown model/
  );
  assert.throws(
    () =>
      buildNewSession(
        { repo: { repoKey: '../escape' }, model: 'anthropic/claude-fable-5', title: 't' },
        CATALOG
      ),
    /Unknown repository/
  );
});

test('an inserted session reads back as both projections', async () => {
  const { env } = testEnv();
  const id = await seed(env, { variant: 'high', provider: 'docker' });

  const session = await getSession(env, id);
  assert.equal(session.id, id);
  assert.equal(session.repoKey, 'opencode-cloud');
  assert.equal(session.provider, 'docker');
  assert.equal(session.model, 'anthropic/claude-fable-5');
  assert.equal(session.variant, 'high');
  assert.equal(session.phase, 'queued');
  assert.equal(session.pendingPromptCount, 1);
  assert.equal(session.statusQuery, true);

  const instance = await getInstance(env, id);
  assert.equal(instance.id, id);
  assert.equal(instance.lifecycle, 'ready');
  assert.deepEqual(instance.repo, REPO);

  const [entry] = await listRegistry(env);
  assert.deepEqual(entry.session, session);
  assert.deepEqual(entry.instance, instance);
});

test('a session with no repository stores the empty key and reports no repoKey', async () => {
  const { env } = testEnv();
  const id = await seed(env, { repo: undefined });

  const session = await getSession(env, id);
  assert.ok(!('repoKey' in session));
  assert.equal(session.directory, '/workspace');

  const instance = await getInstance(env, id);
  assert.ok(!('repoKey' in instance));
  assert.ok(!('repo' in instance));

  // The column itself is NOT NULL, so the row carries the empty string.
  const row = await env.DB.prepare(
    'SELECT repo_key, repo_json FROM sessions WHERE id = ?1'
  )
    .bind(id)
    .first();
  assert.equal(row.repo_key, '');
  assert.equal(row.repo_json, null);
});

test('reading a session that does not exist is undefined', async () => {
  const { env } = testEnv();
  assert.equal(await getSession(env, 'inst-nope'), undefined);
  assert.equal(await getInstance(env, 'inst-nope'), undefined);
  assert.deepEqual(await listSessions(env), []);
  assert.deepEqual(await listInstances(env), []);
});

test('the list is newest first', async () => {
  const { env } = testEnv();
  const oldest = await seed(env, { createdAt: '2026-07-01T00:00:00.000Z' });
  const newest = await seed(env, { createdAt: '2026-07-03T00:00:00.000Z' });
  const middle = await seed(env, { createdAt: '2026-07-02T00:00:00.000Z' });

  assert.deepEqual(
    (await listSessions(env)).map((session) => session.id),
    [newest, middle, oldest]
  );
});

test('inserting the same session twice keeps the first row', async () => {
  const { env } = testEnv();
  const session = buildNewSession(
    { repo: REPO, model: 'anthropic/claude-fable-5', title: 'First title' },
    CATALOG
  );
  await insertSessionRow(env, session);
  await updateSession(env, session.record.id, { phase: 'working' });

  // The agent's alarm can replay the insert after a partial failure; the row it
  // finds must be left exactly as it is rather than reset to creation values.
  await insertSessionRow(env, session);

  const stored = await getSession(env, session.record.id);
  assert.equal(stored.phase, 'working');
  assert.equal(stored.title, 'First title');
  assert.equal((await listSessions(env)).length, 1);
});

test('a state patch applies only the fields it names', async () => {
  const { env } = testEnv();
  const id = await seed(env);
  const before = await getSession(env, id);

  const patched = await updateSession(env, id, { phase: 'working' });
  assert.equal(patched.phase, 'working');
  assert.equal(patched.model, before.model);
  assert.equal(patched.title, before.title);
  assert.equal(patched.pendingPromptCount, before.pendingPromptCount);
  assert.ok(patched.updatedAt >= before.updatedAt);

  const more = await updateSession(env, id, {
    model: 'openai/gpt-example',
    opencodeSessionId: 'ses_abc',
    pendingPromptCount: 0,
    lastPromptAt: '2026-07-04T00:00:00.000Z'
  });
  assert.equal(more.phase, 'working');
  assert.equal(more.model, 'openai/gpt-example');
  assert.equal(more.opencodeSessionId, 'ses_abc');
  assert.equal(more.pendingPromptCount, 0);
  assert.equal(more.lastPromptAt, '2026-07-04T00:00:00.000Z');
});

test('variant and lastError are tri-state: keep, set, clear', async () => {
  const { env } = testEnv();
  const id = await seed(env, { variant: 'high' });

  // Absent keeps the column.
  let session = await updateSession(env, id, { phase: 'working' });
  assert.equal(session.variant, 'high');
  assert.ok(!('lastError' in session));

  // A value sets it.
  session = await updateSession(env, id, {
    variant: 'low',
    lastError: 'dispatch failed'
  });
  assert.equal(session.variant, 'low');
  assert.equal(session.lastError, 'dispatch failed');

  // `null` clears it.
  session = await updateSession(env, id, { variant: null, lastError: null });
  assert.ok(!('variant' in session));
  assert.ok(!('lastError' in session));
});

test('an automatic title lands until the session is renamed by hand', async () => {
  const { env } = testEnv();
  const id = await seed(env);

  let session = await updateSession(env, id, { title: 'Chosen by OpenCode' });
  assert.equal(session.title, 'Chosen by OpenCode');
  assert.ok(!('titleLocked' in session));

  session = await renameSession(env, id, 'Named by hand');
  assert.equal(session.title, 'Named by hand');
  assert.equal(session.titleLocked, true);

  // The lock outranks every later automatic title.
  session = await updateSession(env, id, { title: 'OpenCode tried again' });
  assert.equal(session.title, 'Named by hand');
  assert.equal(session.titleLocked, true);
});

test('patching or renaming a session that does not exist is undefined', async () => {
  const { env } = testEnv();
  assert.equal(await updateSession(env, 'inst-nope', { phase: 'failed' }), undefined);
  assert.equal(await renameSession(env, 'inst-nope', 'x'), undefined);
});

test('the unread marker keeps the earliest moment and clears by compare-and-swap', async () => {
  const { env } = testEnv();
  const id = await seed(env);

  await markSessionUnread(env, id, '2026-07-01T00:00:00.000Z');
  await markSessionUnread(env, id, '2026-07-02T00:00:00.000Z');
  assert.equal((await getSession(env, id)).unreadAt, '2026-07-01T00:00:00.000Z');

  // Clearing a value the client never saw leaves the marker alone.
  await markSessionRead(env, id, '2026-07-02T00:00:00.000Z');
  assert.equal((await getSession(env, id)).unreadAt, '2026-07-01T00:00:00.000Z');

  await markSessionRead(env, id, '2026-07-01T00:00:00.000Z');
  assert.ok(!('unreadAt' in (await getSession(env, id))));

  // The unconditional clear does not need to know the value.
  await markSessionUnread(env, id, '2026-07-03T00:00:00.000Z');
  await clearSessionUnread(env, id);
  assert.ok(!('unreadAt' in (await getSession(env, id))));
});

test('unread, pin and boot step never count as activity', async () => {
  const { env } = testEnv();
  const id = await seed(env);
  const before = await getSession(env, id);

  await markSessionUnread(env, id, '2026-07-05T00:00:00.000Z');
  await setSessionPinned(env, id, true);
  await setSessionBootStep(env, id, 'cloning');
  await markSessionRead(env, id, '2026-07-05T00:00:00.000Z');

  const after = await getSession(env, id);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(after.bootStep, 'cloning');
});

test('pinning keeps the first moment and unpinning clears it', async () => {
  const { env } = testEnv();
  const id = await seed(env);

  const pinned = await setSessionPinned(env, id, true);
  assert.ok(pinned.pinnedAt);
  const first = pinned.pinnedAt;

  const again = await setSessionPinned(env, id, true);
  assert.equal(again.pinnedAt, first);

  const unpinned = await setSessionPinned(env, id, false);
  assert.ok(!('pinnedAt' in unpinned));

  assert.equal(await setSessionPinned(env, 'inst-nope', true), undefined);
});

test('the boot step can be advanced and cleared', async () => {
  const { env } = testEnv();
  const id = await seed(env);

  await setSessionBootStep(env, id, 'seeding');
  assert.equal((await getSession(env, id)).bootStep, 'seeding');

  await setSessionBootStep(env, id, null);
  assert.ok(!('bootStep' in (await getSession(env, id))));
});

test('the workspace origin is write-once', async () => {
  const { env } = testEnv();
  const id = await seed(env);

  await setSessionWorkspaceOrigin(env, id, 'clone');
  assert.equal((await getSession(env, id)).workspaceOrigin, 'clone');

  // A later wake must not rewrite how the workspace first came to be.
  await setSessionWorkspaceOrigin(env, id, 'snapshot');
  assert.equal((await getSession(env, id)).workspaceOrigin, 'clone');
});

test('a delete claim is idempotent and reuses the operation in flight', async () => {
  const { env, pokes, lifecycleCalls } = testEnv();
  const id = await seed(env);

  const claimed = await beginDelete(env, id);
  assert.equal(claimed.lifecycle, 'deleting');
  const operationId = claimed.deleteOperationId;
  assert.ok(operationId);
  assert.equal(pokes.length, 1);
  assert.deepEqual(lifecycleCalls, [id]);

  // Pressing delete again must not restart a purge that is already running.
  const again = await beginDelete(env, id);
  assert.equal(again.deleteOperationId, operationId);
  assert.equal(pokes.length, 2);

  assert.equal(await beginDelete(env, 'inst-nope'), undefined);
});

test('the deletion queue is served oldest first', async () => {
  const { env } = testEnv();
  assert.equal(await hasPendingDeletion(env), false);
  assert.equal(await nextPendingDeletion(env), undefined);

  const older = await seed(env);
  const newer = await seed(env);
  await beginDelete(env, older);
  await forceColumns(env, older, { updated_at: '2026-07-01T00:00:00.000Z' });
  await beginDelete(env, newer);
  await forceColumns(env, newer, { updated_at: '2026-07-02T00:00:00.000Z' });

  assert.equal(await hasPendingDeletion(env), true);
  assert.equal((await nextPendingDeletion(env)).id, older);
});

test('every delete outcome is fenced on the operation id', async () => {
  const { env } = testEnv();
  const id = await seed(env);
  const { deleteOperationId } = await beginDelete(env, id);

  // An attempt that lost its claim cannot write over the one that replaced it.
  await markDeleteFailed(env, id, 'stale-operation', 'should not land');
  assert.equal((await getInstance(env, id)).lifecycle, 'deleting');

  await deferDelete(env, id, deleteOperationId, 'container still busy');
  let instance = await getInstance(env, id);
  assert.equal(instance.lifecycle, 'deleting');
  assert.equal(instance.lastError, 'container still busy; retry scheduled');

  await markDeleteFailed(env, id, deleteOperationId, 'purge timed out');
  instance = await getInstance(env, id);
  assert.equal(instance.lifecycle, 'delete_failed');
  assert.equal(instance.lastError, 'purge timed out');

  // A stale finish leaves the row; the live one removes it.
  await finishDelete(env, id, 'stale-operation');
  assert.notEqual(await getInstance(env, id), undefined);
  await finishDelete(env, id, deleteOperationId);
  assert.equal(await getInstance(env, id), undefined);
});

test('the idle sweep claims only sessions that are really idle', async () => {
  const { env, pokes } = testEnv();
  const now = new Date('2026-08-01T00:00:00.000Z');
  const old = new Date(
    now.getTime() - (CLEANUP_IDLE_DAYS + 1) * 24 * 60 * 60 * 1000
  ).toISOString();

  const idle = await seed(env);
  await forceColumns(env, idle, {
    phase: 'failed',
    pending_prompt_count: 0,
    updated_at: old,
    last_prompt_at: old
  });

  const stillWorking = await seed(env);
  await forceColumns(env, stillWorking, {
    phase: 'working',
    pending_prompt_count: 0,
    updated_at: old
  });

  const promptQueued = await seed(env);
  await forceColumns(env, promptQueued, {
    phase: 'failed',
    pending_prompt_count: 1,
    updated_at: old
  });

  const recent = await seed(env);
  await forceColumns(env, recent, {
    phase: 'failed',
    pending_prompt_count: 0,
    updated_at: now.toISOString()
  });

  // A prompt after the cutoff keeps its session even when the row is old.
  const promptedLately = await seed(env);
  await forceColumns(env, promptedLately, {
    phase: 'failed',
    pending_prompt_count: 0,
    updated_at: old,
    last_prompt_at: now.toISOString()
  });

  assert.equal(await sweepIdleSessions(env, now), 1);
  assert.equal(pokes.length, 1);
  assert.equal((await getInstance(env, idle)).lifecycle, 'cleaning');
  for (const id of [stillWorking, promptQueued, recent, promptedLately]) {
    assert.equal((await getInstance(env, id)).lifecycle, 'ready');
  }

  // The claim moved the row out of 'ready', so a re-sweep finds nothing.
  assert.equal(await sweepIdleSessions(env, now), 0);
});

test('a cleanup claim does not count as activity', async () => {
  const { env } = testEnv();
  const now = new Date('2026-08-01T00:00:00.000Z');
  const old = new Date(
    now.getTime() - (CLEANUP_IDLE_DAYS + 1) * 24 * 60 * 60 * 1000
  ).toISOString();
  const id = await seed(env);
  await forceColumns(env, id, {
    phase: 'failed',
    pending_prompt_count: 0,
    updated_at: old
  });

  await sweepIdleSessions(env, now);
  // Bumping updated_at here would resurface a long-idle session at the top.
  assert.equal((await getInstance(env, id)).updatedAt, old);
});

test('a failed cleanup is swept again, a finished one is not', async () => {
  const { env } = testEnv();
  const now = new Date('2026-08-01T00:00:00.000Z');
  const old = new Date(
    now.getTime() - (CLEANUP_IDLE_DAYS + 1) * 24 * 60 * 60 * 1000
  ).toISOString();

  const id = await seed(env);
  await forceColumns(env, id, {
    phase: 'failed',
    pending_prompt_count: 0,
    updated_at: old
  });
  await sweepIdleSessions(env, now);

  assert.equal(await hasPendingCleanup(env), true);
  const pending = await nextPendingCleanup(env);
  assert.equal(pending.id, id);
  const operationId = pending.deleteOperationId;

  // Fenced like the delete path: a stale attempt writes nothing.
  await markCleanFailed(env, id, 'stale-operation', 'nope');
  assert.equal((await getInstance(env, id)).lifecycle, 'cleaning');

  await markCleanFailed(env, id, operationId, 'snapshot delete failed');
  let instance = await getInstance(env, id);
  assert.equal(instance.lifecycle, 'clean_failed');
  assert.equal(instance.lastError, 'snapshot delete failed');
  // clean_failed is eligible again, so the next sweep retries it.
  assert.equal(await sweepIdleSessions(env, now), 1);

  const retried = await nextPendingCleanup(env);
  await finishClean(env, id, retried.deleteOperationId);
  instance = await getInstance(env, id);
  assert.equal(instance.lifecycle, 'cleaned');
  assert.ok(!('lastError' in instance));
  assert.ok(!('deleteOperationId' in instance));
  assert.ok((await getSession(env, id)).cleanedAt);

  assert.equal(await hasPendingCleanup(env), false);
  assert.equal(await nextPendingCleanup(env), undefined);
  // A cleaned session is never swept again.
  assert.equal(await sweepIdleSessions(env, now), 0);
});

test('the last model selection follows the most recent activity', async () => {
  const { env } = testEnv();
  assert.equal(await lastModelSelection(env), undefined);

  const older = await seed(env, { createdAt: '2026-07-01T00:00:00.000Z' });
  const newer = await seed(env, {
    createdAt: '2026-07-02T00:00:00.000Z',
    model: 'openai/gpt-example',
    variant: 'high'
  });

  assert.deepEqual(await lastModelSelection(env), {
    model: 'openai/gpt-example',
    variant: 'high'
  });

  // Going back to an older session makes its selection the current one: a
  // prompt counts as use, not only creation.
  await updateSession(env, older, { lastPromptAt: '2026-07-03T00:00:00.000Z' });
  assert.deepEqual(await lastModelSelection(env), {
    model: 'anthropic/claude-fable-5'
  });
});

test('every repository pinned on a session stays reachable', async () => {
  const { env } = testEnv();
  await seed(env, { repo: REPO });
  await seed(env, { repo: OTHER_REPO });
  await seed(env, { repo: REPO });
  await seed(env, { repo: undefined });

  // `reposInUse` is private; the catalog view is how it is observed, so this
  // asserts the query that feeds it through the row projection instead.
  const rows = await env.DB.prepare(
    'SELECT repo_json FROM sessions WHERE repo_json IS NOT NULL'
  ).all();
  assert.equal(rows.results.length, 3);
  const keys = new Set(
    rows.results.map((row) => JSON.parse(row.repo_json).repoKey)
  );
  assert.deepEqual([...keys].sort(), ['opencode-cloud', 'other-repo']);
});
