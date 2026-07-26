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
  deriveLastActivityAt,
  deriveSessionStatus,
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

const runtime = (lifecycle, deleting = false) => ({
  container: 'unknown',
  deleting,
  lifecycle,
  platformRunning: lifecycle !== 'sleeping',
  persistence: { hasBackup: false, trackedBackupCount: 0 }
})

test('session badges follow the runtime once dispatch has handed everything over', () => {
  assert.equal(deriveSessionStatus('working', runtime('busy')), 'working')
  assert.equal(deriveSessionStatus('working', runtime('idle')), 'idle')
  assert.equal(deriveSessionStatus('working', runtime('sleeping')), 'sleeping')
  assert.equal(deriveSessionStatus('working', runtime('waking')), 'starting')
  // Every step on the way down reads as sleeping; the UI hides the detail.
  for (const lifecycle of ['quiescing', 'checkpointing', 'stopping']) {
    assert.equal(deriveSessionStatus('working', runtime(lifecycle)), 'sleeping')
  }
})

test('unfinished dispatch outranks the container it is waking', () => {
  assert.equal(deriveSessionStatus('queued', runtime('sleeping')), 'queued')
  assert.equal(deriveSessionStatus('starting', runtime('waking')), 'starting')
  // A container that reached busy while dispatch is still starting is still
  // starting: the opening prompt has not been handed over yet.
  assert.equal(deriveSessionStatus('starting', runtime('busy')), 'starting')
})

test('failures and deletion outrank every other badge', () => {
  assert.equal(deriveSessionStatus('failed', runtime('idle')), 'failed')
  assert.equal(deriveSessionStatus('failed', runtime('sleeping')), 'failed')
  assert.equal(deriveSessionStatus('working', runtime('error')), 'error')
  assert.equal(deriveSessionStatus('failed', runtime('busy', true)), 'deleting')
  assert.equal(deriveSessionStatus('working', runtime('idle', true)), 'deleting')
})

test('last activity is the newest timestamp on the record', () => {
  const record = {
    createdAt: '2026-07-26T10:00:00.000Z',
    updatedAt: '2026-07-26T10:05:00.000Z'
  }
  assert.equal(deriveLastActivityAt(record), '2026-07-26T10:05:00.000Z')
  assert.equal(
    deriveLastActivityAt({ ...record, lastPromptAt: '2026-07-26T10:09:00.000Z' }),
    '2026-07-26T10:09:00.000Z'
  )
  // A record that has never moved falls back to its creation time.
  assert.equal(
    deriveLastActivityAt({ createdAt: record.createdAt, updatedAt: record.createdAt }),
    record.createdAt
  )
})

test('session working directories are the catalog checkout paths', () => {
  for (const repo of REPOS) {
    assert.equal(repoWorkspaceDirectory(repo), '/workspace/' + repo.repoKey)
  }
})
