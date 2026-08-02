import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CLEANUP_IDLE_DAYS,
  MAX_SESSION_ATTACHMENTS,
  MAX_SESSION_PROMPT_LENGTH,
  MAX_SESSION_TITLE_LENGTH,
  attachmentUploadKey,
  cleanupCutoff,
  containerHintForRuntimeLifecycle,
  deriveDisplayTitle,
  deriveLastActivityAt,
  deriveSessionStatus,
  deriveSessionTitle,
  isAttachmentUploadKey,
  isCleanedLifecycle,
  isSessionAttachmentMime,
  isSessionPhase,
  normalizeAttachmentFilename,
  normalizeAttachmentKeys,
  normalizeSessionPrompt,
  promptAttachmentKey,
  promptAttachmentPrefix,
  runtimeLifecycleNeedsStatusQuery,
  runtimeStatusFromSessionCache,
  sessionNeedsLiveStatusQuery
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

const uploadKey = () => attachmentUploadKey(crypto.randomUUID())

test('attachment keys are optional and default to none', () => {
  assert.deepEqual(normalizeAttachmentKeys(undefined), [])
  assert.deepEqual(normalizeAttachmentKeys(null), [])
})

test('valid upload keys round-trip, bare or wrapped', () => {
  const [a, b] = [uploadKey(), uploadKey()]
  assert.deepEqual(normalizeAttachmentKeys([a, b]), [a, b])
  assert.deepEqual(normalizeAttachmentKeys([{ key: a }, { key: b }]), [a, b])
})

test('only keys this Hub could have minted are accepted', () => {
  assert.ok(isAttachmentUploadKey(uploadKey()))
  // Anything that could name another object in the bucket is refused.
  assert.equal(isAttachmentUploadKey('sessions/x/transcript'), false)
  assert.equal(isAttachmentUploadKey('uploads/../sessions/x'), false)
  assert.equal(isAttachmentUploadKey('uploads/'), false)
  assert.equal(isAttachmentUploadKey('uploads/not-a-uuid'), false)
  assert.equal(isAttachmentUploadKey(`${uploadKey()}/extra`), false)
  assert.equal(isAttachmentUploadKey(undefined), false)
})

test('malformed attachment lists reject the whole request', () => {
  assert.equal(normalizeAttachmentKeys('nope'), undefined)
  assert.equal(normalizeAttachmentKeys([null]), undefined)
  assert.equal(normalizeAttachmentKeys(['sessions/x/transcript']), undefined)
  assert.equal(normalizeAttachmentKeys([{ key: 42 }]), undefined)
  const key = uploadKey()
  // The same upload twice would be delivered twice and deleted once.
  assert.equal(normalizeAttachmentKeys([key, key]), undefined)
  assert.equal(
    normalizeAttachmentKeys(
      Array.from({ length: MAX_SESSION_ATTACHMENTS + 1 }, uploadKey)
    ),
    undefined
  )
})

test('attachment mime types are a closed set', () => {
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.ok(isSessionAttachmentMime(mime))
  }
  assert.equal(isSessionAttachmentMime('image/tiff'), false)
  assert.equal(isSessionAttachmentMime(undefined), false)
})

test('attachment filenames lose their paths and are bounded', () => {
  assert.equal(normalizeAttachmentFilename('../../etc/x.png'), 'x.png')
  assert.equal(
    normalizeAttachmentFilename('C:\\Users\\me\\shot.png'),
    'shot.png'
  )
  assert.equal(normalizeAttachmentFilename('n'.repeat(200)).length, 128)
  assert.equal(normalizeAttachmentFilename('a\u0000b\u001fc.png'), 'abc.png')
  assert.equal(normalizeAttachmentFilename(42), undefined)
  assert.equal(normalizeAttachmentFilename('   '), undefined)
})

test('attachment keys are per prompt and swept per session', () => {
  const key = promptAttachmentKey('s1', 'p1', 0)
  assert.equal(key, 'prompt-attachments/s1/p1/0')
  assert.ok(key.startsWith(promptAttachmentPrefix('s1')))
})

test('only idle and sleeping clear the status-query flag', () => {
  assert.equal(runtimeLifecycleNeedsStatusQuery('idle'), false)
  assert.equal(runtimeLifecycleNeedsStatusQuery('sleeping'), false)
  for (const lifecycle of [
    'busy',
    'waking',
    'quiescing',
    'checkpointing',
    'stopping',
    'error'
  ]) {
    assert.equal(runtimeLifecycleNeedsStatusQuery(lifecycle), true)
  }
})

