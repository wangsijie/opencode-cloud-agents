/**
 * The mock replacement for the session event stream.
 *
 * `MockEventSource` implements exactly the surface `useTranscript` uses. On
 * connect it emits the same `hub` frame the Worker would (live / sleeping /
 * pending for the current runtime state), and afterwards it receives whatever
 * `opencode` frames the store's scripts emit for its session.
 */
import type { SessionEventSource } from '../api';
import { store, transcriptFor } from './store';

type Listener = (event: MessageEvent<string>) => void;

const streams = new Set<MockEventSource>();

class MockEventSource implements SessionEventSource {
  private listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly sessionId: string,
    readonly child: string | undefined
  ) {
    streams.add(this);
    // The initial hub frame arrives after the caller has had a chance to
    // register its listeners — same as a real EventSource.
    setTimeout(() => this.emitInitialState(), 30);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  close(): void {
    streams.delete(this);
    this.listeners.clear();
  }

  dispatch(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  private emitInitialState(): void {
    if (!streams.has(this)) {
      return;
    }
    const session = store.sessions.get(this.sessionId);
    if (!session) {
      return;
    }
    const state = transcriptFor(session, this.child)?.state ?? 'pending';
    this.dispatch('hub', {
      state,
      sessionId: this.sessionId,
      at: new Date().toISOString()
    });
  }
}

/** Push one `opencode` frame to every stream watching this conversation. */
export function emitOpencode(
  sessionId: string,
  child: string | undefined,
  event: { type: string; properties: Record<string, unknown> }
): void {
  for (const stream of streams) {
    if (stream.sessionId === sessionId && stream.child === child) {
      stream.dispatch('opencode', event);
    }
  }
}

/** Factory handed to `setSessionEventSource`. */
export function createMockEventSource(url: string): SessionEventSource {
  const parsed = new URL(url, location.origin);
  const match = /^\/api\/sessions\/([^/]+)\/events$/.exec(parsed.pathname);
  const sessionId = match ? decodeURIComponent(match[1]) : '';
  const child = parsed.searchParams.get('child') ?? undefined;
  return new MockEventSource(sessionId, child);
}
