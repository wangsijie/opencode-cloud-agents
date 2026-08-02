import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildTranscriptMirror,
  deleteTranscriptMirror,
  getTranscriptMirror,
  isOpencodePlaceholderTitle,
  parseTranscriptMirror,
  putTranscriptMirror,
  summarizeSessionUsage,
  summarizeTranscriptMessages,
  transcriptMirrorKey,
  transcriptMirrorPrefix,
  transcriptMirrorSummary
} from '../src/transcript-mirror.ts'

function message(id, time) {
  return { info: { id, role: 'assistant', ...(time ? { time } : {}) }, parts: [] }
}

/** Assistant messages that reported no tokens still count as messages. */
function emptyUsage(assistantMessages) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    assistantMessages
  }
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
  assert.deepEqual(summarizeTranscriptMessages([]), {
    messageCount: 0,
    usage: emptyUsage(0)
  })
  assert.deepEqual(
    summarizeTranscriptMessages([
      message('msg_1', { created: 1_000 }),
      message('msg_2', { created: 2_000, completed: 3_000 })
    ]),
    {
      messageCount: 2,
      lastMessageAt: new Date(3_000).toISOString(),
      usage: emptyUsage(2)
    }
  )
  // A message still being generated has no completion time yet.
  assert.deepEqual(
    summarizeTranscriptMessages([message('msg_1', { created: 5_000 })]),
    {
      messageCount: 1,
      lastMessageAt: new Date(5_000).toISOString(),
      usage: emptyUsage(1)
    }
  )
  // Nor does one OpenCode reported without any clock at all.
  assert.deepEqual(summarizeTranscriptMessages([message('msg_1')]), {
    messageCount: 1,
    usage: emptyUsage(1)
  })
})

test('usage adds up assistant messages and ignores everything else', () => {
  const assistant = (cost, input, output) => ({
    info: {
      id: `msg_${input}`,
      role: 'assistant',
      cost,
      tokens: { input, output, reasoning: 1, cache: { read: 2, write: 3 } }
    },
    parts: []
  })
  const usage = summarizeSessionUsage([
    { info: { id: 'msg_0', role: 'user' }, parts: [] },
    assistant(0.01, 100, 20),
    assistant(0.02, 300, 40),
    // A message OpenCode reported without any accounting at all.
    { info: { id: 'msg_x', role: 'assistant' }, parts: [] }
  ])
  assert.deepEqual(usage, {
    inputTokens: 400,
    outputTokens: 60,
    reasoningTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 6,
    cost: 0.01 + 0.02,
    assistantMessages: 3
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
    lastMessageAt: new Date(1_000).toISOString(),
    usage: emptyUsage(1)
  })
})

test('only the exact not-yet-named stamp counts as a placeholder', () => {
  assert.ok(isOpencodePlaceholderTitle('New session - 2026-07-26T10:00:00.000Z'))
  assert.ok(isOpencodePlaceholderTitle('Child session - 2026-07-26T10:00:00.000Z'))
  // A generated or human title that merely resembles the stamp still wins.
  assert.ok(!isOpencodePlaceholderTitle('New session - flow cleanup'))
  assert.ok(!isOpencodePlaceholderTitle('Fix login error copy'))
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

test('a live export reads back as one, and an unknown reason degrades', () => {
  const base = {
    schemaVersion: 1,
    sessionId: 'session-1',
    opencodeSessionId: 'ses_1',
    mirroredAt: '2026-07-26T00:00:00.000Z',
    messages: []
  }
  assert.equal(parseTranscriptMirror({ ...base, reason: 'live' }).reason, 'live')
  // A mirror written by a newer deployment must still be readable, so an
  // unrecognized reason falls back rather than voiding the whole object.
  assert.equal(
    parseTranscriptMirror({ ...base, reason: 'telepathy' }).reason,
    'refresh'
  )
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
