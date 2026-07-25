import assert from 'node:assert/strict'
import test from 'node:test'

import { REPOS, findRepo, isRepoKey } from '../src/repos.ts'

test('catalog is non-empty and importable (module-load validation passed)', () => {
  assert.ok(REPOS.length > 0)
})

test('findRepo and isRepoKey agree with the catalog', () => {
  for (const repo of REPOS) {
    assert.equal(findRepo(repo.repoKey), repo)
    assert.ok(isRepoKey(repo.repoKey))
  }
  assert.equal(findRepo('not-a-repo'), undefined)
  assert.equal(isRepoKey('not-a-repo'), false)
  assert.equal(isRepoKey(42), false)
  assert.equal(isRepoKey(undefined), false)
})

test('repo directories stay below /workspace with safe names', () => {
  for (const repo of REPOS) {
    assert.match(repo.repoKey, /^[a-z0-9][a-z0-9-]{0,63}$/)
    assert.ok(!repo.repoKey.includes('..'))
    assert.match(repo.cloneUrl, /^(?:https:\/\/|git@)/)
  }
})
