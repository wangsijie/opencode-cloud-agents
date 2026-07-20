/**
 * OpenCode + Cloudflare Sandbox experiment.
 *
 * Based on cloudflare/sandbox-sdk/examples/opencode. It supports both the full
 * OpenCode web UI at / and programmatic SDK access at POST /api/test.
 */
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox,
  type DirectoryBackup
} from '@cloudflare/sandbox';
import {
  createOpencode,
  createOpencodeServer,
  proxyToOpencode
} from '@cloudflare/sandbox/opencode';
import type { Part } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  OPENCODE_CONFIG
} from './opencode-config';

export { ContainerProxy };

const WORKSPACE_ROOT = '/workspace';
const WORKSPACE_DIRECTORY = `${WORKSPACE_ROOT}/opencode-cloud`;
const PERSISTENCE_MARKER = `${WORKSPACE_ROOT}/.opencode-persistence-ready`;
const BACKUP_TTL_SECONDS = 365 * 24 * 60 * 60;
const BACKUP_STORAGE_KEY = 'persistence:latest-backup';
const RESTORE_STORAGE_KEY = 'persistence:last-restore';
const ERROR_STORAGE_KEY = 'persistence:last-error';

type CheckpointReason = 'manual' | 'idle-stop';

interface StoredBackup {
  backup: DirectoryBackup;
  createdAt: string;
  reason: CheckpointReason;
}

interface PersistenceError {
  at: string;
  operation: 'checkpoint' | 'restore';
  message: string;
}

interface PersistenceStatus {
  hasBackup: boolean;
  backupId?: string;
  lastCheckpointAt?: string;
  lastCheckpointReason?: CheckpointReason;
  lastRestoreAt?: string;
  lastError?: PersistenceError;
}

/**
 * A Sandbox with an R2-backed /workspace snapshot.
 *
 * The container disk is ephemeral after sleep. The latest backup handle is
 * kept in this Durable Object's storage, restored once on each fresh runtime,
 * and replaced atomically whenever a new checkpoint succeeds.
 */
export class Sandbox extends BaseSandbox<Env> {
  private readonly persistenceState: DurableObjectState<{}>;
  private readonly persistenceEnv: Env;
  private restoreInProgress: Promise<void> | undefined;
  private checkpointInProgress: Promise<StoredBackup> | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.persistenceState = ctx;
    this.persistenceEnv = env;
  }

  async ensureWorkspaceRestored(): Promise<void> {
    if (!this.restoreInProgress) {
      this.restoreInProgress = this.restoreWorkspace().finally(() => {
        this.restoreInProgress = undefined;
      });
    }

    return this.restoreInProgress;
  }

  async checkpointWorkspace(): Promise<PersistenceStatus> {
    await this.createCheckpoint('manual');
    return this.getPersistenceStatus();
  }

  async getPersistenceStatus(): Promise<PersistenceStatus> {
    const [storedBackup, lastRestoreAt, lastError] = await Promise.all([
      this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY),
      this.persistenceState.storage.get<string>(RESTORE_STORAGE_KEY),
      this.persistenceState.storage.get<PersistenceError>(ERROR_STORAGE_KEY)
    ]);

    return {
      hasBackup: Boolean(storedBackup),
      ...(storedBackup
        ? {
            backupId: storedBackup.backup.id,
            lastCheckpointAt: storedBackup.createdAt,
            lastCheckpointReason: storedBackup.reason
          }
        : {}),
      ...(lastRestoreAt ? { lastRestoreAt } : {}),
      ...(lastError ? { lastError } : {})
    };
  }

  override async stop(
    signal?: Parameters<BaseSandbox<Env>['stop']>[0]
  ): Promise<void> {
    // The base Container calls stop() when sleepAfter expires. Snapshot before
    // allowing the ephemeral disk to disappear. A failed checkpoint aborts the
    // stop so data is not knowingly discarded.
    await this.createCheckpoint('idle-stop');
    await super.stop(signal);
  }

  private async restoreWorkspace(): Promise<void> {
    const marker = await this.exists(PERSISTENCE_MARKER);
    if (marker.exists) {
      return;
    }

    const storedBackup =
      await this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY);

    try {
      if (storedBackup) {
        await this.restoreBackup(storedBackup.backup);
        await this.persistenceState.storage.put(
          RESTORE_STORAGE_KEY,
          new Date().toISOString()
        );
      }

      // The marker is deliberately part of /workspace. It distinguishes a
      // fresh image from the currently restored writable filesystem.
      await this.writeFile(
        PERSISTENCE_MARKER,
        JSON.stringify({ readyAt: new Date().toISOString() })
      );
      await this.persistenceState.storage.delete(ERROR_STORAGE_KEY);
    } catch (error) {
      await this.recordPersistenceError('restore', error);
      throw error;
    }
  }

  private async createCheckpoint(
    reason: CheckpointReason
  ): Promise<StoredBackup> {
    if (!this.checkpointInProgress) {
      this.checkpointInProgress = this.doCreateCheckpoint(reason).finally(() => {
        this.checkpointInProgress = undefined;
      });
    }

    return this.checkpointInProgress;
  }

  private async doCreateCheckpoint(
    reason: CheckpointReason
  ): Promise<StoredBackup> {
    await this.ensureWorkspaceRestored();

    const previous =
      await this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY);

    try {
      await this.writeFile(
        PERSISTENCE_MARKER,
        JSON.stringify({ checkpointStartedAt: new Date().toISOString() })
      );
      await this.exec('sync');

      const backup = await this.createBackup({
        dir: WORKSPACE_ROOT,
        name: `opencode-${reason}`,
        ttl: BACKUP_TTL_SECONDS,
        localBucket: this.persistenceEnv.PERSISTENCE_LOCAL_BUCKET === 'true'
      });
      const storedBackup: StoredBackup = {
        backup,
        createdAt: new Date().toISOString(),
        reason
      };

      try {
        await this.persistenceState.storage.put(
          BACKUP_STORAGE_KEY,
          storedBackup
        );
      } catch (error) {
        await this.deleteBackupObjects(backup);
        throw error;
      }

      await this.persistenceState.storage.delete(ERROR_STORAGE_KEY);

      if (previous && previous.backup.id !== backup.id) {
        await this.deleteBackupObjects(previous.backup).catch((error) => {
          console.warn('Failed to delete previous workspace backup', error);
        });
      }

      return storedBackup;
    } catch (error) {
      await this.recordPersistenceError('checkpoint', error);
      throw error;
    }
  }

  private async deleteBackupObjects(backup: DirectoryBackup): Promise<void> {
    await this.persistenceEnv.BACKUP_BUCKET.delete([
      `backups/${backup.id}/data.sqsh`,
      `backups/${backup.id}/meta.json`
    ]);
  }

  private async recordPersistenceError(
    operation: PersistenceError['operation'],
    error: unknown
  ): Promise<void> {
    await this.persistenceState.storage.put(ERROR_STORAGE_KEY, {
      at: new Date().toISOString(),
      operation,
      message: error instanceof Error ? error.message : String(error)
    } satisfies PersistenceError);
  }
}

