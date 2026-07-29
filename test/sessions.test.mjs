import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLEANUP_IDLE_DAYS,
  MAX_SESSION_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENTS,
  MAX_SESSION_PROMPT_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  cleanupCutoff,
  deriveDisplayTitle,
  deriveLastActivityAt,
  deriveSessionStatus,
  deriveSessionTitle,
  isCleanedLifecycle,
  isSessionPhase,
  normalizeSessionAttachments,
  normalizeSessionPrompt,
  promptAttachmentKey,
  promptAttachmentPrefix
} from '../src/sessions.ts'

// The model catalog's own behaviour is covered in model-catalog.test.mjs,
// against a fixture config the way the runtime now derives it from settings.

test('session titles come from the first non-empty prompt line', () => {
  assert.equal(deriveSessionTitle('\n\n  Fix lint  \nmore notes'), 'Fix lint')
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
  for (const phase of ['queued', 'starting', 'working', 'failed', 'lost']) {
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

test('a lost conversation outranks whatever the container is doing', () => {
  // The container is fine — it just no longer holds this conversation, so its
  // own state says nothing worth showing.
  assert.equal(deriveSessionStatus('lost', runtime('idle')), 'lost')
  assert.equal(deriveSessionStatus('lost', runtime('busy')), 'lost')
  assert.equal(deriveSessionStatus('lost', runtime('sleeping')), 'lost')
  assert.equal(deriveSessionStatus('lost', runtime('error')), 'lost')
  // Deletion still wins: the session is about to stop existing either way.
  assert.equal(deriveSessionStatus('lost', runtime('idle', true)), 'deleting')
})

test('a cleaned lifecycle outranks everything except deletion', () => {
  for (const lifecycle of ['cleaning', 'cleaned', 'clean_failed']) {
    // Neither the phase nor the runtime says anything truer than "cleaned":
    // the container behind them no longer exists.
    assert.equal(deriveSessionStatus('working', runtime('sleeping'), lifecycle), 'cleaned')
    assert.equal(deriveSessionStatus('failed', runtime('error'), lifecycle), 'cleaned')
    assert.equal(deriveSessionStatus('lost', runtime('idle'), lifecycle), 'cleaned')
    // Deleting a cleaned session still reads as deleting.
    assert.equal(deriveSessionStatus('working', runtime('idle', true), lifecycle), 'deleting')
  }
  // The default lifecycle changes nothing for existing callers.
  assert.equal(deriveSessionStatus('working', runtime('busy'), 'ready'), 'working')
})

test('the cleaned lifecycle family is a closed set', () => {
  for (const lifecycle of ['cleaning', 'cleaned', 'clean_failed']) {
    assert.ok(isCleanedLifecycle(lifecycle))
  }
  for (const lifecycle of ['ready', 'deleting', 'delete_failed']) {
    assert.equal(isCleanedLifecycle(lifecycle), false)
  }
})

test('the cleanup cutoff is exactly the idle window back from now', () => {
  const now = new Date('2026-07-29T12:00:00.000Z')
  assert.equal(
    cleanupCutoff(now),
    new Date(now.getTime() - CLEANUP_IDLE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  )
  assert.equal(cleanupCutoff(now), '2026-07-22T12:00:00.000Z')
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

test('OpenCode may rename a session, a human outranks it', () => {
  const record = { title: 'tweak the login page error copy', createdAt: 'x', updatedAt: 'x' }
  // Nothing mirrored yet: the opening prompt is all there is to go on.
  assert.equal(deriveDisplayTitle(record), record.title)
  assert.equal(
    deriveDisplayTitle(record, { opencodeTitle: 'Fix login error copy' }),
    'Fix login error copy'
  )
  assert.equal(
    deriveDisplayTitle(
      { ...record, titleLocked: true },
      { opencodeTitle: 'Fix login error copy' }
    ),
    record.title
  )
  // The stamp OpenCode puts on a not-yet-named session is not a rename: the
  // prompt-derived label holds until a real title arrives.
  assert.equal(
    deriveDisplayTitle(record, {
      opencodeTitle: 'New session - 2026-07-26T10:00:00.000Z'
    }),
    record.title
  )
})

// A base64 string whose decoded size is exactly `bytes`. The content never
// matters to normalization, so length is all that is constructed.
const base64OfSize = (bytes) => {
  const whole = Math.floor(bytes / 3)
  const rest = bytes % 3
  return (
    'AAAA'.repeat(whole) + (rest === 0 ? '' : rest === 1 ? 'AA==' : 'AAA=')
  )
}

test('attachments are optional and default to none', () => {
  assert.deepEqual(normalizeSessionAttachments(undefined), [])
  assert.deepEqual(normalizeSessionAttachments(null), [])
})

test('valid attachments round-trip with cleaned filenames', () => {
  const result = normalizeSessionAttachments([
    { mime: 'image/png', filename: 'shot.png', data: base64OfSize(9) },
    { mime: 'image/jpeg', data: base64OfSize(10) }
  ])
  assert.equal(result.length, 2)
  assert.equal(result[0].filename, 'shot.png')
  assert.equal(result[1].filename, undefined)
})

test('attachment filenames lose their paths and are bounded', () => {
  const [a] = normalizeSessionAttachments([
    { mime: 'image/png', filename: '../../etc/x.png', data: base64OfSize(3) }
  ])
  assert.equal(a.filename, 'x.png')
  const [b] = normalizeSessionAttachments([
    { mime: 'image/png', filename: 'C:\\Users\\me\\shot.png', data: base64OfSize(3) }
  ])
  assert.equal(b.filename, 'shot.png')
  const [c] = normalizeSessionAttachments([
    { mime: 'image/png', filename: 'n'.repeat(200), data: base64OfSize(3) }
  ])
  assert.equal(c.filename.length, 128)
})

test('malformed attachments reject the whole request', () => {
  const png = (data) => [{ mime: 'image/png', data }]
  assert.equal(normalizeSessionAttachments('nope'), undefined)
  assert.equal(normalizeSessionAttachments([null]), undefined)
  assert.equal(
    normalizeSessionAttachments([{ mime: 'image/tiff', data: base64OfSize(3) }]),
    undefined
  )
  assert.equal(normalizeSessionAttachments(png('')), undefined)
  assert.equal(normalizeSessionAttachments(png('not base64!!')), undefined)
  assert.equal(normalizeSessionAttachments(png('AAA')), undefined)
  assert.equal(normalizeSessionAttachments(png('====')), undefined)
})

test('attachment size and count limits hold', () => {
  const oversized = base64OfSize(MAX_SESSION_ATTACHMENT_BYTES + 3)
  assert.equal(
    normalizeSessionAttachments([{ mime: 'image/png', data: oversized }]),
    undefined
  )
  const atLimit = base64OfSize(MAX_SESSION_ATTACHMENT_BYTES)
  assert.equal(
    normalizeSessionAttachments([{ mime: 'image/png', data: atLimit }]).length,
    1
  )
  const one = { mime: 'image/png', data: base64OfSize(3) }
  assert.equal(
    normalizeSessionAttachments(Array(MAX_SESSION_ATTACHMENTS + 1).fill(one)),
    undefined
  )
  // Three near-limit images pass the per-image cap but land over the total.
  const nearLimit = { mime: 'image/png', data: atLimit }
  assert.equal(
    normalizeSessionAttachments([nearLimit, nearLimit, nearLimit]),
    undefined
  )
})

test('attachment keys are per prompt and swept per session', () => {
  const key = promptAttachmentKey('s1', 'p1', 0)
  assert.equal(key, 'prompt-attachments/s1/p1/0')
  assert.ok(key.startsWith(promptAttachmentPrefix('s1')))
})
