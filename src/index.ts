/**
 * OpenCode Hub on Cloudflare Sandbox.
 *
 * The Worker owns the instance registry and the single-domain HTTP router.
 * Every logical instance maps to one Sandbox Durable Object (and therefore one
 * independently sleeping container) plus its own R2-backed workspace backup.
 */
import {
  Sandbox as BaseSandbox,
  ContainerProxy,
  getSandbox,
  type DirectoryBackup
} from '@cloudflare/sandbox';
import {
  createOpencode,
  createOpencodeServer
} from '@cloudflare/sandbox/opencode';
import type { Part } from '@opencode-ai/sdk/v2';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Hub } from './hub';
import { renderHubHtml } from './hub-ui';
import {
  CURRENT_IMAGE_KEY,
  HUB_DURABLE_OBJECT_ID,
  LEGACY_INSTANCE_ID,
  type ImageKey,
  type InstanceRecord,
  type InstanceRuntimeStatus,
  type InstanceView
} from './instances';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  OPENCODE_CONFIG
} from './opencode-config';

export { ContainerProxy, Hub };

const WORKSPACE_ROOT = '/workspace';
const WORKSPACE_DIRECTORY = `${WORKSPACE_ROOT}/opencode-cloud`;
const PERSISTENCE_MARKER = `${WORKSPACE_ROOT}/.opencode-persistence-ready`;
const BACKUP_TTL_SECONDS = 365 * 24 * 60 * 60;
const BACKUP_STORAGE_KEY = 'persistence:latest-backup';
const LEGACY_BACKUP_HANDLES_STORAGE_KEY = 'persistence:backup-handles';
const BACKUP_HANDLE_STORAGE_PREFIX = 'persistence:backup-handle:';
const RESTORE_STORAGE_KEY = 'persistence:last-restore';
const ERROR_STORAGE_KEY = 'persistence:last-error';
const PURGE_STORAGE_KEY = 'instance:purge-requested';
const IDENTITY_STORAGE_KEY = 'instance:identity';
const UI_INSTANCE_PARAM = '_hub';
const UI_COMPAT_VERSION = '2';
const OPENCODE_PORT = 4096;
const ACCESS_JWKS = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

