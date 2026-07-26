import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateActivityClassifications,
  classifyLegacySessionStatus,
  classifyLegacySessionStatuses,
  classifyV2ActiveSessions,
  extractOpenCodeLocation,
  normalizeKnownOpenCodeLocations,
  normalizeOpenCodeLocation,
  openCodeLocationsFromGlobalSessions,
  queryOpenCodeActivity,
} from '../src/opencode-activity.ts'

test('normalizes and deduplicates known OpenCode locations', () => {
  assert.deepEqual(
    normalizeOpenCodeLocation({
      directory: ' /workspace/./repo/../app/ ',
      workspace: ' branch-1 ',
    }),
    { directory: '/workspace/app', workspace: 'branch-1' },
  )
  assert.equal(normalizeOpenCodeLocation({ directory: 'relative/path' }), undefined)
  assert.equal(normalizeOpenCodeLocation({ directory: '' }), undefined)

  assert.deepEqual(
    normalizeKnownOpenCodeLocations([
      { directory: '/workspace/' },
      { directory: '/workspace' },
      { directory: '/workspace', workspace: 'copy' },
      { directory: 'relative' },
    ]),
    [
      { directory: '/workspace' },
      { directory: '/workspace', workspace: 'copy' },
    ],
  )
})

test('extracts directory and workspace query parameters with a root fallback', () => {
  assert.deepEqual(
    extractOpenCodeLocation(
      'https://hub.example/gateway/demo/session?directory=%2Fworkspace%2Frepo%2F&workspace=copy-1',
      '/workspace',
    ),
    { directory: '/workspace/repo', workspace: 'copy-1' },
  )
  assert.deepEqual(
    extractOpenCodeLocation('/session/status', '/workspace'),
    { directory: '/workspace' },
  )
})

test('discovers legacy locations from the process-wide session listing', () => {
  assert.deepEqual(
    openCodeLocationsFromGlobalSessions([
      { id: 'root', directory: '/workspace' },
      { id: 'copy', directory: '/workspace/repo/', workspaceID: 'copy-1' },
      { id: 'duplicate', directory: '/workspace/repo', workspaceID: 'copy-1' },
      { id: 'invalid', directory: 'relative' },
      null,
    ]),
    [
      { directory: '/workspace' },
      { directory: '/workspace/repo', workspace: 'copy-1' },
    ],
  )
  assert.equal(openCodeLocationsFromGlobalSessions({ data: [] }), undefined)
})

test('classifies legacy busy, retry, idle, and unknown values', () => {
  assert.equal(classifyLegacySessionStatus({ type: 'busy' }), 'busy')
  assert.equal(classifyLegacySessionStatus({ type: 'retry', next: 123 }), 'retry')
  assert.equal(classifyLegacySessionStatus({ type: 'idle' }), 'idle')
  assert.equal(classifyLegacySessionStatus({ type: 'completed' }), 'unknown')
  assert.equal(classifyLegacySessionStatus(null), 'unknown')
})

test('classifies legacy session maps conservatively', () => {
  assert.deepEqual(classifyLegacySessionStatuses({}), {
    state: 'idle',
    activeSessionIds: [],
  })
  assert.deepEqual(
    classifyLegacySessionStatuses({
      idle: { type: 'idle' },
      retrying: { type: 'retry', attempt: 2, next: 123 },
      busy: { type: 'busy' },
    }),
    { state: 'active', activeSessionIds: ['busy', 'retrying'] },
  )
  assert.deepEqual(classifyLegacySessionStatuses({ future: { type: 'paused' } }), {
    state: 'unknown',
    activeSessionIds: [],
    reason: 'Unrecognized legacy status for: future',
  })
  assert.equal(
    classifyLegacySessionStatuses({ busy: { type: 'busy' }, future: {} }).state,
    'active',
  )
  assert.equal(classifyLegacySessionStatuses([]).state, 'unknown')
})

