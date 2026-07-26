import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeRepoKey,
  repoDefinitionsFromGithub
} from '../src/github-catalog.ts'

function repo(overrides = {}) {
  return {
    name: 'logto',
    full_name: 'logto-io/logto',
    ssh_url: 'git@github.com:logto-io/logto.git',
    default_branch: 'master',
    permissions: { push: true },
    ...overrides
  }
}

test('repository keys become safe directory names', () => {
  assert.equal(normalizeRepoKey('Logto'), 'logto')
  assert.equal(normalizeRepoKey('my.repo_name'), 'my-repo-name')
  assert.equal(normalizeRepoKey('...'), '')
  assert.equal(normalizeRepoKey('a'.repeat(80)).length, 64)
  // A key is a path segment below /workspace, so traversal must not survive it.
  assert.equal(normalizeRepoKey('../etc'), 'etc')
})

test('a GitHub page becomes catalog entries', () => {
  assert.deepEqual(repoDefinitionsFromGithub([repo()]), [
    {
      repoKey: 'logto',
      displayName: 'logto-io/logto',
      cloneUrl: 'git@github.com:logto-io/logto.git',
      defaultBranch: 'master'
    }
  ])
})

test('repositories a session could not finish in are left out', () => {
  const dropped = [
    repo({ archived: true }),
    repo({ disabled: true }),
    // Read-only access: the agent could clone but never push its work.
    repo({ permissions: { push: false } }),
    repo({ permissions: undefined }),
    repo({ ssh_url: undefined }),
    repo({ default_branch: undefined }),
    // A name with nothing safe left in it, and no owner to fall back on.
    repo({ name: '...', full_name: '...' })
  ]
  assert.deepEqual(repoDefinitionsFromGithub(dropped), [])
  assert.deepEqual(repoDefinitionsFromGithub('not a page'), [])
})

test('two repositories with the same name are told apart by owner', () => {
  const repos = repoDefinitionsFromGithub([
    repo(),
    repo({ full_name: 'wangsijie/logto', ssh_url: 'git@github.com:wangsijie/logto.git' })
  ])
  assert.deepEqual(
    repos.map((entry) => entry.repoKey),
    ['logto', 'wangsijie-logto']
  )
})

test('keys already taken by an earlier page are not reused', () => {
  const existing = [
    {
      repoKey: 'logto',
      displayName: 'logto-io/logto',
      cloneUrl: 'git@github.com:logto-io/logto.git',
      defaultBranch: 'master'
    }
  ]
  assert.deepEqual(
    repoDefinitionsFromGithub([repo()], existing).map((entry) => entry.repoKey),
    ['logto-io-logto']
  )
})

test('a clone URL that is not a git remote is refused', () => {
  // The URL reaches a shell command, so anything but an ordinary remote is
  // dropped rather than escaped.
  assert.deepEqual(
    repoDefinitionsFromGithub([repo({ ssh_url: 'file:///etc/passwd; rm -rf /' })]),
    []
  )
})
