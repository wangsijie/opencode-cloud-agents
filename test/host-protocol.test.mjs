import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HEALTHZ_ROUTE,
  assertSessionId,
  matchSessionRoute,
  sessionRoutes
} from '../protocol/routes.ts'
import { SESSION_ID_PATTERN } from '../protocol/types.ts'

test('session id pattern accepts typical ids and rejects hostile ones', () => {
  assert.equal(SESSION_ID_PATTERN.test('inst-abc123'), true)
  assert.equal(SESSION_ID_PATTERN.test('A_b-C'), true)
  assert.equal(SESSION_ID_PATTERN.test(''), false)
  assert.equal(SESSION_ID_PATTERN.test('a/../b'), false)
  assert.equal(SESSION_ID_PATTERN.test('a b'), false)
  assert.equal(SESSION_ID_PATTERN.test('x'.repeat(65)), false)
})

test('assertSessionId throws on invalid ids', () => {
  assert.equal(assertSessionId('ok-id'), 'ok-id')
  assert.throws(() => assertSessionId('nope/../etc'))
})

test('route builders produce the documented paths', () => {
  assert.equal(HEALTHZ_ROUTE, '/healthz')
  assert.equal(sessionRoutes.state('s1'), '/sessions/s1')
  assert.equal(sessionRoutes.ensure('s1'), '/sessions/s1/ensure')
  assert.equal(sessionRoutes.stop('s1'), '/sessions/s1/stop')
  assert.equal(sessionRoutes.remove('s1'), '/sessions/s1')
  assert.equal(sessionRoutes.exec('s1'), '/sessions/s1/exec')
  assert.equal(sessionRoutes.writeBatch('s1'), '/sessions/s1/files/write-batch')
  assert.equal(sessionRoutes.readFile('s1'), '/sessions/s1/files/read')
  assert.equal(sessionRoutes.exists('s1'), '/sessions/s1/files/exists')
  assert.equal(sessionRoutes.listFiles('s1'), '/sessions/s1/files/list')
  assert.equal(sessionRoutes.opencodeStart('s1'), '/sessions/s1/opencode/start')
  assert.equal(sessionRoutes.snapshot('s1'), '/sessions/s1/snapshot')
  assert.equal(
    sessionRoutes.snapshotRestore('s1'),
    '/sessions/s1/snapshot/restore'
  )
})

test('proxy builder keeps path and query verbatim', () => {
  assert.equal(
    sessionRoutes.proxy('s1', '/event?directory=%2Fworkspace%2Frepo'),
    '/sessions/s1/proxy/event?directory=%2Fworkspace%2Frepo'
  )
  assert.equal(
    sessionRoutes.proxy('s1', 'session/abc/message'),
    '/sessions/s1/proxy/session/abc/message'
  )
})

test('matchSessionRoute dispatches every route', () => {
  assert.deepEqual(matchSessionRoute('GET', '/sessions/s1'), {
    sessionId: 's1',
    route: 'state'
  })
  assert.deepEqual(matchSessionRoute('DELETE', '/sessions/s1'), {
    sessionId: 's1',
    route: 'remove'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/ensure'), {
    sessionId: 's1',
    route: 'ensure'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/stop'), {
    sessionId: 's1',
    route: 'stop'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/exec'), {
    sessionId: 's1',
    route: 'exec'
  })
  assert.deepEqual(
    matchSessionRoute('POST', '/sessions/s1/files/write-batch'),
    { sessionId: 's1', route: 'write-batch' }
  )
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/files/read'), {
    sessionId: 's1',
    route: 'read'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/files/exists'), {
    sessionId: 's1',
    route: 'exists'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/files/list'), {
    sessionId: 's1',
    route: 'list'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/opencode/start'), {
    sessionId: 's1',
    route: 'opencode-start'
  })
  assert.deepEqual(matchSessionRoute('POST', '/sessions/s1/snapshot'), {
    sessionId: 's1',
    route: 'snapshot'
  })
  assert.deepEqual(
    matchSessionRoute('POST', '/sessions/s1/snapshot/restore'),
    { sessionId: 's1', route: 'snapshot-restore' }
  )
})

test('proxy routes match any method and preserve the tail path', () => {
  assert.deepEqual(matchSessionRoute('GET', '/sessions/s1/proxy/event'), {
    sessionId: 's1',
    route: 'proxy',
    proxyPath: '/event'
  })
  assert.deepEqual(
    matchSessionRoute('POST', '/sessions/s1/proxy/session/abc/message'),
    { sessionId: 's1', route: 'proxy', proxyPath: '/session/abc/message' }
  )
})

test('matchSessionRoute rejects bad ids, methods, and unknown tails', () => {
  assert.equal(matchSessionRoute('GET', '/sessions/a b'), null)
  assert.equal(matchSessionRoute('GET', '/sessions/'), null)
  assert.equal(matchSessionRoute('PUT', '/sessions/s1'), null)
  assert.equal(matchSessionRoute('GET', '/sessions/s1/ensure'), null)
  assert.equal(matchSessionRoute('POST', '/sessions/s1/unknown'), null)
  assert.equal(matchSessionRoute('POST', '/other/s1/exec'), null)
})
