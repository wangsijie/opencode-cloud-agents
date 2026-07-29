/**
 * Session registry types.
 *
 * A session is the product-level unit of work: at most one repository, one
 * model, one prompt thread. It maps 1:1 onto a logical instance (and therefore onto one
 * container that sleeps independently), so the session id *is* the instance id.
 *
 * `phase` describes the dispatch state machine owned by the SessionAgent
 * Durable Object, not the container runtime. The runtime lifecycle
 * (sleeping/waking/busy/idle) stays in `InstanceView.runtime`.
 */
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { SessionProvider } from '../protocol/types.ts';
import type {
  InstanceLifecycle,
  InstanceRuntimeStatus,
  InstanceView
} from './instances';
import {
  isOpencodePlaceholderTitle,
  type TranscriptMirrorSummary
} from './transcript-mirror.ts';

export type SessionPhase =
  /** Accepted, waiting for the agent alarm to start dispatch. */
  | 'queued'
  /** Waking the sandbox, provisioning the repo, creating the OpenCode session. */
  | 'starting'
  /** Every queued prompt has been handed to the container's agent loop. */
  | 'working'
  /** Dispatch failed after the automatic retries; retryable from the Hub. */
  | 'failed'
  /**
   * The container lost the conversation: it came up on an empty workspace, so
   * the OpenCode session this record points at no longer exists anywhere.
   * Terminal — retrying cannot reach a session that is gone, and starting a new
   * one would be a different conversation wearing this one's name.
   */
  | 'lost';

export const SESSION_PHASES: readonly SessionPhase[] = [
  'queued',
  'starting',
  'working',
  'failed',
  'lost'
];

