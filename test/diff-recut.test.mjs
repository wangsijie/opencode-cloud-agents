import assert from 'node:assert/strict'
import test from 'node:test'

import { recutPatch } from '../web/src/diff-recut.ts'

/** A whole-file patch, the shape OpenCode writes: one hunk, every line in it. */
const wholeFile = (lines) =>
  ['Index: a.ts', '--- a.ts', '+++ a.ts', `@@ -1,1 +1,1 @@`, ...lines].join('\n')

const context = (n, from = 1) =>
  Array.from({ length: n }, (_, i) => ` line ${from + i}`)

test('a lone change keeps three lines on each side and drops the rest', () => {
  const recut = recutPatch(
    wholeFile([...context(10), '-line 11', '+changed', ...context(10, 12)])
  )
  const body = recut.patch.split('\n').filter((line) => line.startsWith('@@'))
  assert.deepEqual(body, ['@@ -8,7 +8,7 @@'])
  assert.ok(!recut.patch.includes('line 1\n'))
  assert.ok(recut.patch.includes(' line 8'))
  assert.ok(recut.patch.includes('-line 11'))
  assert.ok(recut.patch.includes(' line 14'))
})

test('both versions of the file come back whole', () => {
  const recut = recutPatch(
    wholeFile([' one', '-two', '+TWO', ' three', ...context(20, 4)])
  )
  assert.equal(recut.oldContent.split('\n').slice(0, 3).join(','), 'one,two,three')
  assert.equal(recut.newContent.split('\n').slice(0, 3).join(','), 'one,TWO,three')
  assert.equal(recut.oldContent.split('\n').length, 23)
})

test('changes further apart than the context become separate hunks', () => {
  const recut = recutPatch(
    wholeFile([
      '-first',
      '+FIRST',
      ...context(20, 2),
      '-last',
      '+LAST'
    ])
  )
  const headers = recut.patch.split('\n').filter((line) => line.startsWith('@@'))
  assert.equal(headers.length, 2)
})

test('changes close together stay in one hunk', () => {
  const recut = recutPatch(
    wholeFile([...context(5), '-a', '+A', ' mid', '-b', '+B', ...context(5, 8)])
  )
  const headers = recut.patch.split('\n').filter((line) => line.startsWith('@@'))
  assert.equal(headers.length, 1)
})

test('a patch that does not start at line one is left alone', () => {
  const patch = ['--- a.ts', '+++ a.ts', '@@ -40,3 +40,3 @@', ' a', '-b', '+B'].join(
    '\n'
  )
  assert.equal(recutPatch(patch), undefined)
})

test('a multi-hunk patch is left alone', () => {
  const patch = [
    '--- a.ts',
    '+++ a.ts',
    '@@ -1,3 +1,3 @@',
    ' a',
    '-b',
    '+B',
    '@@ -40,3 +40,3 @@',
    ' x',
    '-y',
    '+Y'
  ].join('\n')
  assert.equal(recutPatch(patch), undefined)
})

test('a patch with no changes has nothing to cut', () => {
  assert.equal(recutPatch(wholeFile([' a', ' b'])), undefined)
})