const OPENCODE_ENV = {
  // Keep OpenCode sessions and caches inside the snapshotted directory.
  // XDG_CONFIG_HOME remains unchanged so gh uses its bundled authentication.
  XDG_DATA_HOME: `${WORKSPACE_ROOT}/.opencode-state/data`,
  XDG_STATE_HOME: `${WORKSPACE_ROOT}/.opencode-state/state`,
  XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.opencode-state/cache`
};

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
  trackedBackupCount: number;
  lastCheckpointAt?: string;
  lastCheckpointReason?: CheckpointReason;
  lastRestoreAt?: string;
  lastError?: PersistenceError;
}

interface InstanceIdentity {
  id: string;
  imageKey: ImageKey;
  state: 'active' | 'deleting';
  initializedAt: string;
}

interface AccessEnv {
  ACCESS_POLICY_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

/**
 * One Sandbox Durable Object is one Hub instance.
 *
 * Besides checkpoint/restore, it owns the deletion barrier: once purge starts,
 * no new OpenCode request may start, the container is destroyed without making
 * another checkpoint, every known R2 object is deleted, then DO storage is
 * cleared. A failed purge is retryable because the backup handles remain.
 */
export class Sandbox extends BaseSandbox<Env> {
  private readonly persistenceState: DurableObjectState<{}>;
  private readonly persistenceEnv: Env;
  private readonly lifecycleReady: Promise<void>;
  private restoreInProgress: Promise<void> | undefined;
  private checkpointInProgress: Promise<StoredBackup> | undefined;
  private purgeInProgress: Promise<void> | undefined;
  private purgeRequested = false;
  private instanceIdentity: InstanceIdentity | undefined;
  private instanceActive = false;
  private activeOperations = 0;
  private operationDrainWaiters = new Set<() => void>();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.persistenceState = ctx;
    this.persistenceEnv = env;
    this.lifecycleReady = ctx.blockConcurrencyWhile(async () => {
      const [purgeRequested, identity] = await Promise.all([
        ctx.storage.get<boolean>(PURGE_STORAGE_KEY),
        ctx.storage.get<InstanceIdentity>(IDENTITY_STORAGE_KEY)
      ]);
      this.purgeRequested = Boolean(purgeRequested);
      this.instanceIdentity = identity;
      this.instanceActive = identity?.state === 'active' && !purgeRequested;
    });
  }

  async initializeInstance(id: string, imageKey: ImageKey): Promise<void> {
    await this.lifecycleReady;
    if (this.purgeRequested) {
      throw new Error('A deleting instance cannot be initialized');
    }
    if (this.instanceIdentity) {
      if (
        this.instanceIdentity.id !== id ||
        this.instanceIdentity.imageKey !== imageKey
      ) {
        throw new Error('Sandbox identity does not match the Hub record');
      }
      if (this.instanceIdentity.state !== 'active') {
        throw new Error('A deleted instance cannot be reactivated');
      }
      this.instanceActive = true;
      return;
    }

    const identity: InstanceIdentity = {
      id,
      imageKey,
      state: 'active',
      initializedAt: new Date().toISOString()
    };
    await this.persistenceState.storage.put(IDENTITY_STORAGE_KEY, identity);
    this.instanceIdentity = identity;
    this.instanceActive = true;
  }

  async ensureWorkspaceRestored(): Promise<void> {
    await this.lifecycleReady;
    this.assertInstanceActive();

    if (!this.restoreInProgress) {
      this.restoreInProgress = this.restoreWorkspace().finally(() => {
        this.restoreInProgress = undefined;
      });
    }

    return this.restoreInProgress;
  }

  async checkpointWorkspace(): Promise<PersistenceStatus> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      await this.createCheckpoint('manual');
      return this.getPersistenceStatus();
    } finally {
      this.finishActiveOperation();
    }
  }

  async getPersistenceStatus(): Promise<PersistenceStatus> {
    const [storedBackup, trackedBackups, lastRestoreAt, lastError] =
      await Promise.all([
        this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY),
        this.getTrackedBackupHandles(),
        this.persistenceState.storage.get<string>(RESTORE_STORAGE_KEY),
        this.persistenceState.storage.get<PersistenceError>(ERROR_STORAGE_KEY)
      ]);

    return {
      hasBackup: Boolean(storedBackup),
      trackedBackupCount: mergeBackupHandles(
        trackedBackups,
        storedBackup?.backup
      ).length,
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

  async getInstanceRuntimeStatus(): Promise<InstanceRuntimeStatus> {
    await this.lifecycleReady;
    const [state, persistence] = await Promise.all([
      this.getState(),
      this.getPersistenceStatus()
    ]);

    return {
      container: state.status,
      ...(this.persistenceState.container?.running !== true &&
      (state.status === 'healthy' || state.status === 'running')
        ? { container: 'stopped' as const }
        : {}),
      containerLastChangedAt: new Date(state.lastChange).toISOString(),
      ...('exitCode' in state && state.exitCode !== undefined
        ? { exitCode: state.exitCode }
        : {}),
      deleting: this.purgeRequested,
      platformRunning: this.persistenceState.container?.running === true,
      persistence
    };
  }

  /** Restore the workspace and make sure this instance's server is listening. */
  async prepareOpencodeRequest(): Promise<void> {
    await this.lifecycleReady;
    if (!this.instanceActive || this.purgeRequested) {
      throw new Error('Instance is not active');
    }

    this.beginActiveOperation();
    try {
      await this.ensureWorkspaceRestored();
      this.assertInstanceActive();
      await createOpencodeServer(this, {
        port: OPENCODE_PORT,
        directory: WORKSPACE_DIRECTORY,
        config: OPENCODE_CONFIG,
        env: OPENCODE_ENV
      });
      this.assertInstanceActive();
    } finally {
      this.finishActiveOperation();
    }
  }

  override async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): Promise<Response> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      return await super.containerFetch(requestOrUrl, portOrInit, portParam);
    } finally {
      this.finishActiveOperation();
    }
  }

  async runSdkTest(): Promise<Response> {
    await this.lifecycleReady;
    this.beginActiveOperation();

    try {
      await this.ensureWorkspaceRestored();
      const { client } = await createOpencode<OpencodeClient>(this, {
        port: OPENCODE_PORT,
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
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    } catch (error) {
      console.error('SDK test error:', error);
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ success: false, error: message }, { status: 500 });
    } finally {
      this.finishActiveOperation();
    }
  }

  async purgeInstance(): Promise<void> {
    await this.lifecycleReady;
    if (!this.purgeInProgress) {
      this.purgeInProgress = this.doPurgeInstance().finally(() => {
        this.purgeInProgress = undefined;
      });
    }
    return this.purgeInProgress;
  }

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return super.fetch(request);
    }

    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      await this.ensureWorkspaceRestored();
      await createOpencodeServer(this, {
        port: OPENCODE_PORT,
        directory: WORKSPACE_DIRECTORY,
        config: OPENCODE_CONFIG,
        env: OPENCODE_ENV
      });
      this.assertInstanceActive();
      // WebSockets must cross the Durable Object fetch boundary. The Worker
      // reaches this method via getSandbox(...).wsConnect(), not JSRPC.
      return await super.fetch(request);
    } finally {
      this.finishActiveOperation();
    }
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.lifecycleReady;
    if (!this.instanceActive || this.purgeRequested) {
      return;
    }
    this.beginActiveOperation();
    try {
      await super.alarm(alarmInfo);
    } finally {
      this.finishActiveOperation();
    }
  }

  override async stop(
    signal?: Parameters<BaseSandbox<Env>['stop']>[0]
  ): Promise<void> {
    // The base Container calls stop() when sleepAfter expires. Snapshot before
    // allowing the ephemeral disk to disappear. A failed checkpoint aborts the
    // stop so data is not knowingly discarded.
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      await this.createCheckpoint('idle-stop');
      await super.stop(signal);
    } finally {
      this.finishActiveOperation();
    }
  }

  private async doPurgeInstance(): Promise<void> {
    this.purgeRequested = true;
    this.instanceActive = false;
    const deletingIdentity = this.instanceIdentity
      ? { ...this.instanceIdentity, state: 'deleting' as const }
      : undefined;
    await this.persistenceState.storage.put({
      [PURGE_STORAGE_KEY]: true,
      ...(deletingIdentity
        ? { [IDENTITY_STORAGE_KEY]: deletingIdentity }
        : {})
    });
    this.instanceIdentity = deletingIdentity;
    await this.waitForOperationDrain();

    const [latest, tracked] = await Promise.all([
      this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY),
      this.getTrackedBackupHandles()
    ]);
    const owned = await this.discoverOwnedBackups();
    const backups = mergeBackupHandles(
      tracked,
      latest?.backup,
      ...owned
    );

    // destroy() is intentionally used instead of stop(): deletion must not
    // create one final backup after the purge barrier has been raised.
    await this.destroy();
    await this.waitForContainerMonitorToSettle();
    await this.deleteBackupObjects(backups);
    await this.persistenceState.storage.deleteAll();
  }

  private async waitForContainerMonitorToSettle(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await this.getState();
      if (
        this.persistenceState.container?.running !== true &&
        state.status !== 'running' &&
        state.status !== 'healthy' &&
        state.status !== 'stopping'
      ) {
        return;
      }
      await scheduler.wait(100);
    }
    throw new Error('Container monitor did not settle after destroy');
  }

  private async waitForOperationDrain(): Promise<void> {
    if (this.activeOperations === 0) {
      return;
    }
    await new Promise<void>((resolve) =>
      this.operationDrainWaiters.add(resolve)
    );
  }

  private beginActiveOperation(): void {
    this.assertInstanceActive();
    this.activeOperations += 1;
  }

  private finishActiveOperation(): void {
    this.activeOperations -= 1;
    if (this.activeOperations === 0) {
      for (const resolve of this.operationDrainWaiters) {
        resolve();
      }
      this.operationDrainWaiters.clear();
    }
  }

  private assertInstanceActive(): void {
    if (!this.instanceActive || this.purgeRequested) {
      throw new Error('Instance is not active');
    }
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

      // The marker lives inside /workspace and therefore distinguishes a fresh
      // image from the currently restored writable filesystem.
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
    await this.lifecycleReady;
    this.assertInstanceActive();

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

    const [previous, tracked] = await Promise.all([
      this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY),
      this.getTrackedBackupHandles()
    ]);

    try {
      await this.writeFile(
        PERSISTENCE_MARKER,
        JSON.stringify({ checkpointStartedAt: new Date().toISOString() })
      );
      await this.exec('sync');

      const backup = await this.createBackup({
        dir: WORKSPACE_ROOT,
        name: `opencode:${this.instanceIdentity!.id}:${reason}`,
        ttl: BACKUP_TTL_SECONDS,
        localBucket: this.persistenceEnv.PERSISTENCE_LOCAL_BUCKET === 'true'
      });
      const storedBackup: StoredBackup = {
        backup,
        createdAt: new Date().toISOString(),
        reason
      };
      const knownBackups = mergeBackupHandles(
        tracked,
        previous?.backup,
        backup
      );

      try {
        // A multi-key storage put records the latest handle and cleanup ledger
        // together. If it fails, remove the newly-created R2 objects.
        await this.persistenceState.storage.put({
          [BACKUP_STORAGE_KEY]: storedBackup,
          [backupHandleStorageKey(backup.id)]: backup
        });
      } catch (error) {
        await this.deleteBackupObjects([backup]);
        throw error;
      }

      await this.persistenceState.storage.delete(ERROR_STORAGE_KEY);

      // Keep failed deletions in the ledger so a later checkpoint or instance
      // purge retries them instead of turning them into untracked R2 objects.
      const remaining: DirectoryBackup[] = [backup];
      for (const stale of knownBackups) {
        if (stale.id === backup.id) {
          continue;
        }
        try {
          await this.deleteBackupObjects([stale]);
        } catch (error) {
          remaining.push(stale);
          console.warn('Failed to delete stale workspace backup', error);
        }
      }
      await this.replaceBackupHandleLedger(remaining).catch((error) => {
        console.warn('Failed to compact workspace backup ledger', error);
      });

      return storedBackup;
    } catch (error) {
      await this.recordPersistenceError('checkpoint', error);
      throw error;
    }
  }

  private async getTrackedBackupHandles(): Promise<DirectoryBackup[]> {
    const [legacy, ledger] = await Promise.all([
      this.persistenceState.storage.get<DirectoryBackup[]>(
        LEGACY_BACKUP_HANDLES_STORAGE_KEY
      ),
      this.listBackupHandleLedger()
    ]);
    return mergeBackupHandles(
      legacy ?? [],
      ...ledger.values()
    );
  }

  private async listBackupHandleLedger(): Promise<
    Map<string, DirectoryBackup>
  > {
    const result = new Map<string, DirectoryBackup>();
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.persistenceState.storage.list<DirectoryBackup>({
        prefix: BACKUP_HANDLE_STORAGE_PREFIX,
        limit: 1000,
        ...(startAfter ? { startAfter } : {})
      });
      if (page.size === 0) {
        break;
      }
      for (const [key, backup] of page) {
        result.set(key, backup);
        startAfter = key;
      }
      if (page.size < 1000) {
        break;
      }
    }
    return result;
  }

  private async replaceBackupHandleLedger(
    backups: DirectoryBackup[]
  ): Promise<void> {
    const existing = await this.listBackupHandleLedger();
    const desired = new Map(
      backups.map((backup) => [backupHandleStorageKey(backup.id), backup])
    );
    if (desired.size > 0) {
      await this.persistenceState.storage.put(Object.fromEntries(desired));
    }

    const staleKeys = [...existing.keys()].filter(
      (key) => !desired.has(key)
    );
    await this.persistenceState.storage.delete([
      ...staleKeys,
      LEGACY_BACKUP_HANDLES_STORAGE_KEY
    ]);
  }

  private async deleteBackupObjects(
    backups: DirectoryBackup[]
  ): Promise<void> {
    for (const backup of backups) {
      const prefix = `backups/${backup.id}/`;
      for (;;) {
        const page = await this.persistenceEnv.BACKUP_BUCKET.list({
          prefix
        });
        if (page.objects.length === 0) {
          break;
        }
        await this.persistenceEnv.BACKUP_BUCKET.delete(
          page.objects.map((object) => object.key)
        );
      }
    }
  }

  private async discoverOwnedBackups(): Promise<DirectoryBackup[]> {
    const owner = this.instanceIdentity?.id;
    if (!owner) {
      return [];
    }

    const discovered: DirectoryBackup[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.persistenceEnv.BACKUP_BUCKET.list({
        prefix: 'backups/',
        ...(cursor ? { cursor } : {})
      });
      const metadataObjects = page.objects.filter((object) =>
        object.key.endsWith('/meta.json')
      );
      for (const object of metadataObjects) {
        const metadata = await this.persistenceEnv.BACKUP_BUCKET.get(object.key);
        if (!metadata) {
          continue;
        }
        try {
          const value = (await metadata.json()) as {
            id?: unknown;
            dir?: unknown;
            name?: unknown;
          };
          if (
            typeof value.id === 'string' &&
            typeof value.dir === 'string' &&
            typeof value.name === 'string' &&
            (value.name.startsWith(`opencode:${owner}:`) ||
              (owner === LEGACY_INSTANCE_ID &&
                (value.name === 'opencode-manual' ||
                  value.name === 'opencode-idle-stop')))
          ) {
            discovered.push({ id: value.id, dir: value.dir });
          }
        } catch (error) {
          console.warn(`Failed to inspect backup metadata ${object.key}`, error);
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return discovered;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const accessFailure = await validateHubAccess(request, env, url);
      if (accessFailure) {
        return accessFailure;
      }

      if (url.pathname === '/api/instances' || url.pathname.startsWith('/api/instances/')) {
        return await handleHubApi(request, env);
      }

      if (url.pathname === '/hub/bootstrap.js') {
        return serveUiBootstrap(url);
      }

      if (url.pathname.startsWith('/gateway/')) {
        return await proxyGatewayRequest(request, env);
      }

      if (url.pathname.startsWith('/ui/')) {
        return await proxyScopedUiAsset(request, env);
      }

      if (url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
        return await proxyGlobalUiAsset(request, env);
      }

      const knownRootAsset = isKnownRootUiAsset(url.pathname);
      if (knownRootAsset) {
        return await proxyGlobalUiAsset(request, env);
      }

      const openMatch = /^\/instances\/([^/]+)\/?$/.exec(url.pathname);
      if (openMatch) {
        if (request.method !== 'GET') {
          return methodNotAllowed('GET');
        }
        const instance = await requireReadyInstance(
          env,
          decodeRouteSegment(openMatch[1])
        );
        const target = new URL('/', url);
        target.searchParams.set(UI_INSTANCE_PARAM, instance.id);
        return Response.redirect(target.toString(), 302);
      }

      const uiInstanceId = url.searchParams.get(UI_INSTANCE_PARAM);
      if (uiInstanceId && request.method === 'GET' && acceptsHtml(request)) {
        return await serveOpencodeUi(request, env, uiInstanceId);
      }

      if (url.pathname === '/' && request.method === 'GET') {
        return renderHubHtml();
      }

      return Response.json({ error: 'Not Found' }, { status: 404 });
    } catch (error) {
      console.error('Worker request failed', error);
      if (error instanceof HttpError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 }
      );
    }
  }
};

async function validateHubAccess(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | undefined> {
  const localBypass =
    env.PERSISTENCE_LOCAL_BUCKET === 'true' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]');

  if (!localBypass) {
    const accessEnv = env as Env & AccessEnv;
    const issuer = accessEnv.ACCESS_TEAM_DOMAIN?.replace(/\/$/, '');
    const audience = accessEnv.ACCESS_POLICY_AUD;
    if (!issuer || !audience) {
      return Response.json(
        { error: 'Cloudflare Access is not configured for this Hub' },
        { status: 503 }
      );
    }

    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) {
      return Response.json(
        { error: 'Cloudflare Access authentication is required' },
        { status: 403 }
      );
    }

    try {
      let jwks = ACCESS_JWKS.get(issuer);
      if (!jwks) {
        jwks = createRemoteJWKSet(
          new URL(`${issuer}/cdn-cgi/access/certs`)
        );
        ACCESS_JWKS.set(issuer, jwks);
      }
      await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        issuer,
        audience
      });
    } catch (error) {
      console.warn('Cloudflare Access JWT validation failed', error);
      return Response.json(
        { error: 'Cloudflare Access token is invalid' },
        { status: 403 }
      );
    }
  }

  if (isWebSocketUpgrade(request)) {
    if (request.headers.get('origin') !== url.origin) {
      return Response.json(
        { error: 'Cross-origin WebSocket is not allowed' },
        { status: 403 }
      );
    }
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return Response.json(
        { error: 'Cross-origin mutation is not allowed' },
        { status: 403 }
      );
    }
  }
  return undefined;
}

async function handleHubApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hub = getHub(env);

  if (url.pathname === '/api/instances') {
    if (request.method === 'GET') {
      const records = await hub.listInstances();
      const instances = await Promise.all(
        records.map((record) => getInstanceView(env, record))
      );
      return json(instances);
    }
    if (request.method === 'POST') {
      const instance = await hub.createInstance();
      return json(await getInstanceView(env, instance), 201);
    }
    return methodNotAllowed('GET, POST');
  }

  const match = /^\/api\/instances\/([^/]+)(?:\/([^/]+))?$/.exec(
    url.pathname
  );
  if (!match) {
    throw new HttpError(404, 'Instance API route not found');
  }
  const id = decodeRouteSegment(match[1]);
  const action = match[2];

  if (!action) {
    if (request.method === 'GET') {
      const record = await requireInstance(env, id);
      return json(await getInstanceView(env, record));
    }
    if (request.method === 'DELETE') {
      const deleting = await hub.beginDelete(id);
      if (!deleting) {
        throw new HttpError(404, 'Instance not found');
      }
      return json(
        {
          deleting: true,
          id,
          operationId: deleting.deleteOperationId
        },
        202
      );
    }
    return methodNotAllowed('GET, DELETE');
  }

  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  const record = await requireReadyInstance(env, id);
  const sandbox = resolveSandbox(env, record);
  switch (action) {
    case 'checkpoint':
      return json(await sandbox.checkpointWorkspace());
    case 'stop':
      await sandbox.stop();
      return json(await sandbox.getInstanceRuntimeStatus());
    case 'test':
      return sandbox.runSdkTest();
    default:
      throw new HttpError(404, 'Instance action not found');
  }
}

async function getInstanceView(
  env: Env,
  record: InstanceRecord
): Promise<InstanceView> {
  if (record.lifecycle !== 'ready') {
    return {
      ...record,
      runtime: unknownRuntimeStatus(true)
    };
  }
  try {
    return {
      ...record,
      runtime: await resolveSandbox(env, record).getInstanceRuntimeStatus()
    };
  } catch (error) {
    console.warn(`Failed to read instance ${record.id} status`, error);
    return {
      ...record,
      runtime: unknownRuntimeStatus(false)
    };
  }
}

async function proxyGatewayRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/gateway\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'Gateway route not found');
  }

  const id = decodeRouteSegment(match[1]);
  const instance = await requireReadyInstance(env, id);
  url.pathname = match[2] || '/';
  const rewritten = createContainerRequest(url, request);
  const sandbox = resolveSandbox(env, instance);
  if (isWebSocketUpgrade(request)) {
    return sandbox.wsConnect(rewritten, OPENCODE_PORT);
  }
  const upstream = await proxyPreparedContainerRequest(sandbox, rewritten);
  return rewriteGatewayResponse(
    upstream,
    `/gateway/${encodeURIComponent(instance.id)}`,
    new URL(request.url).origin
  );
}

async function serveOpencodeUi(
  request: Request,
  env: Env,
  id: string
): Promise<Response> {
  const instance = await requireReadyInstance(env, id);
  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = '/';
  upstreamUrl.search = '';
  upstreamUrl.hash = '';
  const upstream = await proxyPreparedContainerRequest(
    resolveSandbox(env, instance),
    createContainerRequest(upstreamUrl, request)
  );

  if (!upstream.ok) {
    return upstream;
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    return upstream;
  }

  const scope = `/ui/${encodeURIComponent(instance.id)}`;
  const bootstrap = `/hub/bootstrap.js?${UI_INSTANCE_PARAM}=${encodeURIComponent(instance.id)}&v=${UI_COMPAT_VERSION}`;
  let html = await upstream.text();
  html = html
    .replaceAll('src="/', `src="${scope}/`)
    .replaceAll("src='/", `src='${scope}/`)
    .replaceAll('href="/', `href="${scope}/`)
    .replaceAll("href='/", `href='${scope}/`)
    .replace(
      /src="(\/ui\/[^"?]+\/assets\/index-[^"?]+\.js)"/,
      `src="$1?hub-ui=${UI_COMPAT_VERSION}"`
    )
    .replace(
      '<head>',
      `<head><script src="${bootstrap}"></script>`
    );

  const headers = new Headers(upstream.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.set('Cache-Control', 'no-store');
  return new Response(html, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

async function proxyScopedUiAsset(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/ui\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'UI asset route not found');
  }
  const instance = await requireReadyInstance(
    env,
    decodeRouteSegment(match[1])
  );
  url.pathname = match[2] || '/';
  const rewritten = createContainerRequest(url, request);
  const upstream = await proxyPreparedContainerRequest(
    resolveSandbox(env, instance),
    rewritten
  );
  if (
    upstream.ok &&
    /^\/assets\/index-[^/]+\.js$/.test(url.pathname) &&
    (upstream.headers.get('content-type') ?? '').includes('javascript')
  ) {
    // The stock web build always injects location.origin as a built-in local
    // server. Under a single-domain Hub that creates a second, unscoped server
    // next to the instance gateway and opens a failing event stream at `/`.
    // Keep the persisted, tab-local gateway supplied by our bootstrap as the
    // only server. This small compatibility patch is deliberately limited to
    // the entry bundle and fails open when a future OpenCode build changes.
    const source = await upstream.text();
    const serverPattern =
      /servers:\[[A-Za-z_$][\w$]*\],disableHealthCheck:!0/g;
    const matches = source.match(serverPattern);
    const headers = new Headers(upstream.headers);
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    headers.delete('ETag');
    headers.delete('Last-Modified');
    headers.delete('Content-Digest');
    headers.delete('Digest');
    if (matches?.length !== 1) {
      console.error('OpenCode entry bundle server patch did not match once');
      headers.set('Cache-Control', 'no-store');
      return new Response(
        'throw new Error("OpenCode Hub UI compatibility check failed")',
        { status: 502, headers }
      );
    }
    const patched = source.replace(
      serverPattern,
      'servers:[],disableHealthCheck:!0'
    );
    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    return new Response(patched, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  }
  if (
    url.pathname === '/site.webmanifest' &&
    upstream.ok &&
    (upstream.headers.get('content-type') ?? '').includes('application/manifest')
  ) {
    const scope = `/ui/${encodeURIComponent(instance.id)}`;
    const manifest = (await upstream.text())
      .replace('"id": "/"', `"id": "/instances/${encodeURIComponent(instance.id)}"`)
      .replace(
        '"start_url": "/"',
        `"start_url": "/?${UI_INSTANCE_PARAM}=${encodeURIComponent(instance.id)}"`
      )
      .replaceAll('"src": "/', `"src": "${scope}/`);
    const headers = new Headers(upstream.headers);
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    return new Response(manifest, { status: upstream.status, headers });
  }
  return upstream;
}

async function proxyGlobalUiAsset(
  request: Request,
  env: Env
): Promise<Response> {
  const id = instanceIdFromReferrer(request.headers.get('referer'));
  if (!id) {
    throw new HttpError(404, 'UI asset has no instance context');
  }
  const instance = await requireReadyInstance(env, id);
  const response = await proxyPreparedContainerRequest(
    resolveSandbox(env, instance),
    createContainerRequest(new URL(request.url), request)
  );
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.append('Vary', 'Referer');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function serveUiBootstrap(url: URL): Response {
  const id = url.searchParams.get(UI_INSTANCE_PARAM);
  if (!id || !isSafeInstanceId(id)) {
    return new Response('Invalid instance id', { status: 400 });
  }

  const encodedId = JSON.stringify(id);
  const encodedParam = JSON.stringify(UI_INSTANCE_PARAM);
  const source = String.raw`(() => {
  const instanceId = ${encodedId};
  const instanceParam = ${encodedParam};
  const gateway = location.origin + "/gateway/" + encodeURIComponent(instanceId);
  const defaultServerKey = "opencode.settings.dat:defaultServerUrl";
  const serverStoreKey = "opencode.global.dat:server";
  const physicalDefaultServerKey = "opencode.hub.dat:" + instanceId + ":default-server";
  const physicalServerStoreKey = "opencode.hub.dat:" + instanceId + ":server";

  // OpenCode's web bootstrap accepts a default server key only when that
  // server is also present in its persisted server list. Supply a tab-local
  // view of both values before the deferred main module runs. The override is
  // scoped to this Window, so two Hub instances open in separate tabs cannot
  // change each other's active backend.
  const nativeGetItem = Storage.prototype.getItem;
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  let persisted = null;
  try {
    persisted = nativeGetItem.call(localStorage, physicalServerStoreKey)
      || nativeGetItem.call(localStorage, serverStoreKey);
  } catch {}
  let serverState = { list: [], projects: {}, lastProject: {}, recentlyClosed: {} };
  try {
    const parsed = JSON.parse(persisted || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      serverState = { ...serverState, ...parsed };
    }
  } catch {}
  const storedUrl = (entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    if (entry.type === "http") return entry.http?.url || "";
    return entry.http?.url || entry.url || "";
  };
  const hubGatewayPrefix = location.origin + "/gateway/";
  const list = Array.isArray(serverState.list)
    ? serverState.list.filter((entry) => {
        const url = storedUrl(entry).replace(/\/$/, "");
        return !url.startsWith(hubGatewayPrefix) && url !== location.origin;
      })
    : [];
  list.push({
    type: "http",
    displayName: "Hub · " + instanceId,
    http: { url: gateway }
  });
  let virtualServerState = JSON.stringify({ ...serverState, list });
  Storage.prototype.getItem = function(key) {
    if (this === localStorage && key === defaultServerKey) return gateway;
    if (this === localStorage && key === serverStoreKey) return virtualServerState;
    return nativeGetItem.call(this, key);
  };
  Storage.prototype.setItem = function(key, value) {
    if (this === localStorage && key === defaultServerKey) {
      return nativeSetItem.call(this, physicalDefaultServerKey, String(value));
    }
    if (this === localStorage && key === serverStoreKey) {
      virtualServerState = String(value);
      return nativeSetItem.call(this, physicalServerStoreKey, virtualServerState);
    }
    return nativeSetItem.call(this, key, value);
  };
  Storage.prototype.removeItem = function(key) {
    if (this === localStorage && key === defaultServerKey) {
      return nativeRemoveItem.call(this, physicalDefaultServerKey);
    }
    if (this === localStorage && key === serverStoreKey) {
      virtualServerState = JSON.stringify({ list: [], projects: {}, lastProject: {}, recentlyClosed: {} });
      return nativeRemoveItem.call(this, physicalServerStoreKey);
    }
    return nativeRemoveItem.call(this, key);
  };

  const preserveInstance = (value) => {
    if (value === undefined || value === null) return value;
    try {
      const next = new URL(String(value), location.href);
      if (next.origin !== location.origin) return value;
      next.searchParams.set(instanceParam, instanceId);
      return next.pathname + next.search + next.hash;
    } catch { return value; }
  };

  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function(state, unused, next) {
    return pushState.call(this, state, unused, preserveInstance(next));
  };
  history.replaceState = function(state, unused, next) {
    return replaceState.call(this, state, unused, preserveInstance(next));
  };

  const current = new URL(location.href);
  if (current.searchParams.get(instanceParam) !== instanceId) {
    current.searchParams.set(instanceParam, instanceId);
    replaceState.call(history, history.state, "", current.pathname + current.search + current.hash);
  }

  addEventListener("DOMContentLoaded", () => {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Hub";
    back.title = "返回实例管理";
    back.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;border:1px solid #444b55;border-radius:7px;background:#171a1f;color:#d9dde3;padding:6px 10px;font:12px ui-monospace,monospace;cursor:pointer;box-shadow:0 4px 18px #0008";
    back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign("/");
    });
    document.body.append(back);
  });
})();`;

  return new Response(source, {
    headers: {
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function createContainerRequest(target: URL, request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name.toLowerCase().startsWith('cf-access-') ||
      name.toLowerCase() === 'cf-authorization'
    ) {
      headers.delete(name);
    }
  }

  const cookie = headers.get('cookie');
  if (cookie) {
    const sanitized = cookie
      .split(';')
      .map((part) => part.trim())
      .filter(
        (part) => !part.toLowerCase().startsWith('cf_authorization=')
      )
      .join('; ');
    if (sanitized) {
      headers.set('cookie', sanitized);
    } else {
      headers.delete('cookie');
    }
  }

  return new Request(target.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal
  });
}

async function proxyPreparedContainerRequest(
  sandbox: Sandbox,
  request: Request
): Promise<Response> {
  // Keep streaming Response bodies on the built-in Sandbox RPC path. Returning
  // them through a custom Durable Object RPC method can pin that method for the
  // lifetime of SSE responses and eventually stall unrelated requests.
  await sandbox.prepareOpencodeRequest();
  return await sandbox.containerFetch(request, OPENCODE_PORT);
}

function resolveSandbox(env: Env, instance: InstanceRecord): Sandbox {
  // imageKey is deliberately part of the registry now. Adding a future image
  // means adding another Sandbox class/binding and one resolver case; records,
  // API routes, and UI do not need a schema change.
  switch (instance.imageKey) {
    case CURRENT_IMAGE_KEY:
      return getSandbox(env.Sandbox, instance.id, { normalizeId: true });
    default:
      throw new HttpError(501, `Unsupported image: ${String(instance.imageKey)}`);
  }
}

function getHub(env: Env) {
  return env.Hub.getByName(HUB_DURABLE_OBJECT_ID);
}

async function requireInstance(env: Env, id: string): Promise<InstanceRecord> {
  if (!isSafeInstanceId(id)) {
    throw new HttpError(400, 'Invalid instance id');
  }
  const instance = await getHub(env).getInstance(id);
  if (!instance) {
    throw new HttpError(404, 'Instance not found');
  }
  return instance;
}

async function requireReadyInstance(
  env: Env,
  id: string
): Promise<InstanceRecord> {
  const instance = await requireInstance(env, id);
  if (instance.lifecycle !== 'ready') {
    throw new HttpError(
      409,
      instance.lifecycle === 'deleting'
        ? 'Instance is being deleted'
        : 'Instance deletion failed; retry deletion from the Hub'
    );
  }
  return instance;
}

function backupHandleStorageKey(id: string): string {
  return `${BACKUP_HANDLE_STORAGE_PREFIX}${id}`;
}

function mergeBackupHandles(
  handles: DirectoryBackup[],
  ...optional: Array<DirectoryBackup | undefined>
): DirectoryBackup[] {
  const merged = new Map<string, DirectoryBackup>();
  for (const backup of [...handles, ...optional]) {
    if (backup) {
      merged.set(backup.id, backup);
    }
  }
  return [...merged.values()];
}

function unknownRuntimeStatus(deleting: boolean): InstanceRuntimeStatus {
  return {
    container: 'unknown',
    deleting,
    persistence: {
      hasBackup: false,
      trackedBackupCount: 0
    },
    platformRunning: false
  };
}

function isWebSocketUpgrade(request: Request): boolean {
  return (
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    (request.headers.get('connection') ?? '')
      .toLowerCase()
      .split(',')
      .some((value) => value.trim() === 'upgrade')
  );
}

function rewriteGatewayResponse(
  response: Response,
  gatewayPrefix: string,
  publicOrigin: string
): Response {
  const headers = new Headers(response.headers);
  for (const name of ['Location', 'Content-Location']) {
    const value = headers.get(name);
    if (value) {
      headers.set(
        name,
        prefixUpstreamLocation(value, gatewayPrefix, publicOrigin)
      );
    }
  }
  const link = headers.get('Link');
  if (link) {
    headers.set(
      'Link',
      link.replace(/<\/(?!\/)([^>]*)>/g, `<${gatewayPrefix}/$1>`)
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function prefixUpstreamLocation(
  value: string,
  gatewayPrefix: string,
  publicOrigin: string
): string {
  if (value.startsWith('/') && !value.startsWith(`${gatewayPrefix}/`)) {
    return `${gatewayPrefix}${value}`;
  }
  try {
    const location = new URL(value);
    if (
      location.origin === publicOrigin ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1'
    ) {
      return `${publicOrigin}${gatewayPrefix}${location.pathname}${location.search}${location.hash}`;
    }
  } catch {
    // Relative non-root locations remain relative to the gateway request URL.
  }
  return value;
}

function instanceIdFromReferrer(referrer: string | null): string | undefined {
  if (!referrer) {
    return undefined;
  }
  try {
    const url = new URL(referrer);
    const fromQuery = url.searchParams.get(UI_INSTANCE_PARAM);
    if (fromQuery && isSafeInstanceId(fromQuery)) {
      return fromQuery;
    }
    const scoped = /^\/ui\/([^/]+)/.exec(url.pathname);
    if (scoped) {
      const id = decodeRouteSegment(scoped[1]);
      return isSafeInstanceId(id) ? id : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isKnownRootUiAsset(pathname: string): boolean {
  return [
    '/favicon-96x96-v3.png',
    '/favicon-v3.svg',
    '/favicon-v3.ico',
    '/apple-touch-icon-v3.png',
    '/site.webmanifest',
    '/social-share.png'
  ].includes(pathname);
}

function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

function decodeRouteSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'Malformed route');
  }
}

function isSafeInstanceId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' }
  });
}

function methodNotAllowed(allowedMethods: string): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allowedMethods }
  });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
