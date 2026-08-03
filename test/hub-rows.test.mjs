import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseRepoJson,
  rowToInstance,
  rowToSession,
  sessionPatchAssignments
} from '../src/hub-rows.ts'

const repo = {
  repoKey: 'opencode-cloud',
  displayName: 'octocat/hello-world',
  cloneUrl: 'git@github.com:octocat/hello-world.git',
  defaultBranch: 'master'
}

// The property names are the schema's, not the column names: a row reaches
// these projections through Drizzle now, which maps snake_case columns onto
// camelCase fields on the way out.
function fullRow() {
  return {
    id: 'inst-1111',
    name: 'silver-otter-abcd',
    repoKey: 'opencode-cloud',
    repoJson: JSON.stringify(repo),
    provider: 'docker',
    lifecycle: 'deleting',
    lifecycleError: 'purge timed out',
    deleteOperationId: 'op-1',
    directory: '/workspace/opencode-cloud',
    model: 'anthropic/claude-fable-5',
    variant: 'high',
    title: 'Named by hand',
    titleLocked: 1,
    opencodeSessionId: 'ses_abc',
    phase: 'working',
    pendingPromptCount: 2,
    lastError: 'dispatch failed once',
    lastPromptAt: '2026-07-27T02:00:00.000Z',
    cleanedAt: null,
    unreadAt: '2026-07-27T03:30:00.000Z',
    pinnedAt: '2026-07-27T03:40:00.000Z',
    workspaceOrigin: 'prebuild',
    bootStep: null,
    runtimeLifecycle: 'busy',
    container: 'running',
    statusQuery: 1,
    statusObservedAt: '2026-07-27T03:45:00.000Z',
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T04:00:00.000Z'
  }
}

function minimalRow() {
  return {
    ...fullRow(),
    repoJson: null,
    provider: 'cloudflare',
    lifecycle: 'ready',
    lifecycleError: null,
    deleteOperationId: null,
    directory: null,
    variant: null,
    titleLocked: 0,
    opencodeSessionId: null,
    lastError: null,
    lastPromptAt: null,
    unreadAt: null,
    pinnedAt: null,
    workspaceOrigin: null,
    runtimeLifecycle: null,
    container: null,
    statusQuery: 1,
    statusObservedAt: null
  }
}

test('a full row projects into both record shapes', () => {
  const row = fullRow()
  assert.deepEqual(rowToInstance(row), {
    id: 'inst-1111',
    name: 'silver-otter-abcd',
    repoKey: 'opencode-cloud',
    repo,
    provider: 'docker',
    lifecycle: 'deleting',
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T04:00:00.000Z',
    lastError: 'purge timed out',
    deleteOperationId: 'op-1'
  })
  assert.deepEqual(rowToSession(row), {
    id: 'inst-1111',
    instanceId: 'inst-1111',
    repoKey: 'opencode-cloud',
    directory: '/workspace/opencode-cloud',
    provider: 'docker',
    model: 'anthropic/claude-fable-5',
    variant: 'high',
    title: 'Named by hand',
    opencodeSessionId: 'ses_abc',
    phase: 'working',
    pendingPromptCount: 2,
    lastError: 'dispatch failed once',
    lastPromptAt: '2026-07-27T02:00:00.000Z',
    unreadAt: '2026-07-27T03:30:00.000Z',
    pinnedAt: '2026-07-27T03:40:00.000Z',
    titleLocked: true,
    workspaceOrigin: 'prebuild',
    runtimeLifecycle: 'busy',
    container: 'running',
    statusQuery: true,
    statusObservedAt: '2026-07-27T03:45:00.000Z',
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T04:00:00.000Z'
  })
})

