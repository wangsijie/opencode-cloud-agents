import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MODEL_REF,
  MODEL_OPTIONS,
  findModel,
  isModelRef,
  parseModelRef
} from '../src/opencode-config.ts'
import {
  MAX_SESSION_PROMPT_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  deriveSessionTitle,
  isSessionPhase,
  normalizeSessionPrompt
} from '../src/sessions.ts'
import { REPOS, repoWorkspaceDirectory } from '../src/repos.ts'

test('model catalog exposes every configured provider model', () => {
  assert.ok(MODEL_OPTIONS.length > 0)
  for (const option of MODEL_OPTIONS) {
    assert.equal(option.id, option.providerID + '/' + option.modelID)
    assert.equal(findModel(option.id), option)
    assert.ok(isModelRef(option.id))
  }
  assert.ok(isModelRef(DEFAULT_MODEL_REF))
})

test('model references keep slashes inside the model id', () => {
  // Model ids such as `ag/gemini-3.6-flash-high` contain slashes, so only the
  // first segment may be treated as the provider.
  const nested = MODEL_OPTIONS.find((option) => option.modelID.includes('/'))
  assert.ok(nested, 'expected at least one model id containing a slash')
  assert.deepEqual(parseModelRef(nested.id), {
    providerID: nested.providerID,
    modelID: nested.modelID
  })
})

test('unknown model references are rejected rather than forwarded', () => {
  assert.equal(isModelRef('nope/nope'), false)
  assert.equal(isModelRef(''), false)
  assert.equal(isModelRef(undefined), false)
  assert.equal(parseModelRef('nope/nope'), undefined)
})

test('session titles come from the first non-empty prompt line', () => {
  assert.equal(deriveSessionTitle('\n\n  修复 lint  \n更多说明'), '修复 lint')
  assert.equal(deriveSessionTitle('   '), 'Untitled session')
  const long = 'a'.repeat(MAX_SESSION_TITLE_LENGTH + 40)
  const title = deriveSessionTitle(long)
  assert.equal(title.length, MAX_SESSION_TITLE_LENGTH)
  assert.ok(title.endsWith('…'))
})

test('prompts are trimmed, required and bounded', () => {
  assert.equal(normalizeSessionPrompt('  hi  '), 'hi')
  assert.equal(normalizeSessionPrompt('   '), undefined)
  assert.equal(normalizeSessionPrompt(undefined), undefined)
  assert.equal(normalizeSessionPrompt(42), undefined)
  assert.equal(
    normalizeSessionPrompt('a'.repeat(MAX_SESSION_PROMPT_LENGTH + 1)),
    undefined
  )
  assert.equal(
    normalizeSessionPrompt('a'.repeat(MAX_SESSION_PROMPT_LENGTH))?.length,
    MAX_SESSION_PROMPT_LENGTH
  )
})

test('session phases are a closed set', () => {
  for (const phase of ['queued', 'starting', 'working', 'failed']) {
    assert.ok(isSessionPhase(phase))
  }
  assert.equal(isSessionPhase('running'), false)
  assert.equal(isSessionPhase(undefined), false)
})

test('session working directories are the catalog checkout paths', () => {
  for (const repo of REPOS) {
    assert.equal(repoWorkspaceDirectory(repo), '/workspace/' + repo.repoKey)
  }
})