const SANDBOX_ID = 'opencode';
const OPENCODE_ENV = {
  // Keep OpenCode sessions and caches inside the directory that is snapshotted.
  // XDG_CONFIG_HOME is intentionally unchanged so gh keeps using its bundled
  // authentication under /root/.config.
  XDG_DATA_HOME: `${WORKSPACE_ROOT}/.opencode-state/data`,
  XDG_STATE_HOME: `${WORKSPACE_ROOT}/.opencode-state/state`,
  XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.opencode-state/cache`
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sandbox = getSandbox(env.Sandbox, SANDBOX_ID);

    if (url.pathname === '/api/persistence/status') {
      if (request.method !== 'GET') {
        return methodNotAllowed('GET');
      }
      return Response.json(await sandbox.getPersistenceStatus());
    }

    if (url.pathname === '/api/persistence/checkpoint') {
      if (request.method !== 'POST') {
        return methodNotAllowed('POST');
      }
      return Response.json(await sandbox.checkpointWorkspace());
    }

    if (url.pathname === '/api/persistence/stop') {
      if (request.method !== 'POST') {
        return methodNotAllowed('POST');
      }
      await sandbox.stop();
      return Response.json(await sandbox.getPersistenceStatus());
    }

    await sandbox.ensureWorkspaceRestored();

    if (request.method === 'POST' && url.pathname === '/api/test') {
      return handleSdkTest(sandbox);
    }

    const server = await createOpencodeServer(sandbox, {
      directory: WORKSPACE_DIRECTORY,
      config: OPENCODE_CONFIG,
      env: OPENCODE_ENV
    });

    return proxyToOpencode(request, sandbox, server);
  }
};

async function handleSdkTest(
  sandbox: ReturnType<typeof getSandbox>
): Promise<Response> {
  try {
    const { client } = await createOpencode<OpencodeClient>(sandbox, {
      directory: WORKSPACE_DIRECTORY,
      config: OPENCODE_CONFIG,
      env: OPENCODE_ENV
    });

    const session = await client.session.create({
      title: 'Test Session',
      directory: WORKSPACE_DIRECTORY
    });

    if (!session.data) {
      throw new Error(`Failed to create session: ${JSON.stringify(session)}`);
    }

    const promptResult = await client.session.prompt({
      sessionID: session.data.id,
      directory: WORKSPACE_DIRECTORY,
      model: {
        providerID: DEFAULT_PROVIDER_ID,
        modelID: DEFAULT_MODEL_ID
      },
      parts: [
        {
          type: 'text',
          text: 'Summarize the README.md file in 2-3 sentences. Be concise.'
        }
      ]
    });

    const parts = promptResult.data?.parts ?? [];
    const textPart = parts.find(
      (part): part is Part & { type: 'text'; text: string } =>
        part.type === 'text' && typeof part.text === 'string'
    );

    return new Response(textPart?.text ?? 'No response', {
      headers: { 'Content-Type': 'text/plain' }
    });
  } catch (error) {
    console.error('SDK test error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : undefined;

    return Response.json(
      { success: false, error: message, stack },
      { status: 500 }
    );
  }
}

function methodNotAllowed(allowedMethod: 'GET' | 'POST'): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allowedMethod }
  });
}
