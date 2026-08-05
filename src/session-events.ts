/**
 * Live session events, forwarded from the container to the session page.
 *
 * OpenCode publishes one server-wide SSE stream at `/event`. The Worker
 * consumes it, keeps only the frames belonging to this session, and re-emits
 * them on `GET /api/sessions/:id/events`. The UI therefore never talks to a
 * container gateway, and never learns another session's traffic exists.
 *
 * Like the transcript read, this is a passive path: it holds no work lease and
 * never starts a stopped container. An open stream cannot keep a container
 * alive either — the idle probe is semantic, so an idle session still quiesces
 * underneath a connected browser.
 *
 * Streams are therefore expected to end, and ending is not an error: the client
 * is an `EventSource`, which reconnects on its own, and the reconnect is what
 * reports the session's new state. `retry:` sets that interval so a sleeping
 * session is re-checked on a sane cadence rather than the browser's eager
 * three-second default.
 */

/**
 * Reconnect delay handed to `EventSource`. A closed stream is the normal way a
 * sleeping session reports itself, and the browser reconnects on its own, so
 * this doubles as the "has it woken up yet" poll interval. The default of about
 * three seconds would be far too eager for that.
 */
const RECONNECT_MS = 15_000;

/**
 * How often a live stream writes a comment frame.
 *
 * Nothing about this is for the browser: `EventSource` has no idle timeout of
 * its own. It is for everything in between. A session's stream carries only
 * that session's frames — the filter below drops the server-wide ones, and
 * OpenCode's own keep-alives with them — so an agent thinking its way through a
 * long tool call produces a stream that is byte-for-byte identical to a dead
 * one. Anything on the path that reaps idle connections (a proxy, a phone's
 * NAT) takes it, and neither side is told: the browser goes on believing it is
 * attached, no `error` fires, and its automatic reconnect never runs. The tab
 * sits on a transcript that stopped growing.
 *
 * A write every fifteen seconds is what turns that silent half-open connection
 * into an error the browser can see and reconnect from. Comments are the SSE
 * framing for exactly this: clients ignore a line starting with a colon, so it
 * costs a few bytes and cannot be mistaken for an event.
 */
const HEARTBEAT_MS = 15_000;

/** One SSE comment. Ignored by every client; only its arrival means anything. */
const HEARTBEAT_FRAME = ': keep-alive\n\n';

export type SessionEventState =
  /** Attached to a running container; OpenCode frames follow. */
  | 'live'
  /** The container is stopped. Nothing follows and the stream closes. */
  | 'sleeping'
  /** The OpenCode session does not exist yet. Nothing follows. */
  | 'pending'
  /** The stream ended because the upstream ended, usually an idle stop. */
  | 'ended'
  /** The stream ended because forwarding failed. */
  | 'error';

/** The Hub's own frame, distinct from the OpenCode frames it forwards. */
export interface SessionStateEvent {
  state: SessionEventState;
  sessionId: string;
  opencodeSessionId?: string;
  at: string;
  error?: string;
}

/** Serialize one named SSE frame. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Split a byte stream into SSE frames across chunk boundaries.
 *
 * A single read can end mid-frame or carry several frames, so the remainder is
 * carried over to the next chunk rather than parsed as if it were complete.
 */
export class SseFrameBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const frames: string[] = [];
    const separator = /\r?\n\r?\n/g;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = separator.exec(this.buffer)) !== null) {
      frames.push(this.buffer.slice(consumed, match.index));
      consumed = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(consumed);
    return frames;
  }
}

/** The `data:` payload of one frame, with multi-line data rejoined. */
export function sseFrameData(frame: string): string | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''));
  return data.length > 0 ? data.join('\n') : undefined;
}

/**
 * The session an OpenCode event belongs to.
 *
 * Every session-scoped event carries it in the same place; server-wide events
 * (installation updates, server connected) have no `sessionID` and are dropped
 * rather than guessed at.
 */
export function eventSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const { properties } = payload as { properties?: unknown };
  if (typeof properties !== 'object' || properties === null) {
    return undefined;
  }
  const { sessionID } = properties as { sessionID?: unknown };
  return typeof sessionID === 'string' ? sessionID : undefined;
}

/** Whether a frame from the container belongs to the session being watched. */
export function frameBelongsToSession(
  frame: string,
  opencodeSessionId: string
): boolean {
  const data = sseFrameData(frame);
  if (data === undefined) {
    return false;
  }
  try {
    return eventSessionId(JSON.parse(data)) === opencodeSessionId;
  } catch {
    return false;
  }
}

/**
 * What a session's event means for the unread marker.
 *
 * `stop` — the turn ended (done, failed, or aborted): the moment there is a
 * result nobody may have seen. `ask` — the agent parked on a question or
 * permission and is waiting on a human. `activity` — everything else the
 * session emits while running, which must never mark unread on its own but
 * proves a run happened before the stop that follows it.
 */
export type SessionEventKind = 'stop' | 'ask' | 'activity';

const STOP_EVENT_TYPES = new Set(['session.idle', 'session.error']);

const ASK_EVENT_TYPES = new Set([
  'question.asked',
  'question.v2.asked',
  'permission.asked',
  'permission.v2.asked'
]);

/**
 * Classify one frame from the container's event stream, or undefined when it
 * is not this session's (server-wide frames, subagent traffic, junk).
 *
 * `session.status` is split by its payload: busy/retry are the run itself,
 * idle is another spelling of "the turn ended" — kept as `stop` so the marker
 * still lands if a container version emits it without `session.idle`.
 */