test('container hints match what the list Stop button needs', () => {
  assert.equal(containerHintForRuntimeLifecycle('sleeping'), 'stopped')
  assert.equal(containerHintForRuntimeLifecycle('stopping'), 'stopped')
  assert.equal(containerHintForRuntimeLifecycle('quiescing'), 'stopping')
  assert.equal(containerHintForRuntimeLifecycle('idle'), 'running')
  assert.equal(containerHintForRuntimeLifecycle('busy'), 'running')
})

const readyInstance = {
  id: 'inst-1',
  name: 'test',
  provider: 'cloudflare',
  lifecycle: 'ready',
  createdAt: '2026-07-27T01:00:00.000Z',
  updatedAt: '2026-07-27T01:00:00.000Z'
}

function cachedSession(overrides = {}) {
  return {
    id: 'inst-1',
    instanceId: 'inst-1',
    provider: 'cloudflare',
    model: 'anthropic/claude-fable-5',
    title: 'Test',
    phase: 'working',
    pendingPromptCount: 0,
    statusQuery: false,
    runtimeLifecycle: 'sleeping',
    container: 'stopped',
    statusObservedAt: '2026-07-27T02:00:00.000Z',
    createdAt: '2026-07-27T01:00:00.000Z',
    updatedAt: '2026-07-27T02:00:00.000Z',
    ...overrides
  }
}

test('the list skips live query for cold idle and sleeping rows', () => {
  assert.equal(
    sessionNeedsLiveStatusQuery(cachedSession(), readyInstance),
    false
  )
  assert.equal(
    sessionNeedsLiveStatusQuery(
      cachedSession({ runtimeLifecycle: 'idle', container: 'running' }),
      readyInstance
    ),
    false
  )
})

test('unfinished dispatch and hot flags keep the list calibrating', () => {
  assert.equal(
    sessionNeedsLiveStatusQuery(
      cachedSession({ phase: 'queued', statusQuery: false }),
      readyInstance
    ),
    true
  )
  assert.equal(
    sessionNeedsLiveStatusQuery(
      cachedSession({ statusQuery: true, runtimeLifecycle: 'busy' }),
      readyInstance
    ),
    true
  )
  assert.equal(
    sessionNeedsLiveStatusQuery(
      cachedSession({
        statusObservedAt: undefined,
        runtimeLifecycle: undefined,
        container: undefined,
        statusQuery: false
      }),
      readyInstance
    ),
    true
  )
})

test('non-ready hub lifecycles must not use the runtime cache', () => {
  for (const lifecycle of [
    'deleting',
    'delete_failed',
    'cleaning',
    'cleaned',
    'clean_failed'
  ]) {
    const instance = { ...readyInstance, lifecycle }
    // A calibrated cold row would otherwise look cacheable — that was the bug.
    assert.equal(
      sessionNeedsLiveStatusQuery(
        cachedSession({ statusQuery: false, runtimeLifecycle: 'idle' }),
        instance
      ),
      true,
      `${lifecycle} must leave the cache path`
    )
    assert.equal(
      runtimeStatusFromSessionCache(cachedSession(), instance),
      undefined,
      `${lifecycle} must not build a cached runtime`
    )
  }
})

test('a filled runtime cache is enough to build a list runtime view', () => {
  const runtime = runtimeStatusFromSessionCache(cachedSession(), readyInstance)
  assert.deepEqual(runtime, {
    container: 'stopped',
    provider: 'cloudflare',
    deleting: false,
    platformRunning: false,
    lifecycle: 'sleeping',
    persistence: { hasBackup: false, trackedBackupCount: 0 }
  })
  assert.equal(
    runtimeStatusFromSessionCache(
      cachedSession({ statusObservedAt: undefined }),
      readyInstance
    ),
    undefined
  )
})

test('deriveSessionStatus still needs runtime.deleting for the deleting badge', () => {
  // The list must not serve a deleting instance from cache: cached runtimes
  // hardcode deleting:false, so the badge would stick on idle/sleeping.
  assert.equal(
    deriveSessionStatus('working', runtime('idle'), 'deleting'),
    'idle'
  )
  assert.equal(
    deriveSessionStatus('working', { ...runtime('idle'), deleting: true }, 'deleting'),
    'deleting'
  )
  assert.equal(
    deriveSessionStatus('working', runtime('sleeping'), 'cleaned'),
    'cleaned'
  )
})
