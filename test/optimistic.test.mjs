import assert from 'node:assert/strict'
import test from 'node:test'

import {
  lastMessageId,
  reconcileOptimisticPrompts
} from '../web/src/optimistic.ts'

const userMessage = (id, text) => ({
  info: { id, role: 'user' },
  parts: [{ id: id + '-p', type: 'text', text }]
})

const assistantMessage = (id, text) => ({
  info: { id, role: 'assistant' },
  parts: [{ id: id + '-p', type: 'text', text }]
})

const prompt = (id, text, afterMessageId) => ({
  id,
  text,
  sentAt: '2026-07-26T00:00:00.000Z',
  ...(afterMessageId === undefined ? {} : { afterMessageId })
})

test('a prompt stays pending until its message appears', () => {
  const pending = [prompt('a', 'hello')]
  assert.deepEqual(reconcileOptimisticPrompts(pending, []), pending)
  assert.deepEqual(
    reconcileOptimisticPrompts(pending, [userMessage('msg_1', 'hello')]),
    []
  )
})

test('an unchanged result keeps its identity so callers do not re-render', () => {
  const pending = [prompt('a', 'hello')]
  assert.equal(reconcileOptimisticPrompts(pending, undefined), pending)
  assert.equal(
    reconcileOptimisticPrompts(pending, [assistantMessage('msg_1', 'hello')]),
    pending
  )
})

test('an empty queue is returned as-is', () => {
  const pending = []
  assert.equal(reconcileOptimisticPrompts(pending, [userMessage('m', 'x')]), pending)
})

test('the assistant echoing the prompt does not clear it', () => {
  const pending = [prompt('a', 'hello')]
  assert.deepEqual(
    reconcileOptimisticPrompts(pending, [assistantMessage('msg_1', 'hello')]),
    pending
  )
})

test('two identical prompts clear one bubble per arrival', () => {
  const pending = [prompt('a', 'again'), prompt('b', 'again')]
  const afterFirst = reconcileOptimisticPrompts(pending, [
    userMessage('msg_1', 'again')
  ])
  assert.deepEqual(
    afterFirst.map((entry) => entry.id),
    ['b']
  )
  assert.deepEqual(
    reconcileOptimisticPrompts(afterFirst, [
      userMessage('msg_1', 'again'),
      userMessage('msg_2', 'again')
    ]),
    []
  )
})

test('repeating something said earlier does not match the old message', () => {
  const history = [userMessage('msg_1', 'run the tests')]
  const pending = [prompt('a', 'run the tests', lastMessageId(history))]
  assert.deepEqual(reconcileOptimisticPrompts(pending, history), pending)
  assert.deepEqual(
    reconcileOptimisticPrompts(pending, [
      ...history,
      userMessage('msg_2', 'run the tests')
    ]),
    []
  )
})

test('surrounding whitespace and split text parts still match', () => {
  const pending = [prompt('a', 'hello world')]
  const message = {
    info: { id: 'msg_1', role: 'user' },
    parts: [
      { id: 'p1', type: 'text', text: 'hello ' },
      { id: 'p2', type: 'text', text: 'world\n' },
      { id: 'p3', type: 'step-start' }
    ]
  }
  assert.deepEqual(reconcileOptimisticPrompts(pending, [message]), [])
})

test('lastMessageId reports the newest message, or nothing', () => {
  assert.equal(lastMessageId(undefined), undefined)
  assert.equal(lastMessageId([]), undefined)
  assert.equal(
    lastMessageId([userMessage('msg_1', 'a'), userMessage('msg_2', 'b')]),
    'msg_2'
  )
})

test('file parts do not break text matching', () => {
  const message = {
    info: { id: 'msg_1', role: 'user' },
    parts: [
      { id: 'msg_1-f', type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
      { id: 'msg_1-p', type: 'text', text: 'look at this' }
    ]
  }
  assert.deepEqual(
    reconcileOptimisticPrompts([prompt('a', 'look at this')], [message]),
    []
  )
})

test('attachment previews on a prompt do not change reconciliation', () => {
  const pending = [
    { ...prompt('a', 'look at this'), attachments: [{ previewUrl: 'data:x' }] }
  ]
  assert.equal(reconcileOptimisticPrompts(pending, []), pending)
  assert.deepEqual(
    reconcileOptimisticPrompts(pending, [userMessage('msg_1', 'look at this')]),
    []
  )
})
