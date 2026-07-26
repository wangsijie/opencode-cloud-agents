import type { RepoDefinition } from './repos';
import type { TranscriptMirrorSummary } from './transcript-mirror';

export const HUB_DURABLE_OBJECT_ID = 'opencode-hub';

export type InstanceLifecycle = 'ready' | 'deleting' | 'delete_failed';
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
  /** Catalog repository cloned into `/workspace/<repoKey>` on first wake. */
  repoKey: string;
  /**
   * The catalog entry this instance was created from, pinned at creation.
   * Absent on instances created before the catalog became dynamic; those fall
   * back to looking `repoKey` up in the static list.
   */
  repo?: RepoDefinition;
  lifecycle: InstanceLifecycle;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  deleteOperationId?: string;
}

export interface InstanceRuntimeStatus {
  container: 'running' | 'stopping' | 'stopped' | 'healthy' | 'stopped_with_code' | 'unknown';
  containerLastChangedAt?: string;
  exitCode?: number;
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
   * The last transcript export, present once this instance has run a session.
   * It is what makes a sleeping session readable without waking anything.
   */
  transcript?: TranscriptMirrorSummary;
}

export interface InstanceView extends InstanceRecord {
  runtime: InstanceRuntimeStatus;
}
