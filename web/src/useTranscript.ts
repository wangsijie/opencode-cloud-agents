import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchTranscript,
  openSessionEvents,
  type MessagePart,
  type SessionMessage,
  type TranscriptState
} from './api';

/**
 * A message being assembled from a full read plus a live stream.
 *
 * Parts are keyed by their own id rather than appended, because the stream
 * re-sends a part every time it grows: text arrives as a series of updates to
 * the same part, not as a sequence of new ones.
 */
interface Building {
  info: SessionMessage['info'];
  parts: Map<string, MessagePart>;
}

function toMap(messages: SessionMessage[]): Map<string, Building> {
  return new Map(
    messages.map((message) => [
      message.info.id,
      {
        info: message.info,
        parts: new Map(message.parts.map((part) => [part.id, part]))
      }
    ])
  );
}

/**
 * Message ids carry a sortable timestamp prefix, which is why the Hub never
 * assigns its own — ordering depends on OpenCode's.
 */
function toList(messages: Map<string, Building>): SessionMessage[] {
  return [...messages.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, message]) => ({
      info: message.info,
      parts: [...message.parts.values()]
    }));
}

interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

/** `EventSource.CLOSED`: the browser has stopped trying to reconnect. */
const CLOSED = 2;

/**
 * The transcript for one session: a full read, kept current by the event stream.
 *
 * `runtimeKey` is any value that changes when the container behind the session
 * does. A closed stream is only retried by the browser every 15 seconds, which
 * is the right cadence for noticing a wake nobody asked for — but far too slow
 * for a wake the user just triggered by sending a message. Changing this
 * re-attaches immediately instead of waiting that interval out.
 *
 * `agentSessionId` reads a subagent's conversation inside the same container
 * instead of the session's own. Nothing else changes: the Worker narrows both
 * the read and the stream to that session, so what arrives here is one
 * transcript either way.
 */
export function useTranscript(
  sessionId: string,
  runtimeKey?: string,
  agentSessionId?: string
) {
  const [messages, setMessages] = useState<SessionMessage[]>();
  const [state, setState] = useState<TranscriptState>();
  const [mirroredAt, setMirroredAt] = useState<string>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  /** Bumped to force a new stream; see `refresh`. */
  const [streamEpoch, setStreamEpoch] = useState(0);
  const building = useRef(new Map<string, Building>());
  /** The last state the event stream reported, to spot transitions. */
  const reportedState = useRef<TranscriptState | 'ended' | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const transcript = await fetchTranscript(sessionId, agentSessionId);
      building.current = toMap(transcript.messages);
      setMessages(toList(building.current));
      setState(transcript.state);
      reportedState.current = transcript.state;
      // Only a mirrored read is stale, so this clears itself the moment the
      // history comes from a live container again.
      setMirroredAt(transcript.mirroredAt);
      setError(transcript.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId, agentSessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * What the reader's refresh button does.
   *
   * Re-reading alone would fill the page in and leave the cause in place. The
   * transcript only stays current while the event stream does, and the state
   * this recovers from is a stream that died without the browser noticing —
   * suspended with the tab on a phone, or severed mid-flight by a network the
   * `EventSource` still believes it is attached to. Nothing reports that: no
   * `error` fires, and the browser's own reconnect never runs. So the stream is
   * dropped and rebuilt too, and the read that goes with it closes whatever gap
   * the dead one left.
   */
  const refresh = useCallback(() => {
    setRefreshing(true);
    setStreamEpoch((epoch) => epoch + 1);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  useEffect(() => {
    const source = openSessionEvents(sessionId, agentSessionId);

    const apply = (event: OpencodeEvent) => {
      const { properties } = event;
      setMessages(() => {
        const map = building.current;
        switch (event.type) {
          case 'message.updated': {
            const info = properties.info as SessionMessage['info'];
            const existing = map.get(info.id);
            map.set(info.id, { info, parts: existing?.parts ?? new Map() });
            break;
          }
          case 'message.removed': {
            map.delete(properties.messageID as string);
            break;
          }
          case 'message.part.updated': {
            const part = properties.part as MessagePart;
            const message = map.get(part.messageID as string);
            // A part can arrive before the message it belongs to; the message
            // event that follows keeps the parts collected so far.
            if (message) {
              message.parts.set(part.id, part);
            } else {
              map.set(part.messageID as string, {
                info: { id: part.messageID as string, role: 'assistant' },
                parts: new Map([[part.id, part]])
              });
            }
            break;
          }
          case 'message.part.removed': {
            map.get(properties.messageID as string)?.parts.delete(
              properties.partID as string
            );
            break;
          }
          default:
            return toList(map);
        }
        return toList(map);
      });
    };

    // The Hub's own frames describe the stream, not the conversation.
    source.addEventListener('hub', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        state: TranscriptState | 'ended';
      };
      if (payload.state === 'ended') {
        // The container went away. Re-read once so the view settles on whatever
        // is true now instead of freezing mid-generation.
        void load();
        return;
      }
      const previous = reportedState.current;
      reportedState.current = payload.state;
      setState(payload.state);
      // A live stream is always re-read, because a reconnect means there was a
      // gap the stream did not cover. Anything else is only re-read when the
      // state actually changed, and with it the source of the transcript: a
      // sleeping session reconnects every 15 seconds and must not re-download
      // its mirror each time.
      if (payload.state === 'live' || payload.state !== previous) {
        void load();
      }
    });

    source.addEventListener('opencode', (event) => {
      apply(JSON.parse((event as MessageEvent<string>).data) as OpencodeEvent);
    });

    /*
      A dropped stream, now that the server's heartbeat makes one visible.

      `EventSource` reconnects by itself and reports that as an error first, so
      this must not tear anything down: the reconnect carries a fresh `hub`
      frame, and a live one already forces the re-read that closes the gap. The
      one case it cannot handle is `CLOSED`, where the browser has given up for
      good and no reconnect is coming — that leaves the page frozen on a
      transcript that has stopped growing, and only a new stream fixes it.

      Deferred while the tab is hidden, because a phone drops the connection on
      the way into the background and reconnecting there just gets it dropped
      again; `visibilitychange` retries when it is worth doing.
    */
    const reopen = () => {
      if (source.readyState !== CLOSED) {
        return;
      }
      if (document.hidden) {
        return;
      }
      setStreamEpoch((epoch) => epoch + 1);
    };
    source.onerror = reopen;
    document.addEventListener('visibilitychange', reopen);

    return () => {
      document.removeEventListener('visibilitychange', reopen);
      source.onerror = null;
      source.close();
    };
  }, [sessionId, agentSessionId, load, runtimeKey, streamEpoch]);

  return { messages, state, mirroredAt, error, refreshing, refresh, reload: load };
}
