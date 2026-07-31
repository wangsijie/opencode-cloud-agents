import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_ROOT,
  isSafeRepoDefinition,
  isSafeRepoKey,
  repoOwnerFromCloneUrl,
  workspaceDirectory
} from '../src/repos.ts'

function definition(overrides = {}) {
  return {
    repoKey: 'webapp',
    displayName: 'acme-io/webapp',
    cloneUrl: 'git@github.com:acme-io/webapp.git',
    defaultBranch: 'master',
    ...overrides
  }
}

test('a checkout path is derivable from the key alone', () => {
  // This is what lets a session outlive the catalog entry it was created from.
  assert.equal(workspaceDirectory('webapp'), `${WORKSPACE_ROOT}/webapp`)
})

test('a session with no repository works in the workspace root', () => {
  assert.equal(workspaceDirectory(), WORKSPACE_ROOT)
  assert.equal(workspaceDirectory(undefined), WORKSPACE_ROOT)
})

test('repository keys stay usable as a path segment', () => {
  for (const key of ['webapp', 'infra-tools', 'a', 'a0-b']) {
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

test('the owner comes out of both clone URL forms', () => {
  assert.equal(repoOwnerFromCloneUrl('git@github.com:acme-io/webapp.git'), 'acme-io')
  assert.equal(repoOwnerFromCloneUrl('git@github.com:acme-io/webapp'), 'acme-io')
  assert.equal(repoOwnerFromCloneUrl('https://github.com/acme-labs/repo.git'), 'acme-labs')
  assert.equal(repoOwnerFromCloneUrl('https://github.com/acme-labs/repo/'), 'acme-labs')
  // No owner segment → no owner, and identity overrides simply do not apply.
  assert.equal(repoOwnerFromCloneUrl('https://example.com/repo'), undefined)
  assert.equal(repoOwnerFromCloneUrl('https://gitlab.com/group/sub/repo'), undefined)
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
