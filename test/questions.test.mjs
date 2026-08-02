import assert from 'node:assert/strict'
import test from 'node:test'

import { answersFromPart, questionsFromPart } from '../web/src/questions.ts'

const part = (questions) => ({
  id: 'prt_1',
  type: 'tool',
  tool: 'question',
  state: { status: 'running', input: { questions } }
})

const ask = (extra) => ({
  question: 'Which fix should I take?',
  header: 'Approach',
  options: [{ label: 'Memoize', description: 'Smallest change' }],
  ...extra
})

test('an absent custom flag still accepts a typed answer', () => {
  // OpenCode's schema defaults `custom` to true and a model rarely sends it,
  // so an options-only card here would be the common case, not the rare one.
  const [question] = questionsFromPart(part([ask()]))
  assert.equal(question.custom, true)
})

test('only an explicit false restricts a question to its options', () => {
  assert.equal(questionsFromPart(part([ask({ custom: false })]))[0].custom, undefined)
  assert.equal(questionsFromPart(part([ask({ custom: true })]))[0].custom, true)
})

test('a non-boolean custom reads as the default', () => {
  for (const value of [null, 0, 'no', {}]) {
    assert.equal(questionsFromPart(part([ask({ custom: value })]))[0].custom, true)
  }
})

test('multiple is off unless it is exactly true', () => {
  assert.equal(questionsFromPart(part([ask()]))[0].multiple, undefined)
  assert.equal(questionsFromPart(part([ask({ multiple: 'yes' })]))[0].multiple, undefined)
  assert.equal(questionsFromPart(part([ask({ multiple: true })]))[0].multiple, true)
})

test('options keep their order and drop the unlabelled', () => {
  const [question] = questionsFromPart(
    part([
      ask({
        options: [
          { label: 'b', description: 'second' },
          { label: '' },
          { description: 'no label' },
          { label: 'a' }
        ]
      })
    ])
  )
  assert.deepEqual(question.options, [
    { label: 'b', description: 'second' },
    { label: 'a', description: '' }
  ])
})

test('a malformed entry voids the whole set', () => {
  // Answers are submitted positionally, so a card missing one question would
  // misalign every answer after it.
  assert.deepEqual(questionsFromPart(part([ask(), null])), [])
  assert.deepEqual(questionsFromPart(part([ask(), { question: '' }])), [])
  assert.deepEqual(questionsFromPart(part([ask(), { header: 'Orphan' }])), [])
})

test('a part with no questions yet reads as empty', () => {
  assert.deepEqual(questionsFromPart({ id: 'p', type: 'tool' }), [])
  assert.deepEqual(questionsFromPart(part(undefined)), [])
  assert.deepEqual(questionsFromPart(part('soon')), [])
})

test('a missing header is empty rather than absent', () => {
  assert.equal(questionsFromPart(part([ask({ header: undefined })]))[0].header, '')
  assert.equal(questionsFromPart(part([ask({ header: 7 })]))[0].header, '')
})

test('settled answers keep their per-question slots', () => {
  const settled = {
    id: 'prt_1',
    type: 'tool',
    state: { status: 'completed', metadata: { answers: [['Memoize'], [], ['Yes', 'No']] } }
  }
  assert.deepEqual(answersFromPart(settled), [['Memoize'], [], ['Yes', 'No']])
})

test('answers of the wrong shape are dropped, not guessed', () => {
  const settled = (answers) => ({
    id: 'prt_1',
    type: 'tool',
    state: { status: 'completed', metadata: { answers } }
  })
  assert.deepEqual(answersFromPart(settled([['ok', 3, null], 'nope'])), [['ok'], []])
  assert.equal(answersFromPart(settled('nope')), undefined)
  assert.equal(answersFromPart({ id: 'p', type: 'tool' }), undefined)
})