test('NULL columns become absent optional fields, not undefined values', () => {
  const instance = rowToInstance(minimalRow())
  assert.ok(!('repo' in instance))
  assert.ok(!('lastError' in instance))
  assert.ok(!('deleteOperationId' in instance))

  const session = rowToSession(minimalRow())
  for (const key of [
    'directory',
    'variant',
    'opencodeSessionId',
    'lastError',
    'lastPromptAt',
    'cleanedAt',
    'unreadAt',
    'pinnedAt',
    'titleLocked',
    'workspaceOrigin',
    'bootStep',
    'runtimeLifecycle',
    'container',
    'statusObservedAt'
  ]) {
    assert.ok(!(key in session), `${key} should be absent`)
  }
  assert.equal(session.statusQuery, true)
})

test('statusQuery 0 projects as a cold session', () => {
  const session = rowToSession({
    ...minimalRow(),
    runtimeLifecycle: 'sleeping',
    container: 'stopped',
    statusQuery: 0,
    statusObservedAt: '2026-07-27T05:00:00.000Z'
  })
  assert.equal(session.runtimeLifecycle, 'sleeping')
  assert.equal(session.container, 'stopped')
  assert.equal(session.statusQuery, false)
  assert.equal(session.statusObservedAt, '2026-07-27T05:00:00.000Z')
})

test('a cleaned row carries its lifecycle and timestamp into the records', () => {
  const row = {
    ...minimalRow(),
    lifecycle: 'cleaned',
    cleanedAt: '2026-07-28T03:23:00.000Z'
  }
  assert.equal(rowToInstance(row).lifecycle, 'cleaned')
  assert.equal(rowToSession(row).cleanedAt, '2026-07-28T03:23:00.000Z')
})

test('the provider column reaches both record shapes', () => {
  const instance = rowToInstance(minimalRow())
  assert.equal(instance.provider, 'cloudflare')
  const session = rowToSession(minimalRow())
  assert.equal(session.provider, 'cloudflare')
})

test('an empty repoKey is a session with no repository, not an empty key', () => {
  const row = { ...minimalRow(), repoKey: '', directory: '/workspace' }
  const instance = rowToInstance(row)
  assert.ok(!('repoKey' in instance))
  assert.ok(!('repo' in instance))

  const session = rowToSession(row)
  assert.ok(!('repoKey' in session))
  assert.equal(session.directory, '/workspace')
})

test('repoJson that is broken or unsafe is dropped rather than trusted', () => {
  assert.equal(parseRepoJson(null), undefined)
  assert.equal(parseRepoJson('{not json'), undefined)
  assert.equal(parseRepoJson(JSON.stringify({ repoKey: 'x' })), undefined)
  assert.deepEqual(parseRepoJson(JSON.stringify(repo)), repo)
})

// The statement these feed used to carry every field as a bind parameter and
// let COALESCE decide what to keep; the assignments now say it directly, so
// "keeps the column" means the key is simply not there. What each patch does to
// a real row is asserted in hub-store.test.mjs.

test('an empty patch assigns nothing but the timestamp', () => {
  assert.deepEqual(sessionPatchAssignments({}, 'now'), { updatedAt: 'now' })
})

test('null clears variant and lastError while values set them', () => {
  assert.deepEqual(sessionPatchAssignments({ variant: null, lastError: null }, 'now'), {
    variant: null,
    lastError: null,
    updatedAt: 'now'
  })
  assert.deepEqual(
    sessionPatchAssignments({ variant: 'high', lastError: 'boom' }, 'now'),
    { variant: 'high', lastError: 'boom', updatedAt: 'now' }
  )
})

test('pendingPromptCount 0 is a real update, unlike other falsy fields', () => {
  const assignments = sessionPatchAssignments(
    { pendingPromptCount: 0, model: '', title: '' },
    'now'
  )
  assert.equal(assignments.pendingPromptCount, 0)
  assert.ok(!('model' in assignments))
  assert.ok(!('title' in assignments))
})

test('a title is assigned as an expression, so the lock is checked per row', () => {
  const assignments = sessionPatchAssignments({ title: 'Chosen by OpenCode' }, 'now')
  // Not a plain string: the lock may be taken between the read and the write,
  // so the decision has to happen in the statement.
  assert.notEqual(typeof assignments.title, 'string')
  assert.ok(!('phase' in assignments))
})
