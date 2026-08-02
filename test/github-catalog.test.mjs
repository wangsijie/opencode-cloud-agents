import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeRepoKey,
  orderReposByLastUse,
  repoDefinitionsFromGithub,
  withReposInUse
} from '../src/github-catalog.ts'

function repo(overrides = {}) {
  return {
    name: 'webapp',
    full_name: 'acme-io/webapp',
    ssh_url: 'git@github.com:acme-io/webapp.git',
    default_branch: 'master',
    permissions: { push: true },
    ...overrides
  }
}

test('repository keys become safe directory names', () => {
  assert.equal(normalizeRepoKey('Webapp'), 'webapp')
  assert.equal(normalizeRepoKey('my.repo_name'), 'my-repo-name')
  assert.equal(normalizeRepoKey('...'), '')
  assert.equal(normalizeRepoKey('a'.repeat(80)).length, 64)
  // A key is a path segment below /workspace, so traversal must not survive it.
  assert.equal(normalizeRepoKey('../etc'), 'etc')
})

test('a GitHub page becomes catalog entries', () => {
  assert.deepEqual(repoDefinitionsFromGithub([repo()]), [
    {
      repoKey: 'webapp',
      displayName: 'acme-io/webapp',
      cloneUrl: 'git@github.com:acme-io/webapp.git',
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
    repo({ full_name: 'octocat/webapp', ssh_url: 'git@github.com:octocat/webapp.git' })
  ])
  assert.deepEqual(
    repos.map((entry) => entry.repoKey),
    ['webapp', 'octocat-webapp']
  )
})

test('keys already taken by an earlier page are not reused', () => {
  const existing = [
    {
      repoKey: 'webapp',
      displayName: 'acme-io/webapp',
      cloneUrl: 'git@github.com:acme-io/webapp.git',
      defaultBranch: 'master'
    }
  ]
  assert.deepEqual(
    repoDefinitionsFromGithub([repo()], existing).map((entry) => entry.repoKey),
    ['acme-io-webapp']
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

test('repositories with sessions sort first, newest use first', () => {
  const catalog = [{ repoKey: 'a' }, { repoKey: 'b' }, { repoKey: 'c' }]
  const ordered = orderReposByLastUse(
    catalog,
    new Map([
      ['a', '2026-07-01T00:00:00.000Z'],
      ['c', '2026-07-20T00:00:00.000Z']
    ])
  )
  assert.deepEqual(
    ordered.map((entry) => entry.repoKey),
    ['c', 'a', 'b']
  )
})

test('repositories nobody has used keep GitHub order', () => {
  const catalog = [{ repoKey: 'a' }, { repoKey: 'b' }]
  assert.deepEqual(orderReposByLastUse(catalog, new Map()), catalog)
})

test('use recorded for a repository that left the catalog is ignored', () => {
  const ordered = orderReposByLastUse(
    [{ repoKey: 'a' }, { repoKey: 'b' }],
    new Map([
      ['gone', '2026-07-25T00:00:00.000Z'],
      ['b', '2026-07-24T00:00:00.000Z']
    ])
  )
  assert.deepEqual(
    ordered.map((entry) => entry.repoKey),
    ['b', 'a']
  )
})

const definition = (repoKey, overrides = {}) => ({
  repoKey,
  displayName: `owner/${repoKey}`,
  cloneUrl: `git@github.com:owner/${repoKey}.git`,
  defaultBranch: 'main',
  ...overrides
})

test('a repository in use that GitHub stopped listing is kept', () => {
  const listed = [definition('a')]
  const merged = withReposInUse(listed, [definition('a'), definition('gone')])
  assert.deepEqual(
    merged.map((entry) => entry.repoKey),
    ['a', 'gone']
  )
})

test('the listed entry wins over the pinned one, and only once', () => {
  const listed = [definition('a', { displayName: 'owner/renamed' })]
  const merged = withReposInUse(listed, [definition('a'), definition('a')])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].displayName, 'owner/renamed')
})
