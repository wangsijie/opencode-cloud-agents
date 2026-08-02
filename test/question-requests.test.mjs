import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeQuestionAction } from '../src/question-requests.ts'

test('a reply carries the request id and the answers', () => {
  const action = normalizeQuestionAction({
    requestID: 'qreq_01ABC',
    answers: [['Safari (macOS)'], ['Only the sidebar', 'typed detail']]
  })
  assert.deepEqual(action, {
    kind: 'reply',
    requestId: 'qreq_01ABC',
    answers: [['Safari (macOS)'], ['Only the sidebar', 'typed detail']]
  })
})

test('a reject carries only the request id', () => {
  assert.deepEqual(
    normalizeQuestionAction({ requestID: 'qreq_1', reject: true }),
    { kind: 'reject', requestId: 'qreq_1' }
  )
})

test('a reject that also carries answers is ambiguous and refused', () => {
  assert.equal(
    normalizeQuestionAction({ requestID: 'qreq_1', reject: true, answers: [['a']] }),
    undefined
  )
})

test('an unanswered question travels as an empty inner array', () => {
  const action = normalizeQuestionAction({
    requestID: 'qreq_1',
    answers: [['picked'], []]
  })
  assert.deepEqual(action?.answers, [['picked'], []])
})

test('a fully empty answer set is refused', () => {
  assert.equal(
    normalizeQuestionAction({ requestID: 'qreq_1', answers: [[], []] }),
    undefined
  )
  assert.equal(normalizeQuestionAction({ requestID: 'qreq_1', answers: [] }), undefined)
})

test('malformed bodies are refused', () => {
  assert.equal(normalizeQuestionAction(null), undefined)
  assert.equal(normalizeQuestionAction('qreq_1'), undefined)
  assert.equal(normalizeQuestionAction({ answers: [['a']] }), undefined)
  assert.equal(normalizeQuestionAction({ requestID: 'bad id!', answers: [['a']] }), undefined)
  assert.equal(normalizeQuestionAction({ requestID: 'qreq_1' }), undefined)
  assert.equal(
    normalizeQuestionAction({ requestID: 'qreq_1', answers: [['a', 42]] }),
    undefined
  )
  assert.equal(
    normalizeQuestionAction({ requestID: 'qreq_1', answers: ['a'] }),
    undefined
  )
  assert.equal(
    normalizeQuestionAction({ requestID: 'qreq_1', reject: 'yes' }),
    undefined
  )
})

test('oversized answer sets are refused', () => {
  assert.equal(
    normalizeQuestionAction({
      requestID: 'qreq_1',
      answers: [['x'.repeat(2_001)]]
    }),
    undefined
  )
  assert.equal(
    normalizeQuestionAction({
      requestID: 'qreq_1',
      answers: Array.from({ length: 33 }, () => ['a'])
    }),
    undefined
  )
  assert.equal(
    normalizeQuestionAction({
      requestID: 'qreq_1',
      answers: [Array.from({ length: 33 }, () => 'a')]
    }),
    undefined
  )
})
