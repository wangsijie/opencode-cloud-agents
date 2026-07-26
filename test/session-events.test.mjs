import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SseFrameBuffer,
  eventSessionId,
  frameBelongsToSession,
  sseFrame,
  sseFrameData
} from '../src/session-events.ts'

test('frames are split on the blank line, in either newline style', () => {
  const buffer = new SseFrameBuffer()
  assert.deepEqual(buffer.push('event: a\ndata: 1\n\nevent: b\ndata: 2\n\n'), [
    'event: a\ndata: 1',
    'event: b\ndata: 2'
  ])
  assert.deepEqual(buffer.push('event: c\r\ndata: 3\r\n\r\n'), [
    'event: c\r\ndata: 3'
  ])
})

test('a frame split across chunks is held until it is complete', () => {
  const buffer = new SseFrameBuffer()
  // The container's writes have nothing to do with frame boundaries, so a read
  // routinely ends mid-frame.
  assert.deepEqual(buffer.push('data: {"id":"a"'), [])
  assert.deepEqual(buffer.push('}\n'), [])
  assert.deepEqual(buffer.push('\ndata: {"id":"b"}\n\n'), [
    'data: {"id":"a"}',
    'data: {"id":"b"}'
  ])
})

test('trailing bytes stay buffered rather than being parsed as a frame', () => {
  const buffer = new SseFrameBuffer()
  assert.deepEqual(buffer.push('data: 1\n\ndata: partial'), ['data: 1'])
  assert.deepEqual(buffer.push('\n\n'), ['data: partial'])
})

test('data lines are unwrapped, and multi-line data is rejoined', () => {
  assert.equal(sseFrameData('event: x\ndata: {"a":1}'), '{"a":1}')
  // Exactly one leading space is part of the framing, not the payload.
  assert.equal(sseFrameData('data:  padded'), ' padded')
  assert.equal(sseFrameData('data: line1\ndata: line2'), 'line1\nline2')
  assert.equal(sseFrameData('event: ping'), undefined)
  assert.equal(sseFrameData(': keep-alive'), undefined)
})

test('the session id comes from the event properties', () => {
  assert.equal(
    eventSessionId({ type: 'message.updated', properties: { sessionID: 'ses_1' } }),
    'ses_1'
  )
  // Server-wide events carry no session and must not be attributed to one.
  assert.equal(eventSessionId({ type: 'server.connected', properties: {} }), undefined)
  assert.equal(eventSessionId({ type: 'x' }), undefined)
  assert.equal(eventSessionId(null), undefined)
  assert.equal(eventSessionId('nope'), undefined)
})

test('only the watched session frames are forwarded', () => {
  const mine = 'data: ' + JSON.stringify({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_mine', part: { id: 'prt_1' } }
  })
  const theirs = 'data: ' + JSON.stringify({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_other' }
  })
  assert.equal(frameBelongsToSession(mine, 'ses_mine'), true)
  assert.equal(frameBelongsToSession(theirs, 'ses_mine'), false)
  // Keep-alive comments and malformed payloads are dropped, not forwarded.
  assert.equal(frameBelongsToSession(': keep-alive', 'ses_mine'), false)
  assert.equal(frameBelongsToSession('data: not json', 'ses_mine'), false)
})

test('hub frames are serialized as named SSE events', () => {
  assert.equal(
    sseFrame('hub', { state: 'sleeping', sessionId: 'inst-1' }),
    'event: hub\ndata: {"state":"sleeping","sessionId":"inst-1"}\n\n'
  )
})
