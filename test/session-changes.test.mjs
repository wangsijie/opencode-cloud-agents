import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_DIFF_LENGTH,
  isSafeBranchName,
  limitDiff,
  normalizeCommitMessage,
  parseGitStatus,
  parsePullRequestUrl,
  resolvePublishBranch,
  sessionPublishBranch,
  shellQuote
} from '../src/session-changes.ts'

test('shell quoting survives every metacharacter, including quotes', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  // The one character that can end the quoting is the one that has to work.
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('$(rm -rf /) `x` && y'), `'$(rm -rf /) \`x\` && y'`)
})

test('branch names accept what a person types and refuse what git tolerates', () => {
  for (const branch of ['opencode/amber-otter', 'fix-1', 'a.b_c-d/e']) {
    assert.ok(isSafeBranchName(branch), branch)
  }
  for (const branch of [
    '',
    '-leading-dash',
    'has space',
    'a..b',
    'trailing/',
    'trailing.',
    'x.lock',
    'semi;colon',
    '$(x)',
    'a//b',
    42,
    undefined
  ]) {
    assert.equal(isSafeBranchName(branch), false, String(branch))
  }
})

test('publishing never lands on the default branch by accident', () => {
  // Still on the branch the clone landed on: move to the session's own branch.
  assert.equal(
    resolvePublishBranch({
      sessionId: 'amber-otter-4f2a',
      currentBranch: 'master',
      defaultBranch: 'master'
    }),
    sessionPublishBranch('amber-otter-4f2a')
  )
  // A second publish adds to the branch the first one made.
  assert.equal(
    resolvePublishBranch({
      sessionId: 'amber-otter-4f2a',
      currentBranch: 'opencode/amber-otter-4f2a',
      defaultBranch: 'master'
    }),
    'opencode/amber-otter-4f2a'
  )
  // A detached HEAD is not a branch to keep publishing onto.
  assert.equal(
    resolvePublishBranch({
      sessionId: 'amber-otter-4f2a',
      currentBranch: 'HEAD',
      defaultBranch: 'master'
    }),
    sessionPublishBranch('amber-otter-4f2a')
  )
  assert.equal(
    resolvePublishBranch({
      sessionId: 'amber-otter-4f2a',
      currentBranch: 'master',
      defaultBranch: 'master',
      requested: 'release/1.2'
    }),
    'release/1.2'
  )
})

test('commit messages are trimmed per line and bounded', () => {
  assert.equal(normalizeCommitMessage('  Fix the thing  \n\n  Body  \n'), 'Fix the thing\n\n  Body')
  assert.equal(normalizeCommitMessage('   '), undefined)
  assert.equal(normalizeCommitMessage(42), undefined)
  assert.equal(normalizeCommitMessage('x'.repeat(4001)), undefined)
})

test('porcelain status parses NUL records, including renames', () => {
  const files = parseGitStatus(
    [
      ' M src/app.ts',
      'A  src/new.ts',
      ' D src/gone.ts',
      '?? notes.md',
      'R  src/after.ts',
      'src/before.ts',
      'UU src/conflict.ts',
      ''
    ].join('\0')
  )
  assert.deepEqual(files, [
    { path: 'src/app.ts', status: 'modified' },
    { path: 'src/new.ts', status: 'added' },
    { path: 'src/gone.ts', status: 'deleted' },
    { path: 'notes.md', status: 'untracked' },
    { path: 'src/after.ts', status: 'renamed', renamedFrom: 'src/before.ts' },
    { path: 'src/conflict.ts', status: 'conflicted' }
  ])
})

test('a path with a space or a quote survives parsing intact', () => {
  const files = parseGitStatus(` M src/a file's name.ts\0`)
  assert.deepEqual(files, [
    { path: `src/a file's name.ts`, status: 'modified' }
  ])
})

test('an oversized diff is cut, and says so', () => {
  assert.deepEqual(limitDiff('small'), { diff: 'small', diffTruncated: false })
  const big = limitDiff('x'.repeat(MAX_DIFF_LENGTH + 10))
  assert.equal(big.diff.length, MAX_DIFF_LENGTH)
  assert.equal(big.diffTruncated, true)
})

test('the pull request URL is found in whatever gh printed around it', () => {
  assert.equal(
    parsePullRequestUrl(
      'Warning: 3 uncommitted changes\nhttps://github.com/logto-io/logto/pull/42\n'
    ),
    'https://github.com/logto-io/logto/pull/42'
  )
  // The refusal to open a second pull request names the existing one.
  assert.equal(
    parsePullRequestUrl(
      'a pull request for branch "opencode/x" already exists: https://github.com/o/r/pull/7'
    ),
    'https://github.com/o/r/pull/7'
  )
  assert.equal(parsePullRequestUrl('nothing here'), undefined)
})
