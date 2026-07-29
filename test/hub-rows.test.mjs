import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseRepoJson,
  rowToInstance,
  rowToSession,
  sessionPatchBindings
} from '../src/hub-rows.ts'

const repo = {
  repoKey: 'opencode-cloud',
  displayName: 'wangsijie/opencode-cloud',
  cloneUrl: 'git@github.com:wangsijie/opencode-cloud.git',
  defaultBranch: 'master'
}

function fullRow() {
  return {
    id: 'inst-1111',
    name: 'silver-otter-abcd',
    repo_key: 'opencode-cloud',
    repo_json: JSON.stringify(repo),
    provider: 'docker',
    lifecycle: 'deleting',
    lifecycle_error: 'purge timed out',
    delete_operation_id: 'op-1',
    directory: '/workspace/opencode-cloud',
    model: 'anthropic/claude-fable-5',
    variant: 'high',
    title: 'Named by hand',
    title_locked: 1,
    opencode_session_id: 'ses_abc',
    phase: 'working',
    pending_prompt_count: 2,
    last_error: 'dispatch failed once',
    last_prompt_at: '2026-07-27T02:00:00.000Z',
    cleaned_at: null,
    unread_at: '2026-07-27T03:30:00.000Z',
    created_at: '2026-07-27T01:00:00.000Z',
    updated_at: '2026-07-27T04:00:00.000Z'
  }
}

function minimalRow() {
  return {
    ...fullRow(),
    repo_json: null,
    provider: 'cloudflare',
    lifecycle: 'ready',
    lifecycle_error: null,
    delete_operation_id: null,
    directory: null,
    variant: null,
    title_locked: 0,
    opencode_session_id: null,
    last_error: null,
    last_prompt_at: null,
    unread_at: null
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
    titleLocked: true,
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
    'titleLocked'
  ]) {
    assert.ok(!(key in session), `${key} should be absent`)
  }
})

test('a cleaned row carries its lifecycle and timestamp into the records', () => {
  const row = {
    ...minimalRow(),
    lifecycle: 'cleaned',
    cleaned_at: '2026-07-28T03:23:00.000Z'
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

test('an empty repo_key is a session with no repository, not an empty key', () => {
  const row = { ...minimalRow(), repo_key: '', directory: '/workspace' }
  const instance = rowToInstance(row)
  assert.ok(!('repoKey' in instance))
  assert.ok(!('repo' in instance))

  const session = rowToSession(row)
  assert.ok(!('repoKey' in session))
  assert.equal(session.directory, '/workspace')
})

test('repo_json that is broken or unsafe is dropped rather than trusted', () => {
  assert.equal(parseRepoJson(null), undefined)
  assert.equal(parseRepoJson('{not json'), undefined)
  assert.equal(parseRepoJson(JSON.stringify({ repoKey: 'x' })), undefined)
  assert.deepEqual(parseRepoJson(JSON.stringify(repo)), repo)
})

test('an empty patch keeps every column', () => {
  assert.deepEqual(sessionPatchBindings({}), [
    null, null, null, null, null, null,
    'keep', null,
    'keep', null
  ])
})

test('null clears variant and lastError while values set them', () => {
  assert.deepEqual(
    sessionPatchBindings({ variant: null, lastError: null }).slice(6),
    ['clear', null, 'clear', null]
  )
  assert.deepEqual(
    sessionPatchBindings({ variant: 'high', lastError: 'boom' }).slice(6),
    ['set', 'high', 'set', 'boom']
  )
})

test('pendingPromptCount 0 is a real update, unlike other falsy fields', () => {
  const bindings = sessionPatchBindings({
    pendingPromptCount: 0,
    model: '',
    title: ''
  })
  assert.equal(bindings[4], 0)
  assert.equal(bindings[1], null)
  assert.equal(bindings[2], null)
})
