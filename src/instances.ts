import type { SessionProvider } from '../protocol/types.ts';
import type { RepoDefinition } from './repos';
import type { TranscriptMirrorSummary } from './transcript-mirror';

export const HUB_DURABLE_OBJECT_ID = 'opencode-hub';

export type InstanceLifecycle =
  | 'ready'
  | 'deleting'
  | 'delete_failed'
  /** Claimed by the idle sweep; the Hub alarm is removing the container. */
  | 'cleaning'
  /**
   * The container and its snapshots are gone; the row and the transcript
   * mirror remain. Terminal and read-only — a cleaned session cannot wake.
   */
  | 'cleaned'
  /** A cleanup attempt failed; the next sweep retries it. */
  | 'clean_failed';
export type RuntimeLifecycle =
  | 'sleeping'
  | 'waking'
  | 'busy'
  | 'idle'
  | 'quiescing'
  | 'checkpointing'
  | 'stopping'
  | 'error';

/**
 * The container behind one session. Every instance runs the same image and is
 * defined by the catalog repository it provisions at wake time.
 */
export interface InstanceRecord {
  id: string;
  name: string;
  /**
   * Catalog repository cloned into `/workspace/<repoKey>` on first wake. Absent
   * on an instance created without a repository, which clones nothing.
   */
  repoKey?: string;
  /**
   * The catalog entry this instance was created from, pinned at creation.
   * Absent on instances created before the catalog became dynamic; those fall
   * back to looking `repoKey` up in the static list — and on instances created
   * without a repository at all.
   */
  repo?: RepoDefinition;
  /** Which sandbox host runs this instance's container. */
  provider: SessionProvider;
  lifecycle: InstanceLifecycle;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  deleteOperationId?: string;
}

/**
 * How long each stage of the last wake took.
 *
 * Kept as three numbers rather than a log because the question this answers is
 * comparative — which stage dominates, and did a change move it — and because
 * it has to be cheap enough to carry on every runtime status read.
 */
export interface WakeStageTimings {
  /** Container start plus R2 workspace restore; the two cannot be separated. */
  restoreMs?: number;
  /** Credential and skill injection from the settings table. */
  credentialsMs?: number;
  /** Repository provisioning: a clone on the first wake, nothing later. */
  repoMs?: number;
  /** OpenCode server start, overlapped with the resumed checkout's fetch. */
  serverMs?: number;
}

export interface WakeTimings extends WakeStageTimings {
  totalMs: number;
  at: string;
  /** False when the container was already running and only the server restarted. */
  cold: boolean;
}

/**
 * A container that came back up on an empty workspace while it still owned an
 * OpenCode session.
 *
 * OpenCode's own state lives inside `/workspace`, so a container that dies
 * without checkpointing takes the conversation with it. Nothing can bring that
 * session back — the record exists so the loss is reported once, immediately,
 * instead of being rediscovered as a 404 on every later prompt.
 */
export interface WorkspaceLoss {
  at: string;
  /** The OpenCode session the lost workspace held. */
  opencodeSessionId: string;
}

export interface InstanceRuntimeStatus {
  container: 'running' | 'stopping' | 'stopped' | 'healthy' | 'stopped_with_code' | 'unknown';
  containerLastChangedAt?: string;
  exitCode?: number;
  /**
   * Which sandbox host runs this container — the Sandbox's own copy, not the
   * Hub row's. It is what tells the UI whether the workspace is checkpointed to
   * R2 or kept on a volume, so it rides out with the persistence record rather
   * than being joined on later.
   */
  provider: SessionProvider;
  platformRunning: boolean;
  deleting: boolean;
  lifecycle: RuntimeLifecycle;
  idleSince?: string;
  idleDeadlineAt?: string;
  activeSessionCount?: number;
  lastActivityProbeAt?: string;
  lifecycleError?: string;
  persistence: {
    hasBackup: boolean;
    backupId?: string;
    trackedBackupCount: number;
    lastCheckpointAt?: string;
    lastCheckpointReason?: 'manual' | 'idle-stop';
    lastRestoreAt?: string;
    lastError?: {
      at: string;
      operation: 'checkpoint' | 'restore';
      message: string;
    };
  };
  /**
   * Set once this instance has woken to an empty workspace it should have
   * restored. The session it names is unrecoverable.
   */
  workspaceLost?: WorkspaceLoss;
  /**
   * How long the last wake took, per stage. Present once this instance has
   * woken at least once since wakes started being measured.
   */
  lastWake?: WakeTimings;
  /**
   * The last transcript export, present once this instance has run a session.
   * It is what makes a sleeping session readable without waking anything.
   */
  transcript?: TranscriptMirrorSummary;
}

export interface InstanceView extends InstanceRecord {
  runtime: InstanceRuntimeStatus;
}
