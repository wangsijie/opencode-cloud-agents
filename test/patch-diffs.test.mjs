import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizePatch, turnDiffsByMessage } from '../web/src/patch-diffs.ts'

const diff = (file, additions, deletions) => ({
  file,
  patch: `Index: ${file}\n--- ${file}\n+++ ${file}\n@@ -1 +1 @@\n-old\n+new\n`,
  additions,
  deletions,
  status: 'modified'
})

const patchPart = (files) => ({
  id: 'prt_1',
  type: 'patch',
  hash: 'abc123',
  files
})

test('turn diffs are collected from user messages that carry them', () => {
  const byId = turnDiffsByMessage([
    { info: { id: 'msg_a', role: 'user', summary: { diffs: [] } }, parts: [] },
    {
      info: { id: 'msg_b', role: 'user', summary: { diffs: [diff('src/a.ts', 1, 2)] } },
      parts: []
    },
    { info: { id: 'msg_c', role: 'assistant', parentID: 'msg_b' }, parts: [] }
  ])
  assert.deepEqual([...byId.keys()], ['msg_b'])
})

test('a patch part is matched to the turn diff by path suffix', () => {
  const summary = summarizePatch(
    patchPart(['/workspace/repo/src/a.ts', '/workspace/repo/src/b.ts']),
    [diff('src/a.ts', 3, 17), diff('src/b.ts', 1, 0), diff('src/c.ts', 9, 9)]
  )
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['src/a.ts', 'src/b.ts']
  )
  assert.equal(summary.additions, 4)
  assert.equal(summary.deletions, 17)
  assert.equal(summary.hasDiff, true)
})

test('a directory suffix does not count as a path match', () => {
  const summary = summarizePatch(patchPart(['/workspace/repo/other-src/a.ts']), [
    diff('src/a.ts', 3, 17)
  ])
  assert.equal(summary.files[0].patch, undefined)
  assert.equal(summary.additions, 0)
})

test('a file with no diff behind it keeps a readable path', () => {
  const summary = summarizePatch(
    patchPart(['/workspace/repo/src/a.ts', '/workspace/repo/src/new.ts']),
    [diff('src/a.ts', 3, 17)]
  )
  assert.deepEqual(
    summary.files.map((file) => file.path),
    ['src/a.ts', 'src/new.ts']
  )
})

test('without any turn summary the paths still lose the mount point', () => {
  const summary = summarizePatch(patchPart(['/workspace/repo/src/a.ts']), undefined)
  assert.deepEqual(summary.files, [
    { path: 'repo/src/a.ts', additions: 0, deletions: 0 }
  ])
  assert.equal(summary.hasDiff, false)
})

test('a part with no files summarizes to nothing', () => {
  const summary = summarizePatch({ id: 'prt_2', type: 'patch' }, [])
  assert.deepEqual(summary.files, [])
})