export interface SessionRecord {
  /** Equal to `instanceId`; sessions and instances are created together. */
  id: string;
  instanceId: string;
  /**
   * The repository this session works in. Absent when the session was created
   * without one: nothing is cloned and the work happens in `/workspace` itself.
   */
  repoKey?: string;
  /**
   * Absolute container path of this session's checkout, pinned at creation.
   * Absent on sessions created before the catalog became dynamic.
   */
  directory?: string;
  /**
   * Which sandbox host runs this session's container — not to be confused
   * with the model provider prefix inside `model`.
   */
  provider: SessionProvider;
  /** `providerID/modelID` reference from the OpenCode model catalog. */
  model: string;
  /**
   * OpenCode variant (reasoning effort) for `model`, when the model has any.
   * Absent on sessions created before variants were selectable, and on models
   * that have no variants.
   */
  variant?: string;
  title: string;
  /** Assigned once the container has created the OpenCode session. */
  opencodeSessionId?: string;
  phase: SessionPhase;
  /** Prompts accepted but not yet handed to the container. */
  pendingPromptCount: number;
  lastError?: string;
  lastPromptAt?: string;
  /**
   * When the idle sweep removed this session's container. Set only on cleaned
   * sessions, which are read-only: the transcript mirror is all that remains.
   */
  cleanedAt?: string;
  /**
   * When the agent last stopped — finished a turn, failed, or parked on a
   * question — without the user having looked at the session since. Absent
   * means read. Kept in D1 so the marker follows the user across devices.
   */
  unreadAt?: string;
  /**
   * Set when a human named this session. OpenCode titles a conversation of its
   * own accord, and adopting that title is an improvement on the first line of
   * the opening prompt — but never on a name somebody chose.
   */
  titleLocked?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Partial state reported back by the SessionAgent after each dispatch step. */
export interface SessionStatePatch {
  phase?: SessionPhase;
  /** Follows the model of the most recent prompt, which the UI may switch. */
  model?: string;
  /**
   * Follows the variant of the most recent prompt. `null` clears it when the
   * user switches to a model with no variants.
   */
  variant?: string | null;
  title?: string;
  opencodeSessionId?: string;
  pendingPromptCount?: number;
  lastPromptAt?: string;
  /** `null` clears a previously reported failure. */
  lastError?: string | null;
}

/**
 * The single badge the session list and session header render. It folds the
 * dispatch phase and the container runtime into one product-level state, so the
 * UI never has to know that those are two independent state machines.
 */
export type SessionStatus =
  | 'queued'
  | 'starting'
  | 'working'
  | 'idle'
  | 'sleeping'
  | 'failed'
  | 'lost'
  | 'error'
  | 'deleting'
  | 'cleaned';

export interface SessionView extends SessionRecord {
  instance: InstanceView;
  status: SessionStatus;
  /** Latest moment this session is known to have moved, for list sorting. */
  lastActivityAt: string;
  /**
   * Summary of the R2 transcript mirror, when one has been exported. The list
   * renders it instead of asking a container how much history a session has.
   */
  transcript?: TranscriptMirrorSummary;
  /**
   * The name to show. `title` stays the record's own — the first line of the
   * opening prompt — and this is what OpenCode has since called the
   * conversation, unless a human named it.
   */
  displayTitle: string;
}

/**
 * Which name a session is shown under.
 *
 * A prompt's first line is a placeholder: it is what was available before the
 * conversation existed. Once OpenCode has titled the conversation itself that is
 * the better label — but a name a human chose outranks both.
 */
export function deriveDisplayTitle(
  record: SessionRecord,
  transcript?: TranscriptMirrorSummary
): string {
  // Mirrors written before the placeholder filter may still carry OpenCode's
  // "New session - …" stamp; it is not a title anyone chose, so it never wins.
  if (
    record.titleLocked ||
    !transcript?.opencodeTitle ||
    isOpencodePlaceholderTitle(transcript.opencodeTitle)
  ) {
    return record.title;
  }
  return transcript.opencodeTitle;
}

/** The lifecycle family of a session whose container has been cleaned away. */
export function isCleanedLifecycle(
  lifecycle: InstanceLifecycle
): lifecycle is 'cleaning' | 'cleaned' | 'clean_failed' {
  return (
    lifecycle === 'cleaning' ||
    lifecycle === 'cleaned' ||
    lifecycle === 'clean_failed'
  );
}

/** How long a session may sit untouched before its container is cleaned away. */
export const CLEANUP_IDLE_DAYS = 7;

/** The one answer every write path gives about a cleaned session. */
export const CLEANED_SESSION_MESSAGE = `This session was cleaned up after ${CLEANUP_IDLE_DAYS} days of inactivity and is read-only`;

/**
 * The moment before which a session counts as idle enough to clean, as an
 * ISO-8601 string — timestamps compare lexicographically everywhere in this
 * codebase, so the cutoff is used directly in SQL comparisons.
 */
export function cleanupCutoff(now: Date): string {
  return new Date(
    now.getTime() - CLEANUP_IDLE_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();
}

/**
 * Fold the dispatch phase and the runtime lifecycle into one badge.
 *
 * Deletion and a lost conversation outrank everything: once either is true the
 * container's own state says nothing worth showing. A cleaned session comes
 * right after deletion — its container no longer exists, so neither the phase
 * nor the runtime says anything truer than "cleaned" — except when it is being
 * deleted, which still wins. A dispatch failure comes
 * next, because it needs a human either
 * way. Below those, an unfinished dispatch (`queued`/`starting`) describes the
 * session better than the container does, because the container is only being
 * woken in service of that dispatch. Once every prompt has been handed over,
 * the runtime is what the user actually wants to see.
 */
export function deriveSessionStatus(
  phase: SessionPhase,
  runtime: InstanceRuntimeStatus,
  lifecycle: InstanceLifecycle = 'ready'
): SessionStatus {
  if (runtime.deleting) {
    return 'deleting';
  }
  if (isCleanedLifecycle(lifecycle)) {
    return 'cleaned';
  }
  if (phase === 'lost') {
    return 'lost';
  }
  if (phase === 'failed') {
    return 'failed';
  }
  if (runtime.lifecycle === 'error') {
    return 'error';
  }
  if (phase === 'queued' || phase === 'starting') {
    return phase;
  }
  switch (runtime.lifecycle) {
    case 'busy':
      return 'working';
    case 'idle':
      return 'idle';
    case 'waking':
      return 'starting';
    default:
      // quiescing/checkpointing/stopping are all on the way to sleeping, and
      // the distinction is a container detail the session view hides.
      return 'sleeping';
  }
}

/** The most recent timestamp known for a session, without touching the container. */
export function deriveLastActivityAt(record: SessionRecord): string {
  const candidates = [record.updatedAt, record.lastPromptAt, record.createdAt];
  let latest = record.createdAt;
  for (const candidate of candidates) {
    if (candidate && candidate > latest) {
      latest = candidate;
    }
  }
  return latest;
}

/** One OpenCode message with its parts, forwarded verbatim to the UI renderer. */
export interface SessionMessage {
  info: Message;
  parts: Part[];
}

/**
 * What a conversation has cost so far.
 *
 * OpenCode prices every assistant message itself, so this only adds them up:
 * the numbers are the provider's, not an estimate made here.
 */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** In US dollars, as reported by OpenCode. */
  cost: number;
  /** How many assistant messages contributed, for reading the average. */
  assistantMessages: number;
}


export type SessionTranscriptState =
  /** Read live from the running container. */
  | 'live'
  /** The container is stopped, so the history comes from the R2 mirror. */
  | 'sleeping'
  /** The OpenCode session does not exist yet (dispatch has not created it). */
  | 'pending'
  /** The runtime was reachable but the read failed. */
  | 'error';

export interface SessionTranscript {
  sessionId: string;
  opencodeSessionId?: string;
  state: SessionTranscriptState;
  /**
   * Where the messages came from. `mirror` is the R2 copy exported before the
   * container went to sleep, so it may be missing anything that happened after
   * `mirroredAt`; `none` means there is no history to show at all.
   */
  source: 'container' | 'mirror' | 'none';
  observedAt: string;
  /** When the mirror was exported. Only set when `source` is `mirror`. */
  mirroredAt?: string;
  messages: SessionMessage[];
  error?: string;
}

export const MAX_SESSION_PROMPT_LENGTH = 32_000;
export const MAX_SESSION_TITLE_LENGTH = 80;

export function isSessionPhase(value: unknown): value is SessionPhase {
  return SESSION_PHASES.some((phase) => phase === value);
}

/**
 * Build a human-readable title from the opening prompt. Titles are only a list
 * label; OpenCode may generate its own title for the same conversation.
 */
export function deriveSessionTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return 'Untitled session';
  }
  return firstLine.length > MAX_SESSION_TITLE_LENGTH
    ? `${firstLine.slice(0, MAX_SESSION_TITLE_LENGTH - 1)}…`
    : firstLine;
}