test('classifies the v2 active-session envelope by key presence', () => {
  assert.deepEqual(classifyV2ActiveSessions({ data: {} }), {
    state: 'idle',
    activeSessionIds: [],
  })
  assert.deepEqual(
    classifyV2ActiveSessions({
      data: { second: null, first: { type: 'running' } },
    }),
    { state: 'active', activeSessionIds: ['first', 'second'] },
  )
  assert.equal(classifyV2ActiveSessions({}).state, 'unknown')
  assert.equal(classifyV2ActiveSessions({ data: [] }).state, 'unknown')
})

test('aggregates with active > unknown > idle precedence', () => {
  assert.equal(
    aggregateActivityClassifications([
      { state: 'idle', activeSessionIds: [] },
      { state: 'unknown', activeSessionIds: [], reason: 'timeout' },
    ]).state,
    'unknown',
  )
  assert.deepEqual(
    aggregateActivityClassifications([
      { state: 'unknown', activeSessionIds: [], reason: 'timeout' },
      { state: 'active', activeSessionIds: ['session-2'] },
      { state: 'active', activeSessionIds: ['session-1', 'session-2'] },
    ]),
    { state: 'active', activeSessionIds: ['session-1', 'session-2'] },
  )
  assert.equal(aggregateActivityClassifications([]).state, 'unknown')
})

test('queries all legacy locations and the process-wide v2 source', async () => {
  const requests = []
  const snapshot = await queryOpenCodeActivity({
    baseUrl: 'http://opencode.internal:4096',
    locations: [
      { directory: '/workspace/' },
      { directory: '/workspace/project', workspace: 'copy-1' },
      { directory: '/workspace/project/', workspace: ' copy-1 ' },
    ],
    observedAt: 42,
    fetcher: async (request) => {
      const url = new URL(request.url)
      requests.push(url)
      if (url.pathname === '/api/session/active') {
        return Response.json({ data: {} })
      }
      if (url.searchParams.get('directory') === '/workspace/project') {
        return Response.json({ child: { type: 'retry', next: 999 } })
      }
      return Response.json({})
    },
  })

  assert.equal(snapshot.state, 'active')
  assert.deepEqual(snapshot.activeSessionIds, ['child'])
  assert.equal(snapshot.observedAt, 42)
  assert.equal(snapshot.legacy.length, 2)
  assert.equal(requests.length, 3)
  assert.equal(requests.filter((url) => url.pathname === '/session/status').length, 2)
  assert.equal(
    requests.find((url) => url.searchParams.get('directory') === '/workspace/project')
      ?.searchParams.get('workspace'),
    'copy-1',
  )
})

test('query failures are unknown unless another source is definitely active', async () => {
  const legacyFailure = async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/session/status') return new Response('no', { status: 503 })
    return Response.json({ data: {} })
  }
  const unknown = await queryOpenCodeActivity({
    baseUrl: 'http://opencode.internal:4096',
    locations: [{ directory: '/workspace' }],
    observedAt: 1,
    fetcher: legacyFailure,
  })
  assert.equal(unknown.state, 'unknown')

  const v2Active = await queryOpenCodeActivity({
    baseUrl: 'http://opencode.internal:4096',
    locations: [{ directory: '/workspace' }],
    observedAt: 2,
    fetcher: async (request) => {
      const url = new URL(request.url)
      if (url.pathname === '/session/status') throw new Error('socket closed')
      return Response.json({ data: { v2: { type: 'running' } } })
    },
  })
  assert.equal(v2Active.state, 'active')
  assert.deepEqual(v2Active.activeSessionIds, ['v2'])
})

test('an empty known-location set cannot produce an idle decision', async () => {
  const snapshot = await queryOpenCodeActivity({
    baseUrl: 'http://opencode.internal:4096',
    locations: [],
    observedAt: 3,
    fetcher: async () => Response.json({ data: {} }),
  })
  assert.equal(snapshot.state, 'unknown')
  assert.equal(snapshot.legacy.length, 0)
})
