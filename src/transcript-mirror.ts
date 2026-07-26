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
import type { SessionMessage, SessionUsage } from './sessions';

const TRANSCRIPT_MIRROR_SCHEMA_VERSION = 1;

/** Everything a session's mirror owns, so deletion can sweep by prefix. */
export function transcriptMirrorPrefix(sessionId: string): string {
  return `transcripts/${sessionId}/`;
}

export function transcriptMirrorKey(sessionId: string): string {
  return `${transcriptMirrorPrefix(sessionId)}latest.json`;
}

/**
 * Why a mirror was written; useful when reasoning about a stale export.
 *
 * `live` is the event-driven export a running container writes seconds after the
 * conversation moves; `refresh` is the slower probe-driven safety net behind it.
 */
export type TranscriptMirrorReason =
  | 'idle-stop'
  | 'force-stop'
  | 'refresh'
  | 'live';

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
  /**
   * Tokens and cost across the whole conversation. Summed here rather than in
   * the reader so the session list can show it without loading any messages.
   */
  usage?: SessionUsage;
  /**
   * The title OpenCode gave the conversation, when it has given one. It is
   * usually a better label than the first line of the opening prompt, so the
   * session view prefers it — unless a human named the session.
   */
  opencodeTitle?: string;
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
  usage: SessionUsage;
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
      : {}),
    usage: summarizeSessionUsage(messages)
  };
}

/**
 * Total a conversation's tokens and cost.
 *
 * Only assistant messages carry either; a user message has neither, so anything
 * that is not one is skipped rather than guessed at. The numbers are OpenCode's
 * own — nothing here prices a model.
 */
export function summarizeSessionUsage(
  messages: readonly SessionMessage[]
): SessionUsage {
  const usage: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    assistantMessages: 0
  };
  for (const message of messages) {
    const info = message.info as {
      role?: string;
      cost?: unknown;
      tokens?: {
        input?: unknown;
        output?: unknown;
        reasoning?: unknown;
        cache?: { read?: unknown; write?: unknown };
      };
    };
    if (info.role !== 'assistant') {
      continue;
    }
    usage.assistantMessages += 1;
    usage.cost += finite(info.cost);
    usage.inputTokens += finite(info.tokens?.input);
    usage.outputTokens += finite(info.tokens?.output);
    usage.reasoningTokens += finite(info.tokens?.reasoning);
    usage.cacheReadTokens += finite(info.tokens?.cache?.read);
    usage.cacheWriteTokens += finite(info.tokens?.cache?.write);
  }
  return usage;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function buildTranscriptMirror(input: {
  sessionId: string;
  opencodeSessionId: string;
  reason: TranscriptMirrorReason;
  mirroredAt: string;
  messages: SessionMessage[];
  opencodeTitle?: string;
}): StoredTranscriptMirror {
  return {
    schemaVersion: TRANSCRIPT_MIRROR_SCHEMA_VERSION,
    sessionId: input.sessionId,
    opencodeSessionId: input.opencodeSessionId,
    mirroredAt: input.mirroredAt,
    reason: input.reason,
    ...summarizeTranscriptMessages(input.messages),
    ...(input.opencodeTitle ? { opencodeTitle: input.opencodeTitle } : {}),
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
    ...(mirror.lastMessageAt ? { lastMessageAt: mirror.lastMessageAt } : {}),
    ...(mirror.usage ? { usage: mirror.usage } : {}),
    ...(mirror.opencodeTitle ? { opencodeTitle: mirror.opencodeTitle } : {})
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
    ...(typeof candidate.opencodeTitle === 'string'
      ? { opencodeTitle: candidate.opencodeTitle }
      : {}),
    messages
  };
}

function isTranscriptMirrorReason(
  value: unknown
): value is TranscriptMirrorReason {
  return (
    value === 'idle-stop' ||
    value === 'force-stop' ||
    value === 'refresh' ||
    value === 'live'
  );
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
