import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchTranscript,
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

/**
 * The transcript for one session: a full read, kept current by the event stream.
 *
 * `runtimeKey` is any value that changes when the container behind the session
 * does. A closed stream is only retried by the browser every 15 seconds, which
 * is the right cadence for noticing a wake nobody asked for — but far too slow
 * for a wake the user just triggered by sending a message. Changing this
 * re-attaches immediately instead of waiting that interval out.
 */
export function useTranscript(sessionId: string, runtimeKey?: string) {
  const [messages, setMessages] = useState<SessionMessage[]>();
  const [state, setState] = useState<TranscriptState>();
  const [mirroredAt, setMirroredAt] = useState<string>();
  const [error, setError] = useState<string>();
  const building = useRef(new Map<string, Building>());
  /** The last state the event stream reported, to spot transitions. */
  const reportedState = useRef<TranscriptState | 'ended' | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      const transcript = await fetchTranscript(sessionId);
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
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const source = new EventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/events`
    );

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

    return () => source.close();
  }, [sessionId, load, runtimeKey]);

  return { messages, state, mirroredAt, error, reload: load };
}
