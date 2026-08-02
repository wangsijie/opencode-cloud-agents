import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_LINEAGE_DEPTH,
  isSafeOpencodeSessionId,
  walkSessionLineage
} from '../src/session-lineage.ts'

/** A reader over a fixed set of sessions, standing in for the container. */
const reader = (sessions) => async (id) => sessions[id]

test('a subagent resolves to the path from the root down to itself', async () => {
  const read = reader({
    root: { id: 'root', title: 'Fix the parser' },
    child: { id: 'child', title: 'Read the tests', agent: 'general', parentID: 'root' }
  })
  assert.deepEqual(await walkSessionLineage('child', 'root', read), [
    { id: 'root', title: 'Fix the parser' },
    { id: 'child', title: 'Read the tests', agent: 'general', parentID: 'root' }
  ])
})

test('the root itself is a path of one', async () => {
  const read = reader({ root: { id: 'root', title: 'Fix the parser' } })
  assert.deepEqual(await walkSessionLineage('root', 'root', read), [
    { id: 'root', title: 'Fix the parser' }
  ])
})

test('nesting is followed to whatever depth it has', async () => {
  const read = reader({
    root: { id: 'root', title: 'root' },
    a: { id: 'a', title: 'a', parentID: 'root' },
    b: { id: 'b', title: 'b', parentID: 'a' }
  })
  const lineage = await walkSessionLineage('b', 'root', read)
  assert.deepEqual(
    lineage.map((entry) => entry.id),
    ['root', 'a', 'b']
  )
})

/*
 * The three ways a walk fails are the whole point of the check: each one is an
 * id that does not belong to the session it was asked for, and answering with
 * a transcript anyway would be showing another conversation's history.
 */
test('a session that never reaches this root is not part of it', async () => {
  const read = reader({
    root: { id: 'root', title: 'root' },
    stranger: { id: 'stranger', title: 'stranger' }
  })
  assert.equal(await walkSessionLineage('stranger', 'root', read), undefined)
})

test('a session OpenCode does not know ends the walk', async () => {
  const read = reader({ root: { id: 'root', title: 'root' } })
  assert.equal(await walkSessionLineage('ghost', 'root', read), undefined)
})

test('a cycle is refused rather than walked to the depth cap', async () => {
  const read = reader({
    a: { id: 'a', title: 'a', parentID: 'b' },
    b: { id: 'b', title: 'b', parentID: 'a' }
  })
  assert.equal(await walkSessionLineage('a', 'root', read), undefined)
})

test('a chain longer than the cap is refused', async () => {
  const sessions = { root: { id: 'root', title: 'root' } }
  let parent = 'root'
  for (let depth = 0; depth <= MAX_LINEAGE_DEPTH + 1; depth += 1) {
    const id = `s${depth}`
    sessions[id] = { id, title: id, parentID: parent }
    parent = id
  }
  assert.equal(await walkSessionLineage(parent, 'root', reader(sessions)), undefined)
})

test('session ids are constrained before they reach a container URL', () => {
  assert.ok(isSafeOpencodeSessionId('ses_8f2a-1B_c'))
  assert.ok(!isSafeOpencodeSessionId(''))
  assert.ok(!isSafeOpencodeSessionId('ses/../etc'))
  assert.ok(!isSafeOpencodeSessionId('ses 1'))
  assert.ok(!isSafeOpencodeSessionId('a'.repeat(129)))
  assert.ok(!isSafeOpencodeSessionId(undefined))
})
