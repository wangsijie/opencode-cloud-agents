import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SseFrameBuffer,
  classifySessionEvent,
  eventSessionId,
  forwardSessionEventStream,
  frameBelongsToSession,
  sseFrame,
  sseFrameData
} from '../src/session-events.ts'

const frame = (payload) => 'data: ' + JSON.stringify(payload)

/** A stream of chunks a test can feed and close by hand. */
function controllable() {
  let push
  let finish
  const stream = new ReadableStream({
    start(controller) {
      push = (text) => controller.enqueue(new TextEncoder().encode(text))
      finish = () => controller.close()
    }
  })
  return { stream, push: (text) => push(text), finish: () => finish() }
}

const STATE = {
  state: 'live',
  sessionId: 'inst-1',
  opencodeSessionId: 'ses_1',
  at: '2026-01-01T00:00:00.000Z'
}

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

/*
 * Watching a subagent is the same filter with the child's id. It has to be:
 * a subagent runs in its own OpenCode session on the same server-wide stream,
 * so the only thing separating its transcript from its parent's is which id
 * the forwarder was given.
 */
test('a subagent is watched by pointing the same filter at its session', () => {
  const child = 'data: ' + JSON.stringify({
    type: 'message.part.updated',
    properties: { sessionID: 'ses_child', part: { id: 'prt_1' } }
  })
  assert.equal(frameBelongsToSession(child, 'ses_child'), true)
  // And the parent's stream never carries it, which is what keeps the two
  // transcripts from merging into one.
  assert.equal(frameBelongsToSession(child, 'ses_parent'), false)
})

test('a finished or failed turn classifies as a stop', () => {
  assert.equal(
    classifySessionEvent(
      frame({ type: 'session.idle', properties: { sessionID: 'ses_1' } }),
      'ses_1'
    ),
    'stop'
  )
  assert.equal(
    classifySessionEvent(
      frame({ type: 'session.error', properties: { sessionID: 'ses_1', error: {} } }),
      'ses_1'
    ),
    'stop'
  )
})

test('question and permission asks classify as an ask', () => {
  for (const type of [
    'question.asked',
    'question.v2.asked',
    'permission.asked',
    'permission.v2.asked'
  ]) {
    assert.equal(
      classifySessionEvent(
        frame({ type, properties: { sessionID: 'ses_1' } }),
        'ses_1'
      ),
      'ask',
      type
    )
  }
})

test('streaming traffic is activity, never a stop', () => {
  for (const type of [
    'message.updated',
    'message.part.updated',
    'session.next.step.ended',
    'some.future.event'
  ]) {
    assert.equal(
      classifySessionEvent(
        frame({ type, properties: { sessionID: 'ses_1' } }),
        'ses_1'
      ),
      'activity',
      type
    )
  }
})

test('session.status splits on its payload: busy is activity, idle a stop', () => {
  const status = (type) =>
    frame({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type } } })
  assert.equal(classifySessionEvent(status('busy'), 'ses_1'), 'activity')
  assert.equal(classifySessionEvent(status('retry'), 'ses_1'), 'activity')
  assert.equal(classifySessionEvent(status('idle'), 'ses_1'), 'stop')
})

test('frames from other sessions and junk classify as nothing at all', () => {
  const other = frame({ type: 'session.idle', properties: { sessionID: 'ses_other' } })
  assert.equal(classifySessionEvent(other, 'ses_1'), undefined)
  // Server-wide events carry no sessionID; a subagent's stop must not mark
  // the parent unread either — the id filter handles both.
  const serverWide = frame({ type: 'server.connected', properties: {} })
  assert.equal(classifySessionEvent(serverWide, 'ses_1'), undefined)
  assert.equal(classifySessionEvent(': keep-alive', 'ses_1'), undefined)
  assert.equal(classifySessionEvent('data: not json', 'ses_1'), undefined)
})

test('hub frames are serialized as named SSE events', () => {
  assert.equal(
    sseFrame('hub', { state: 'sleeping', sessionId: 'inst-1' }),
    'event: hub\ndata: {"state":"sleeping","sessionId":"inst-1"}\n\n'
  )
})

/*
 * The heartbeat exists because this stream is otherwise byte-for-byte identical
 * to a dead one while an agent thinks: the filter drops everything that is not
 * this session's, so a long tool call writes nothing at all. Without a write on
 * a timer, nothing on the path between the container and the phone can tell the
 * difference, and a reaped connection is never reported to either end.
 */
test('a live stream writes a keep-alive while the agent is silent', async () => {
  const upstream = controllable()
  const response = forwardSessionEventStream(upstream.stream, STATE, 10)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  // The opening frames say nothing about liveness; they are written once.
  const opening = decoder.decode((await reader.read()).value)
  assert.match(opening, /retry: 15000/)

  const seen = []
  // Long enough for several beats, with the upstream deliberately silent.
  const deadline = Date.now() + 400
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read().then((result) => decoder.decode(result.value ?? new Uint8Array())),
      new Promise((resolve) => setTimeout(() => resolve(null), 200))
    ])
    if (chunk === null) {
      break
    }
    seen.push(chunk)
    if (seen.join('').includes(': keep-alive')) {
      break
    }
  }
  assert.ok(
    seen.join('').includes(': keep-alive'),
    'a silent upstream must still produce a keep-alive'
  )
  await reader.cancel()
})

test('the keep-alive is a comment, so it is not mistaken for an event', () => {
  // Both halves of the reader path already agree: a comment carries no data
  // and belongs to no session, so it can never reach the transcript or move
  // the unread marker.
  assert.equal(sseFrameData(': keep-alive'), undefined)
  assert.equal(frameBelongsToSession(': keep-alive', 'ses_1'), false)
  assert.equal(classifySessionEvent(': keep-alive', 'ses_1'), undefined)
})

test('the upstream still drives the stream, and its end still closes it', async () => {
  const upstream = controllable()
  const response = forwardSessionEventStream(upstream.stream, STATE, 10_000)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  // `retry:` and the opening `hub` frame are enqueued separately.
  await reader.read()
  await reader.read()

  upstream.push(frame({ type: 'message.updated', properties: { sessionID: 'ses_1' } }) + '\n\n')
  const forwarded = decoder.decode((await reader.read()).value)
  assert.match(forwarded, /^event: opencode\n/)

  // A container that quiesces ends its side; the browser must be told rather
  // than left on a stream the heartbeat would otherwise hold open forever.
  upstream.finish()
  const ending = decoder.decode((await reader.read()).value)
  assert.match(ending, /"state":"ended"/)
  assert.equal((await reader.read()).done, true)
})
