/**
 * Session registry types.
 *
 * A session is the product-level unit of work: one repository, one model, one
 * prompt thread. It maps 1:1 onto a logical instance (and therefore onto one
 * container that sleeps independently), so the session id *is* the instance id.
 *
 * `phase` describes the dispatch state machine owned by the SessionAgent
 * Durable Object, not the container runtime. The runtime lifecycle
 * (sleeping/waking/busy/idle) stays in `InstanceView.runtime`.
 */
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { InstanceRuntimeStatus, InstanceView } from './instances';

export type SessionPhase =
  /** Accepted, waiting for the agent alarm to start dispatch. */
  | 'queued'
  /** Waking the sandbox, provisioning the repo, creating the OpenCode session. */
  | 'starting'
  /** Every queued prompt has been handed to the container's agent loop. */
  | 'working'
  /** Dispatch failed after the automatic retries; retryable from the Hub. */
  | 'failed';

export const SESSION_PHASES: readonly SessionPhase[] = [
  'queued',
  'starting',
  'working',
  'failed'
];

export interface SessionRecord {
  /** Equal to `instanceId`; sessions and instances are created together. */
  id: string;
  instanceId: string;
  repoKey: string;
  /** `providerID/modelID` reference from the OpenCode model catalog. */
  model: string;
  title: string;
  /** Assigned once the container has created the OpenCode session. */
  opencodeSessionId?: string;
  phase: SessionPhase;
  /** Prompts accepted but not yet handed to the container. */
  pendingPromptCount: number;
  lastError?: string;
  lastPromptAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Partial state reported back by the SessionAgent after each dispatch step. */
export interface SessionStatePatch {
  phase?: SessionPhase;
  /** Follows the model of the most recent prompt, which the UI may switch. */
  model?: string;
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
  | 'error'
  | 'deleting';

export interface SessionView extends SessionRecord {
  instance: InstanceView;
  status: SessionStatus;
  /** Latest moment this session is known to have moved, for list sorting. */
  lastActivityAt: string;
}

/**
 * Fold the dispatch phase and the runtime lifecycle into one badge.
 *
 * Dispatch failures and deletion outrank everything: they need a human either
 * way. Below those, an unfinished dispatch (`queued`/`starting`) describes the
 * session better than the container does, because the container is only being
 * woken in service of that dispatch. Once every prompt has been handed over,
 * the runtime is what the user actually wants to see.
 */
export function deriveSessionStatus(
  phase: SessionPhase,
  runtime: InstanceRuntimeStatus
): SessionStatus {
  if (runtime.deleting) {
    return 'deleting';
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

export type SessionTranscriptState =
  /** Read live from the running container. */
  | 'live'
  /** The container is stopped; reading it would be a wake, which is forbidden. */
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
   * Where the messages came from. M4 adds an R2 `mirror` source so a sleeping
   * session still returns history; until then `none` means "no history here".
   */
  source: 'container' | 'none';
  observedAt: string;
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