export function classifySessionEvent(
  frame: string,
  opencodeSessionId: string
): SessionEventKind | undefined {
  const data = sseFrameData(frame);
  if (data === undefined) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (eventSessionId(payload) !== opencodeSessionId) {
    return undefined;
  }
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== 'string') {
    return 'activity';
  }
  if (STOP_EVENT_TYPES.has(type)) {
    return 'stop';
  }
  if (ASK_EVENT_TYPES.has(type)) {
    return 'ask';
  }
  if (type === 'session.status') {
    return sessionStatusIsIdle(payload) ? 'stop' : 'activity';
  }
  return 'activity';
}

/** Whether a `session.status` payload reports the idle state. */
function sessionStatusIsIdle(payload: unknown): boolean {
  const { properties } = payload as { properties?: unknown };
  if (typeof properties !== 'object' || properties === null) {
    return false;
  }
  const { status } = properties as { status?: unknown };
  if (typeof status !== 'object' || status === null) {
    return false;
  }
  return (status as { type?: unknown }).type === 'idle';
}

function sseResponse(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // Proxies that buffer by default would defeat the point of streaming.
      'X-Accel-Buffering': 'no'
    }
  });
}

/**
 * A stream that reports one state and closes.
 *
 * Used when there is nothing to attach to — a stopped container or a session
 * whose OpenCode side does not exist yet. The browser reconnects on its own
 * after `RECONNECT_MS`, which is how a session page notices a wake.
 */
export function closedSessionEventStream(state: SessionStateEvent): Response {
  return sseResponse(`retry: ${RECONNECT_MS}\n\n${sseFrame('hub', state)}`);
}

/**
 * Forward the container's event stream, filtered down to one session.
 *
 * The upstream body is read incrementally rather than proxied through, because
 * the container publishes every session's events on one stream and only this
 * session's frames may reach the browser.
 */
export function forwardSessionEventStream(
  upstream: ReadableStream<Uint8Array>,
  state: SessionStateEvent,
  heartbeatMs: number = HEARTBEAT_MS
): Response {
  const opencodeSessionId = state.opencodeSessionId;
  if (!opencodeSessionId) {
    throw new Error('Forwarding session events requires an OpenCode session id');
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const frames = new SseFrameBuffer();

  // A TransformStream rather than a hand-pumped ReadableStream: piping the
  // upstream body through keeps a real socket read pending for the life of the
  // response. A pump that awaits a timer instead looks to the Workers runtime
  // like a request that has hung, and gets cancelled mid-stream.
  const filter = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${RECONNECT_MS}\n\n`));
      controller.enqueue(encoder.encode(sseFrame('hub', state)));
    },
    transform(chunk, controller) {
      for (const frame of frames.push(decoder.decode(chunk, { stream: true }))) {
        if (!frameBelongsToSession(frame, opencodeSessionId)) {
          continue;
        }
        const data = sseFrameData(frame);
        if (data !== undefined) {
          controller.enqueue(encoder.encode(`event: opencode\ndata: ${data}\n\n`));
        }
      }
    },
    flush(controller) {
      // OpenCode closed its side, e.g. a graceful shutdown during quiesce. A
      // container that is killed outright never reaches here — its read simply
      // stops settling, the runtime drops the request, and the browser's own
      // reconnect is what discovers the session is now sleeping.
      controller.enqueue(
        encoder.encode(
          sseFrame('hub', {
            ...state,
            state: 'ended',
            at: new Date().toISOString()
          })
        )
      );
    }
  });

  const filtered = upstream.pipeThrough(filter);
  if (heartbeatMs <= 0) {
    return sseResponse(filtered);
  }

  /*
    The heartbeat is a side channel, never the main loop.

    The filtered stream is still piped — the comment above is the reason, and it
    survives here: `pipeTo` keeps a genuine socket read pending for the life of
    the response, which is what stops the runtime from treating this as a hung
    request. The timer only enqueues beside it. Inverting the two — a pump whose
    loop awaits the timer and polls the upstream — is what gets cancelled
    mid-stream.

    Both sides finish through the same `close`, because either can be last: the
    upstream ends when the container quiesces, and the browser can walk away at
    any point, which surfaces as the pipe rejecting.
  */
  let stop = () => {};
  return sseResponse(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        const timer = setInterval(() => {
          if (!open) {
            return;
          }
          try {
            controller.enqueue(encoder.encode(HEARTBEAT_FRAME));
          } catch {
            // The consumer is gone; the pipe settles and finishes the cleanup.
            open = false;
            clearInterval(timer);
          }
        }, heartbeatMs);

        const close = (cause?: unknown) => {
          if (!open) {
            return;
          }
          open = false;
          clearInterval(timer);
          if (cause === undefined) {
            controller.close();
            return;
          }
          // A browser that navigated away is the ordinary case, not a fault:
          // the stream is already going and there is nobody left to tell.
          try {
            controller.error(cause);
          } catch {
            // Already settled by the consumer's own cancel.
          }
        };

        // Cancelling must not wait out a heartbeat to notice.
        stop = () => {
          open = false;
          clearInterval(timer);
        };

        void filtered
          .pipeTo(
            new WritableStream<Uint8Array>({
              write(chunk) {
                if (open) {
                  controller.enqueue(chunk);
                }
              }
            })
          )
          .then(
            () => close(),
            (cause) => close(cause)
          );
      },
      cancel() {
        stop();
      }
    })
  );
}