/** Normalize a submitted prompt, or return undefined when it is unusable. */
export function normalizeSessionPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const prompt = value.trim();
  if (!prompt || prompt.length > MAX_SESSION_PROMPT_LENGTH) {
    return undefined;
  }
  return prompt;
}

export const SESSION_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const;
export const MAX_SESSION_ATTACHMENTS = 4;
export const MAX_SESSION_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_SESSION_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_SESSION_ATTACHMENT_FILENAME_LENGTH = 128;

/** An image as submitted by the browser: bytes still base64-encoded. */
export interface SessionAttachmentInput {
  mime: (typeof SESSION_ATTACHMENT_MIME_TYPES)[number];
  filename?: string;
  /** Raw base64 without a `data:` prefix. */
  data: string;
}

/**
 * An image after staging: bytes live in R2 and only this reference travels
 * through the SessionAgent queue and Sandbox RPC, both of which have size
 * limits far below one image.
 */
export interface SessionAttachmentRef {
  key: string;
  mime: string;
  filename?: string;
  /** Decoded size in bytes. */
  size: number;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte count of a base64 string, computed without decoding it. */
function base64DecodedSize(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function normalizeAttachmentFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const basename = value.slice(
    Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1
  );
  const filename = basename
    .trim()
    .slice(0, MAX_SESSION_ATTACHMENT_FILENAME_LENGTH);
  return filename || undefined;
}

/**
 * Normalize submitted image attachments. Absent input means no attachments;
 * anything malformed or over the size/count limits rejects the whole request
 * (undefined) rather than silently dropping images the user meant to send.
 */
export function normalizeSessionAttachments(
  value: unknown
): SessionAttachmentInput[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_SESSION_ATTACHMENTS) {
    return undefined;
  }
  const attachments: SessionAttachmentInput[] = [];
  let totalBytes = 0;
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const { mime, filename, data } = entry as {
      mime?: unknown;
      filename?: unknown;
      data?: unknown;
    };
    if (!SESSION_ATTACHMENT_MIME_TYPES.some((allowed) => allowed === mime)) {
      return undefined;
    }
    if (
      typeof data !== 'string' ||
      data.length === 0 ||
      data.length % 4 !== 0 ||
      !BASE64_PATTERN.test(data)
    ) {
      return undefined;
    }
    const size = base64DecodedSize(data);
    if (size === 0 || size > MAX_SESSION_ATTACHMENT_BYTES) {
      return undefined;
    }
    totalBytes += size;
    if (totalBytes > MAX_SESSION_ATTACHMENT_TOTAL_BYTES) {
      return undefined;
    }
    const cleanFilename = normalizeAttachmentFilename(filename);
    attachments.push({
      mime: mime as SessionAttachmentInput['mime'],
      ...(cleanFilename ? { filename: cleanFilename } : {}),
      data
    });
  }
  return attachments;
}

/** R2 key for one staged prompt attachment. */
export function promptAttachmentKey(
  sessionId: string,
  promptId: string,
  index: number
): string {
  return `prompt-attachments/${sessionId}/${promptId}/${index}`;
}

/** Prefix covering every staged attachment of a session, for deletion sweeps. */
export function promptAttachmentPrefix(sessionId: string): string {
  return `prompt-attachments/${sessionId}/`;
}
