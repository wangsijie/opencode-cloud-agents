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
}

export interface InstanceView extends InstanceRecord {
  runtime: InstanceRuntimeStatus;
}
