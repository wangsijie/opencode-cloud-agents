export const HUB_DURABLE_OBJECT_ID = 'opencode-hub';
export const CURRENT_IMAGE_KEY = 'opencode-v1';
export const LEGACY_INSTANCE_ID = 'opencode';

export type ImageKey = typeof CURRENT_IMAGE_KEY;
export type InstanceLifecycle = 'ready' | 'deleting' | 'delete_failed';

export interface InstanceRecord {
  id: string;
  name: string;
  imageKey: ImageKey;
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
