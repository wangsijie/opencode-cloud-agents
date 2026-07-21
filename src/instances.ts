export const HUB_DURABLE_OBJECT_ID = 'opencode-hub';
export const CURRENT_IMAGE_KEY = 'opencode-v1';
export const LOGTO_IMAGE_KEY = 'logto-v1';
export const LEGACY_INSTANCE_ID = 'opencode';

export const IMAGE_KEYS = [CURRENT_IMAGE_KEY, LOGTO_IMAGE_KEY] as const;

export type ImageKey = (typeof IMAGE_KEYS)[number];
export type InstanceLifecycle = 'ready' | 'deleting' | 'delete_failed';

export function isImageKey(value: unknown): value is ImageKey {
  return IMAGE_KEYS.some((imageKey) => imageKey === value);
}

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
