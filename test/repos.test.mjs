import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_ROOT,
  isSafeRepoDefinition,
  isSafeRepoKey,
  repoWorkspaceDirectory
} from '../src/repos.ts'

function definition(overrides = {}) {
  return {
    repoKey: 'logto',
    displayName: 'logto-io/logto',
    cloneUrl: 'git@github.com:logto-io/logto.git',
    defaultBranch: 'master',
    ...overrides
  }
}

test('a checkout path is derivable from the key alone', () => {
  // This is what lets a session outlive the catalog entry it was created from.
  assert.equal(repoWorkspaceDirectory('logto'), `${WORKSPACE_ROOT}/logto`)
})

test('repository keys stay usable as a path segment', () => {
  for (const key of ['logto', 'v2ray-docker', 'a', 'a0-b']) {
    assert.ok(isSafeRepoKey(key), key)
  }
  for (const key of [
    '',
    '-leading',
    'Upper',
    'has space',
    '..',
    'a..b',
    'a/b',
    '$(x)',
    'a'.repeat(65),
    42,
    undefined
  ]) {
    assert.equal(isSafeRepoKey(key), false, String(key))
  }
})

test('catalog entries are validated before they can reach a shell', () => {
  assert.ok(isSafeRepoDefinition(definition()))
  assert.ok(isSafeRepoDefinition(definition({ cloneUrl: 'https://github.com/o/r.git' })))
  for (const broken of [
    undefined,
    null,
    'nope',
    definition({ repoKey: '../etc' }),
    definition({ displayName: '' }),
    definition({ defaultBranch: 'a branch' }),
    definition({ cloneUrl: 'file:///etc/passwd' }),
    definition({ cloneUrl: 'git@github.com:o/r.git; rm -rf /' })
  ]) {
    assert.equal(isSafeRepoDefinition(broken), false)
  }
})
