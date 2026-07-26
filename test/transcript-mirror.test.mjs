import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTranscriptMirror,
  deleteTranscriptMirror,
  getTranscriptMirror,
  parseTranscriptMirror,
  putTranscriptMirror,
  summarizeTranscriptMessages,
  transcriptMirrorKey,
  transcriptMirrorPrefix,
  transcriptMirrorSummary
} from '../src/transcript-mirror.ts'

function message(id, time) {
  return { info: { id, role: 'assistant', ...(time ? { time } : {}) }, parts: [] }
}

/** Enough of the R2 binding for the mirror's own reads and writes. */
function fakeBucket(initial = new Map()) {
  const objects = new Map(initial)
  return {
    objects,
    async put(key, body) {
      objects.set(key, body)
    },
    async get(key) {
      const body = objects.get(key)
      return body === undefined
        ? null
        : {
            json: async () => JSON.parse(body)
          }
    },
    async list({ prefix }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key }))
      }
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key)
      }
    }
  }
}

test('mirror keys stay under a per-session prefix', () => {
  assert.equal(transcriptMirrorPrefix('abc'), 'transcripts/abc/')
  assert.ok(transcriptMirrorKey('abc').startsWith(transcriptMirrorPrefix('abc')))
})

test('the summary follows the newest message, preferring its completion time', () => {
  assert.deepEqual(summarizeTranscriptMessages([]), { messageCount: 0 })
  assert.deepEqual(
    summarizeTranscriptMessages([
      message('msg_1', { created: 1_000 }),
      message('msg_2', { created: 2_000, completed: 3_000 })
    ]),
    { messageCount: 2, lastMessageAt: new Date(3_000).toISOString() }
  )
  // A message still being generated has no completion time yet.
  assert.deepEqual(
    summarizeTranscriptMessages([message('msg_1', { created: 5_000 })]),
    { messageCount: 1, lastMessageAt: new Date(5_000).toISOString() }
  )
  // Nor does one OpenCode reported without any clock at all.
  assert.deepEqual(summarizeTranscriptMessages([message('msg_1')]), {
    messageCount: 1
  })
})

test('a built mirror carries its own summary', () => {
  const mirror = buildTranscriptMirror({
    sessionId: 'session-1',
    opencodeSessionId: 'ses_1',
    reason: 'idle-stop',
    mirroredAt: '2026-07-26T00:00:00.000Z',
    messages: [message('msg_1', { created: 1_000 })]
  })
  assert.equal(mirror.messageCount, 1)
  assert.deepEqual(transcriptMirrorSummary(mirror), {
    opencodeSessionId: 'ses_1',
    mirroredAt: '2026-07-26T00:00:00.000Z',
    reason: 'idle-stop',
    messageCount: 1,
    lastMessageAt: new Date(1_000).toISOString()
  })
})

test('anything that is not a current-schema mirror reads as no mirror', () => {
  const mirror = buildTranscriptMirror({
    sessionId: 'session-1',
    opencodeSessionId: 'ses_1',
    reason: 'refresh',
    mirroredAt: '2026-07-26T00:00:00.000Z',
    messages: []
  })
  assert.ok(parseTranscriptMirror(mirror))
  for (const broken of [
    undefined,
    null,
    'nope',
    [],
    { ...mirror, schemaVersion: 99 },
    { ...mirror, messages: 'lots' },
    { ...mirror, opencodeSessionId: undefined }
  ]) {
    assert.equal(parseTranscriptMirror(broken), undefined)
  }
})

test('malformed messages are dropped rather than failing the whole read', () => {
  const parsed = parseTranscriptMirror({
    schemaVersion: 1,
    sessionId: 'session-1',
    opencodeSessionId: 'ses_1',
    mirroredAt: '2026-07-26T00:00:00.000Z',
    reason: 'refresh',
    messages: [message('msg_1'), null, { parts: [] }]
  })
  assert.equal(parsed.messages.length, 1)
  // The summary is recomputed from what survived, not trusted from the object.
  assert.equal(parsed.messageCount, 1)
})

test('a mirror round-trips through the bucket', async () => {
  const bucket = fakeBucket()
  const mirror = buildTranscriptMirror({
    sessionId: 'session-1',
    opencodeSessionId: 'ses_1',
    reason: 'idle-stop',
    mirroredAt: '2026-07-26T00:00:00.000Z',
    messages: [message('msg_1', { created: 1_000 })]
  })
  await putTranscriptMirror(bucket, mirror)
  assert.deepEqual(await getTranscriptMirror(bucket, 'session-1'), mirror)
  assert.equal(await getTranscriptMirror(bucket, 'session-2'), undefined)
})

test('a mirror stored under another session is not served', async () => {
  const bucket = fakeBucket(
    new Map([
      [
        transcriptMirrorKey('session-1'),
        JSON.stringify(
          buildTranscriptMirror({
            sessionId: 'session-2',
            opencodeSessionId: 'ses_2',
            reason: 'refresh',
            mirroredAt: '2026-07-26T00:00:00.000Z',
            messages: []
          })
        )
      ]
    ])
  )
  assert.equal(await getTranscriptMirror(bucket, 'session-1'), undefined)
})

test('deletion sweeps the session prefix and nothing else', async () => {
  const bucket = fakeBucket(
    new Map([
      [transcriptMirrorKey('session-1'), '{}'],
      ['transcripts/session-1/older.json', '{}'],
      [transcriptMirrorKey('session-2'), '{}'],
      ['backups/backup-1/meta.json', '{}']
    ])
  )
  await deleteTranscriptMirror(bucket, 'session-1')
  assert.deepEqual(
    [...bucket.objects.keys()].sort(),
    ['backups/backup-1/meta.json', transcriptMirrorKey('session-2')].sort()
  )
})
