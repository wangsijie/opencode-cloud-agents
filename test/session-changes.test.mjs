import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_DIFF_LENGTH,
  decodeGitStatusOutput,
  limitDiff,
  mergeChangedFiles,
  parseChangesScope,
  parseGitNameStatus,
  parseGitStatus,
  shellQuote
} from '../src/session-changes.ts'

test('shell quoting survives every metacharacter, including quotes', () => {
  assert.equal(shellQuote('plain'), `'plain'`)
  // The one character that can end the quoting is the one that has to work.
  assert.equal(shellQuote(`it's`), `'it'\\''s'`)
  assert.equal(shellQuote('$(rm -rf /) `x` && y'), `'$(rm -rf /) \`x\` && y'`)
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

test('base64-wrapped status decodes with its NUL separators intact', () => {
  const raw = ' M web/src/components/MessageList.tsx\0 M web/src/styles.css\0';
  // `base64` wraps long output in newline-terminated lines; the decoder must
  // not care where those line breaks fall.
  const encoded = Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/(.{20})/g, '$1\n');
  assert.equal(decodeGitStatusOutput(encoded), raw)
  assert.deepEqual(parseGitStatus(decodeGitStatusOutput(encoded)), [
    { path: 'web/src/components/MessageList.tsx', status: 'modified' },
    { path: 'web/src/styles.css', status: 'modified' }
  ])
  // Non-ASCII paths arrive as UTF-8 bytes and must come back as the same text.
  const utf8 = Buffer.from(' M docs/说明.md\0', 'utf8').toString('base64')
  assert.deepEqual(parseGitStatus(decodeGitStatusOutput(utf8)), [
    { path: 'docs/说明.md', status: 'modified' }
  ])
  assert.equal(decodeGitStatusOutput(''), '')
  assert.equal(decodeGitStatusOutput('\n'), '')
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

test('the scope query is a closed set, defaulting to the working tree', () => {
  assert.equal(parseChangesScope('branch'), 'branch')
  assert.equal(parseChangesScope('head'), 'head')
  // Anything else is the working tree rather than an error: the panel is a
  // read, and an unknown scope must not turn it into a 400.
  assert.equal(parseChangesScope(null), 'head')
  assert.equal(parseChangesScope('BRANCH'), 'head')
  assert.equal(parseChangesScope('origin/main'), 'head')
})

test('name-status parses the committed half, renames included', () => {
  const files = parseGitNameStatus(
    [
      'M',
      'src/app.ts',
      'A',
      'src/new.ts',
      'D',
      'src/gone.ts',
      'R100',
      'src/before.ts',
      'src/after.ts',
      ''
    ].join('\0')
  )
  assert.deepEqual(files, [
    { path: 'src/app.ts', status: 'modified' },
    { path: 'src/new.ts', status: 'added' },
    { path: 'src/gone.ts', status: 'deleted' },
    { path: 'src/after.ts', status: 'renamed', renamedFrom: 'src/before.ts' }
  ])
})

test('a file both committed and edited again is one row, not two', () => {
  const merged = mergeChangedFiles(
    [
      { path: 'src/new.ts', status: 'added' },
      { path: 'src/app.ts', status: 'modified' }
    ],
    [
      // The same file, uncommitted on top: the committed status is the one that
      // is true against the branch base.
      { path: 'src/new.ts', status: 'modified' },
      { path: 'notes.md', status: 'untracked' }
    ]
  )
  assert.deepEqual(merged, [
    { path: 'src/new.ts', status: 'added' },
    { path: 'src/app.ts', status: 'modified' },
    { path: 'notes.md', status: 'untracked' }
  ])
})
