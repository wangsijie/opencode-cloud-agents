/**
 * Transcript mirrors: a session's history, readable while its container sleeps.
 *
 * A container is the only place OpenCode keeps a conversation, so a sleeping
 * session used to have no readable history at all — and reading it by waking the
 * container would turn every glance at the list into a cold start. Instead the
 * Sandbox exports the full message history to R2 while the server is still
 * running (see `mirrorTranscript` in [sandbox.ts](sandbox.ts)), and the Worker
 * serves that copy when the runtime is gone.
 *
 * The bodies live in R2 rather than Durable Object storage because a single DO
 * value tops out at 128KB, which a long conversation passes easily. The Sandbox
 * keeps only the summary — count, watermark — in its own storage, which is what
 * the session list reads.
 *
 * This module is shared by the writer (Sandbox DO) and the reader (Worker), so
 * it holds no bindings and reaches for nothing but the bucket it is handed.
 */
import type { SessionMessage } from './sessions';

const TRANSCRIPT_MIRROR_SCHEMA_VERSION = 1;

/** Everything a session's mirror owns, so deletion can sweep by prefix. */
export function transcriptMirrorPrefix(sessionId: string): string {
  return `transcripts/${sessionId}/`;
}

export function transcriptMirrorKey(sessionId: string): string {
  return `${transcriptMirrorPrefix(sessionId)}latest.json`;
}

/** Why a mirror was written; useful when reasoning about a stale export. */
export type TranscriptMirrorReason = 'idle-stop' | 'force-stop' | 'refresh';

/**
 * The small part of a mirror: what the Sandbox keeps in Durable Object storage
 * and the session list renders without touching R2 or the container.
 */
export interface TranscriptMirrorSummary {
  /** The OpenCode conversation this mirror belongs to. */
  opencodeSessionId: string;
  /** When the export ran. Everything after this moment may be missing. */
  mirroredAt: string;
  reason: TranscriptMirrorReason;
  messageCount: number;
  /** Timestamp of the newest mirrored message, when OpenCode reported one. */
  lastMessageAt?: string;
}

/** The full mirror, as stored in R2. */
export interface StoredTranscriptMirror extends TranscriptMirrorSummary {
  schemaVersion: number;
  sessionId: string;
  messages: SessionMessage[];
}

/**
 * Derive the summary fields from a freshly read history.
 *
 * Message ids carry a sortable timestamp prefix, so the newest message is the
 * last one; its own clock is preferred over the export clock because that is
 * what the reader wants to know ("history up to here").
 */
export function summarizeTranscriptMessages(messages: SessionMessage[]): {
  messageCount: number;
  lastMessageAt?: string;
} {
  const newest = messages[messages.length - 1];
  const time = newest?.info?.time as
    | { created?: number; completed?: number }
    | undefined;
  const at = time?.completed ?? time?.created;
  return {
    messageCount: messages.length,
    ...(typeof at === 'number' && Number.isFinite(at)
      ? { lastMessageAt: new Date(at).toISOString() }
      : {})
  };
}

export function buildTranscriptMirror(input: {
  sessionId: string;
  opencodeSessionId: string;
  reason: TranscriptMirrorReason;
  mirroredAt: string;
  messages: SessionMessage[];
}): StoredTranscriptMirror {
  return {
    schemaVersion: TRANSCRIPT_MIRROR_SCHEMA_VERSION,
    sessionId: input.sessionId,
    opencodeSessionId: input.opencodeSessionId,
    mirroredAt: input.mirroredAt,
    reason: input.reason,
    ...summarizeTranscriptMessages(input.messages),
    messages: input.messages
  };
}

export function transcriptMirrorSummary(
  mirror: StoredTranscriptMirror
): TranscriptMirrorSummary {
  return {
    opencodeSessionId: mirror.opencodeSessionId,
    mirroredAt: mirror.mirroredAt,
    reason: mirror.reason,
    messageCount: mirror.messageCount,
    ...(mirror.lastMessageAt ? { lastMessageAt: mirror.lastMessageAt } : {})
  };
}

/**
 * Validate an object read back from R2.
 *
 * A mirror is written by one deployment and read by another, so an unreadable
 * or older-schema object is treated as "no mirror" rather than as an error: the
 * session still has a container, and the next export replaces it.
 */
export function parseTranscriptMirror(
  value: unknown
): StoredTranscriptMirror | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<StoredTranscriptMirror>;
  if (
    candidate.schemaVersion !== TRANSCRIPT_MIRROR_SCHEMA_VERSION ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.opencodeSessionId !== 'string' ||
    typeof candidate.mirroredAt !== 'string' ||
    !Array.isArray(candidate.messages)
  ) {
    return undefined;
  }
  const messages = candidate.messages.filter(
    (message): message is SessionMessage =>
      typeof message === 'object' &&
      message !== null &&
      typeof (message as SessionMessage).info?.id === 'string'
  );
  return {
    schemaVersion: candidate.schemaVersion,
    sessionId: candidate.sessionId,
    opencodeSessionId: candidate.opencodeSessionId,
    mirroredAt: candidate.mirroredAt,
    reason: isTranscriptMirrorReason(candidate.reason)
      ? candidate.reason
      : 'refresh',
    ...summarizeTranscriptMessages(messages),
    messages
  };
}

function isTranscriptMirrorReason(
  value: unknown
): value is TranscriptMirrorReason {
  return value === 'idle-stop' || value === 'force-stop' || value === 'refresh';
}

export async function putTranscriptMirror(
  bucket: R2Bucket,
  mirror: StoredTranscriptMirror
): Promise<void> {
  await bucket.put(
    transcriptMirrorKey(mirror.sessionId),
    JSON.stringify(mirror),
    {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        opencodeSessionId: mirror.opencodeSessionId,
        mirroredAt: mirror.mirroredAt,
        messageCount: String(mirror.messageCount)
      }
    }
  );
}

export async function getTranscriptMirror(
  bucket: R2Bucket,
  sessionId: string
): Promise<StoredTranscriptMirror | undefined> {
  const object = await bucket.get(transcriptMirrorKey(sessionId));
  if (!object) {
    return undefined;
  }
  let value: unknown;
  try {
    value = await object.json();
  } catch (error) {
    console.warn(`Failed to parse transcript mirror for ${sessionId}`, error);
    return undefined;
  }
  const mirror = parseTranscriptMirror(value);
  return mirror?.sessionId === sessionId ? mirror : undefined;
}

/** Remove every object a session's mirror owns, as part of instance deletion. */
export async function deleteTranscriptMirror(
  bucket: R2Bucket,
  sessionId: string
): Promise<void> {
  const prefix = transcriptMirrorPrefix(sessionId);
  for (;;) {
    const page = await bucket.list({ prefix });
    if (page.objects.length === 0) {
      return;
    }
    await bucket.delete(page.objects.map((object) => object.key));
  }
}
