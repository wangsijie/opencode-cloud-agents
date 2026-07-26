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
  createOpencodeServer
} from '@cloudflare/sandbox/opencode';
import type { Part } from '@opencode-ai/sdk/v2';
import {
  createOpencodeClient,
  type OpencodeClient
} from '@opencode-ai/sdk/v2/client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Hub } from './hub';
import { renderHubHtml } from './hub-ui';
import {
  ensureLifecycleInitialized,
  InstanceWakePendingError,
  wakeInstanceRuntime,
  type CreateOpencodeSessionInput,
  type PromptOpencodeSessionInput
} from './instance-runtime';
import {
  LifecycleCoordinator,
  type LifecycleStatus
} from './lifecycle';
import {
  HUB_DURABLE_OBJECT_ID,
  type InstanceRecord,
  type InstanceRuntimeStatus,
  type InstanceView
} from './instances';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REF,
  DEFAULT_PROVIDER_ID,
  isModelRef,
  MODEL_OPTIONS,
  OPENCODE_CONFIG
} from './opencode-config';
import { SessionAgent } from './session-agent';
import {
  deriveSessionTitle,
  normalizeSessionPrompt,
  type SessionRecord,
  type SessionView
} from './sessions';
import {
  extractOpenCodeLocation,
  GLOBAL_SESSION_LIST_PATH,
  openCodeLocationsFromGlobalSessions,
  openCodeRouteRequiresWorkLease,
  openCodeLocationKey,
  queryOpenCodeActivity,
  type OpenCodeLocation
} from './opencode-activity';
import {
  findRepo,
  isRepoKey,
  REPOS,
  repoWorkspaceDirectory,
  WORKSPACE_ROOT
} from './repos';

export { ContainerProxy, Hub, LifecycleCoordinator, SessionAgent };

const WORKSPACE_DIRECTORY = WORKSPACE_ROOT;
const PERSISTENCE_MARKER = `${WORKSPACE_ROOT}/.opencode-persistence-ready`;
const BACKUP_TTL_SECONDS = 365 * 24 * 60 * 60;
const BACKUP_STORAGE_KEY = 'persistence:latest-backup';
const LEGACY_BACKUP_HANDLES_STORAGE_KEY = 'persistence:backup-handles';
const BACKUP_HANDLE_STORAGE_PREFIX = 'persistence:backup-handle:';
const RESTORE_STORAGE_KEY = 'persistence:last-restore';
const ERROR_STORAGE_KEY = 'persistence:last-error';
const PURGE_STORAGE_KEY = 'instance:purge-requested';
const IDENTITY_STORAGE_KEY = 'instance:identity';
const RUNTIME_GATE_STORAGE_KEY = 'runtime:gate';
const KNOWN_LOCATIONS_STORAGE_KEY = 'runtime:known-locations';
const UI_INSTANCE_PARAM = '_hub';
const UI_RUNTIME_PARAM = '_runtime';
const UI_COMPAT_VERSION = '4';
const UI_ASSET_VERSION_SEGMENT = `__hub-v${UI_COMPAT_VERSION}`;
const OPENCODE_PORT = 4096;
const RUNTIME_EPOCH_HEADER = 'x-opencode-hub-runtime';
const QUIESCE_SETTLE_MS = 1_500;
const ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_TERMINATION_TIMEOUT_MS = 10_000;
const REPO_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_KNOWN_OPENCODE_LOCATIONS = 64;
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
  /** Catalog repository provisioned during wake. */
  repoKey: string;
  state: 'active' | 'deleting';
  initializedAt: string;
}

type RuntimeGatePhase =
  | 'waking'
  | 'running'
  | 'quiescing'
  | 'checkpointing'
  | 'stopping'
  | 'sleeping';

interface RuntimeGate {
  phase: RuntimeGatePhase;
  runtimeEpoch?: string;
  revision: number;
  operationId?: string;
  updatedAt: string;
}

export interface ExecutionSnapshot {
  state: 'running' | 'not_running' | 'unknown';
  observedAt: string;
  active: boolean;
  activeSessionCount: number;
  retrySessionCount: number;
  locations: string[];
  error?: string;
}

export interface LifecycleWakeInput {
  instanceId: string;
  runtimeEpoch: string;
}

export interface LifecycleStopInput {
  runtimeEpoch: string;
  revision: number;
  operationId: string;
}

export type LifecycleStopResult =
  | {
      outcome: 'stopped' | 'busy' | 'not_running' | 'termination_pending';
      snapshot?: ExecutionSnapshot;
    }
  | {
      outcome: 'failed_running';
      error: string;
    };

export type LifecycleForceStopResult =
  | { outcome: 'stopped' | 'termination_pending' }
  | { outcome: 'failed_running'; error: string };

export type PurgeInstanceResult = {
  outcome: 'purged' | 'termination_pending';
};

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
  private purgeInProgress: Promise<PurgeInstanceResult> | undefined;
  private purgeRequested = false;
  private instanceIdentity: InstanceIdentity | undefined;
  private runtimeGate: RuntimeGate | undefined;
  private controlPlaneOperations = 0;
  private locationsNeedDiscovery = false;
  private knownLocations = new Map<string, OpenCodeLocation>([
    [
      openCodeLocationKey({ directory: WORKSPACE_DIRECTORY }),
      { directory: WORKSPACE_DIRECTORY }
    ]
  ]);
  private instanceActive = false;
  private activeOperations = 0;
  private operationDrainWaiters = new Set<() => void>();
  private lifecycleOperations = 0;
  private lifecycleDrainWaiters = new Set<() => void>();
  private lifecycleMutationTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.persistenceState = ctx;
    this.persistenceEnv = env;
    this.lifecycleReady = ctx.blockConcurrencyWhile(async () => {
      const [purgeRequested, identity, runtimeGate, knownLocations] = await Promise.all([
        ctx.storage.get<boolean>(PURGE_STORAGE_KEY),
        ctx.storage.get<InstanceIdentity>(IDENTITY_STORAGE_KEY),
        ctx.storage.get<RuntimeGate>(RUNTIME_GATE_STORAGE_KEY),
        ctx.storage.get<OpenCodeLocation[]>(KNOWN_LOCATIONS_STORAGE_KEY)
      ]);
      this.purgeRequested = Boolean(purgeRequested);
      this.instanceIdentity = identity;
      this.runtimeGate = runtimeGate;
      this.locationsNeedDiscovery =
        identity?.state === 'active' && knownLocations === undefined;
      for (const location of knownLocations ?? []) {
        if (isWorkspaceLocation(location.directory)) {
          this.knownLocations.set(openCodeLocationKey(location), location);
        }
      }
      this.instanceActive = identity?.state === 'active' && !purgeRequested;
    });
  }

  async initializeInstance(id: string, repoKey: string): Promise<void> {
    await this.lifecycleReady;
    await this.setKeepAlive(true);
    if (this.purgeRequested) {
      throw new Error('A deleting instance cannot be initialized');
    }
    if (!isRepoKey(repoKey)) {
      throw new Error(`Unknown repository: ${String(repoKey)}`);
    }
    if (this.instanceIdentity) {
      if (
        this.instanceIdentity.id !== id ||
        this.instanceIdentity.repoKey !== repoKey
      ) {
        throw new Error('Sandbox identity does not match the Hub record');
      }
      if (this.instanceIdentity.state !== 'active') {
        throw new Error('A deleted instance cannot be reactivated');
      }
      this.instanceActive = true;
      if (!this.runtimeGate && this.persistenceState.container?.running !== true) {
        await this.setRuntimeGate({ phase: 'sleeping', revision: 0 });
      }
      return;
    }

    const identity: InstanceIdentity = {
      id,
      repoKey,
      state: 'active',
      initializedAt: new Date().toISOString()
    };
    await this.persistenceState.storage.put({
      [IDENTITY_STORAGE_KEY]: identity,
      [KNOWN_LOCATIONS_STORAGE_KEY]: [...this.knownLocations.values()]
    });
    this.instanceIdentity = identity;
    this.locationsNeedDiscovery = false;
    this.instanceActive = true;
    await this.setRuntimeGate({ phase: 'sleeping', revision: 0 });
  }

  async ensureWorkspaceRestored(): Promise<void> {
    await this.lifecycleReady;
    this.assertInstanceActive();

    if (!this.restoreInProgress) {
      this.restoreInProgress = this.withControlPlaneAccess(() =>
        this.restoreWorkspace()
      ).finally(() => {
        this.restoreInProgress = undefined;
      });
    }

    return this.restoreInProgress;
  }

  /** The only path allowed to start or restore an OpenCode runtime. */
  async wakeForLifecycle(input: LifecycleWakeInput): Promise<ExecutionSnapshot> {
    await this.lifecycleReady;
    return this.withLifecycleMutation(() =>
      this.performWakeForLifecycle(input)
    );
  }

  private async performWakeForLifecycle(
    input: LifecycleWakeInput
  ): Promise<ExecutionSnapshot> {
    this.assertInstanceActive();
    if (this.instanceIdentity?.id !== input.instanceId) {
      throw new Error('Lifecycle wake identity does not match this Sandbox');
    }
    if (!isSafeRuntimeEpoch(input.runtimeEpoch)) {
      throw new Error('Invalid runtime epoch');
    }

    if (
      this.runtimeGate?.phase === 'running' &&
      this.runtimeGate.runtimeEpoch === input.runtimeEpoch &&
      this.persistenceState.container?.running === true
    ) {
      return this.inspectExecutionIfRunning();
    }

    const revision = (this.runtimeGate?.revision ?? 0) + 1;
    await this.setRuntimeGate({
      phase: 'waking',
      runtimeEpoch: input.runtimeEpoch,
      revision
    });

    try {
      await this.ensureWorkspaceRestored();
      await this.withControlPlaneAccess(() => this.ensureRepoProvisioned());
      await this.withControlPlaneAccess(() =>
        createOpencodeServer(this, {
          port: OPENCODE_PORT,
          directory: WORKSPACE_DIRECTORY,
          config: OPENCODE_CONFIG,
          env: OPENCODE_ENV
        })
      );
      await this.setRuntimeGate({
        phase: 'running',
        runtimeEpoch: input.runtimeEpoch,
        revision
      });
      return await this.inspectExecutionIfRunning();
    } catch (error) {
      await this.setRuntimeGate({ phase: 'sleeping', revision });
      throw error;
    }
  }

  /**
   * Provision the instance's catalog repository below /workspace during wake.
   * The first wake clones; later wakes see the snapshot-restored checkout and
   * only run a best-effort fetch, never touching the working tree.
   */
  private async ensureRepoProvisioned(): Promise<void> {
    const repoKey = this.instanceIdentity?.repoKey;
    if (!repoKey) {
      return;
    }
    const repo = findRepo(repoKey);
    if (!repo) {
      throw new Error(
        `Repository ${repoKey} is no longer in the catalog; wake refused`
      );
    }

    const directory = repoWorkspaceDirectory(repo);
    const checkout = await this.exists(`${directory}/.git`);
    if (checkout.exists) {
      // A fetch failure (offline remote, revoked key) must not block resuming
      // the already-restored workspace.
      const fetched = await this.exec(
        `git -C '${directory}' fetch origin --prune`,
        { timeout: REPO_FETCH_TIMEOUT_MS }
      );
      if (!fetched.success) {
        console.warn(
          `Repo fetch failed for ${repoKey}: ${truncateOutput(fetched.stderr)}`
        );
      }
      return;
    }

    const cloned = await this.exec(
      `git clone --depth 1 --branch '${repo.defaultBranch}' '${repo.cloneUrl}' '${directory}'`,
      { timeout: REPO_CLONE_TIMEOUT_MS }
    );
    if (!cloned.success) {
      throw new Error(
        `git clone failed for ${repoKey}: ${truncateOutput(cloned.stderr)}`
      );
    }
  }

  async getExecutionSnapshotIfRunning(
    runtimeEpoch: string
  ): Promise<ExecutionSnapshot> {
    await this.lifecycleReady;
    return this.withLifecycleRead(async () => {
      if (
        this.runtimeGate?.phase !== 'running' ||
        this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
        this.persistenceState.container?.running !== true
      ) {
        return notRunningExecutionSnapshot();
      }
      return this.inspectExecutionIfRunning();
    });
  }

  async quiesceAndStopIfIdle(
    input: LifecycleStopInput
  ): Promise<LifecycleStopResult> {
    await this.lifecycleReady;
    return this.withLifecycleMutation(() =>
      this.performQuiesceAndStopIfIdle(input)
    );
  }

  private async performQuiesceAndStopIfIdle(
    input: LifecycleStopInput
  ): Promise<LifecycleStopResult> {
    if (this.persistenceState.container?.running !== true) {
      await this.setRuntimeGate({
        phase: 'sleeping',
        revision: Math.max(input.revision, this.runtimeGate?.revision ?? 0)
      });
      return { outcome: 'not_running' };
    }

    const recovering =
      this.runtimeGate?.operationId === input.operationId &&
      isStopGatePhase(this.runtimeGate.phase);
    if (!recovering) {
      if (
        this.runtimeGate?.phase !== 'running' ||
        this.runtimeGate.runtimeEpoch !== input.runtimeEpoch
      ) {
        throw new Error('Runtime gate changed before idle stop');
      }
      await this.setRuntimeGate({
        phase: 'quiescing',
        runtimeEpoch: input.runtimeEpoch,
        revision: input.revision,
        operationId: input.operationId
      });
    }

    const revision = Math.max(
      input.revision,
      this.runtimeGate?.revision ?? input.revision
    );
    let snapshot: ExecutionSnapshot | undefined;
    try {
      if (this.runtimeGate?.phase === 'quiescing') {
        // Let already-admitted WebSocket handshakes finish before stopping.
        // The parent proxy can start a runtime while opening a socket, so none
        // may remain suspended across this boundary.
        await this.waitForOperationDrain();
        await scheduler.wait(QUIESCE_SETTLE_MS);

        snapshot = await this.inspectExecutionIfRunning();
        if (snapshot.state !== 'running' || snapshot.active) {
          await this.setRuntimeGate({
            phase: 'running',
            runtimeEpoch: input.runtimeEpoch,
            revision
          });
          return { outcome: 'busy', snapshot };
        }
        await this.setRuntimeGate({
          phase: 'checkpointing',
          runtimeEpoch: input.runtimeEpoch,
          revision,
          operationId: input.operationId
        });
      }

      if (this.runtimeGate?.phase === 'checkpointing') {
        await this.createCheckpoint('idle-stop');
        await this.setRuntimeGate({
          phase: 'stopping',
          revision,
          operationId: input.operationId
        });
      }
      if (this.persistenceState.container?.running === true) {
        const terminated = await this.terminateContainerBounded();
        if (!terminated) {
          return { outcome: 'termination_pending', snapshot };
        }
      }
      await this.setRuntimeGate({
        phase: 'sleeping',
        revision
      });
      return { outcome: 'stopped', snapshot };
    } catch (error) {
      if (this.persistenceState.container?.running === true) {
        await this.setRuntimeGate({
          phase: 'running',
          runtimeEpoch: input.runtimeEpoch,
          revision
        });
        return {
          outcome: 'failed_running',
          error: error instanceof Error ? error.message : String(error)
        };
      } else {
        await this.setRuntimeGate({ phase: 'sleeping', revision });
        return { outcome: 'stopped', snapshot };
      }
    }
  }

  async forceStopForLifecycle(input: {
    runtimeEpoch?: string;
    operationId: string;
  }): Promise<LifecycleForceStopResult> {
    await this.lifecycleReady;
    return this.withLifecycleMutation(() =>
      this.performForceStopForLifecycle(input)
    );
  }

  private async performForceStopForLifecycle(input: {
    runtimeEpoch?: string;
    operationId: string;
  }): Promise<LifecycleForceStopResult> {
    if (this.persistenceState.container?.running !== true) {
      await this.setRuntimeGate({
        phase: 'sleeping',
        revision: (this.runtimeGate?.revision ?? 0) + 1
      });
      return { outcome: 'stopped' };
    }
    const recovering =
      this.runtimeGate?.operationId === input.operationId &&
      isStopGatePhase(this.runtimeGate.phase);
    if (
      !recovering &&
      input.runtimeEpoch &&
      this.runtimeGate?.runtimeEpoch &&
      input.runtimeEpoch !== this.runtimeGate.runtimeEpoch
    ) {
      throw new Error('Runtime epoch changed before manual stop');
    }

    const previousEpoch = this.runtimeGate?.runtimeEpoch ?? input.runtimeEpoch;
    const revision = recovering
      ? this.runtimeGate!.revision
      : (this.runtimeGate?.revision ?? 0) + 1;
    if (!recovering) {
      await this.setRuntimeGate({
        phase: 'quiescing',
        runtimeEpoch: previousEpoch,
        revision,
        operationId: input.operationId
      });
    }
    try {
      if (this.runtimeGate?.phase === 'quiescing') {
        await this.waitForOperationDrain();
        await this.setRuntimeGate({
          phase: 'checkpointing',
          runtimeEpoch: previousEpoch,
          revision,
          operationId: input.operationId
        });
      }
      if (this.runtimeGate?.phase === 'checkpointing') {
        await this.createCheckpoint('idle-stop');
        await this.setRuntimeGate({
          phase: 'stopping',
          revision,
          operationId: input.operationId
        });
      }
      if (this.persistenceState.container?.running === true) {
        const terminated = await this.terminateContainerBounded();
        if (!terminated) {
          return { outcome: 'termination_pending' };
        }
      }
      await this.setRuntimeGate({ phase: 'sleeping', revision });
      return { outcome: 'stopped' };
    } catch (error) {
      if (this.persistenceState.container?.running === true) {
        await this.setRuntimeGate({
          phase: 'running',
          runtimeEpoch: previousEpoch,
          revision
        });
        return {
          outcome: 'failed_running',
          error: error instanceof Error ? error.message : String(error)
        };
      } else {
        await this.setRuntimeGate({ phase: 'sleeping', revision });
        return { outcome: 'stopped' };
      }
    }
  }

  async checkpointWorkspace(runtimeEpoch: string): Promise<PersistenceStatus> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      if (
        this.runtimeGate?.phase !== 'running' ||
        this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
        this.persistenceState.container?.running !== true
      ) {
        throw new Error('Manual checkpoint requires the current running epoch');
      }
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
      lifecycle: this.purgeRequested
        ? 'stopping'
        : runtimeLifecycleFromGate(
            this.runtimeGate,
            this.persistenceState.container?.running === true
          ),
      persistence
    };
  }

  override async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number
  ): Promise<Response> {
    await this.lifecycleReady;
    const { request, port } = parseContainerFetchRequest(
      requestOrUrl,
      portOrInit,
      portParam,
      this.defaultPort
    );
    if (port === 3000) {
      if (this.controlPlaneOperations === 0) {
        throw new Error('Sandbox control plane is not admitted');
      }
      return super.containerFetch(request, port);
    }
    const runtimeEpoch = request.headers.get(RUNTIME_EPOCH_HEADER);
    if (
      !runtimeEpoch ||
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
      this.persistenceState.container?.running !== true
    ) {
      return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
    }

    await this.rememberRequestLocation(request);
    if (
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
      this.persistenceState.container?.running !== true
    ) {
      return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
    }
    this.beginActiveOperation();
    try {
      // Use the already-running port directly. BaseSandbox.containerFetch()
      // automatically starts stopped containers, which is forbidden for
      // passive UI/SSE retries.
      return await this.persistenceState.container.getTcpPort(port).fetch(request);
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Create the OpenCode session that backs one Hub session record.
   *
   * `directory` is the session's repository checkout, which also registers that
   * location with the activity probe through the container fetch path.
   */
  async createOpencodeSession(
    runtimeEpoch: string,
    input: CreateOpencodeSessionInput
  ): Promise<string> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      const client = this.createRuntimeClient(
        runtimeEpoch,
        'Creating an OpenCode session'
      );
      const session = await client.session.create({
        title: input.title,
        directory: input.directory
      });
      const id = session.data?.id;
      if (!id) {
        throw new Error(
          `Failed to create OpenCode session: ${describeSdkFailure(session)}`
        );
      }
      return id;
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Hand a prompt to the container's agent loop and return immediately. The
   * task keeps running server-side after this call, where the semantic activity
   * probe observes it as busy and holds off the idle deadline.
   */
  async promptOpencodeSessionAsync(
    runtimeEpoch: string,
    input: PromptOpencodeSessionInput
  ): Promise<void> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      const client = this.createRuntimeClient(
        runtimeEpoch,
        'Dispatching an OpenCode prompt'
      );
      // The message id is left to OpenCode: it encodes a sortable timestamp
      // that message ordering depends on, so an arbitrary id is not safe.
      const result = await client.session.promptAsync({
        sessionID: input.opencodeSessionId,
        directory: input.directory,
        model: {
          providerID: input.providerID,
          modelID: input.modelID
        },
        parts: [{ type: 'text', text: input.text }]
      });
      if (result.error !== undefined || result.response.status >= 400) {
        throw new Error(
          `Failed to dispatch OpenCode prompt: ${describeSdkFailure(result)}`
        );
      }
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Build an OpenCode client bound to the current runtime generation. Every
   * request carries the epoch header, so a runtime which stopped mid-operation
   * fails the request instead of silently reaching a newer container.
   */
  private createRuntimeClient(
    runtimeEpoch: string,
    intent: string
  ): OpencodeClient {
    if (
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch
    ) {
      throw new Error(`${intent} requires the current runtime epoch`);
    }
    return createOpencodeClient({
      baseUrl: `http://localhost:${OPENCODE_PORT}`,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set(RUNTIME_EPOCH_HEADER, runtimeEpoch);
        return this.containerFetch(
          new Request(request, { headers }),
          OPENCODE_PORT
        );
      }
    });
  }

  async runSdkTest(runtimeEpoch: string): Promise<Response> {
    await this.lifecycleReady;
    this.beginActiveOperation();

    try {
      const client = this.createRuntimeClient(runtimeEpoch, 'The SDK test');

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
            text: 'Reply with exactly: OpenCode is ready.'
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

  async purgeInstance(): Promise<PurgeInstanceResult> {
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
    const runtimeEpoch = request.headers.get(RUNTIME_EPOCH_HEADER);
    if (
      !runtimeEpoch ||
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
      this.persistenceState.container?.running !== true
    ) {
      return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
    }
    await this.rememberRequestLocation(request);
    if (
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
      this.persistenceState.container?.running !== true
    ) {
      return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
    }
    this.beginActiveOperation();
    try {
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
    // This is only the Sandbox SDK's transport-activity timer. keepAlive is
    // enabled, so it cannot stop or start a container and must not delay the
    // semantic lifecycle's request-drain barrier.
    await super.alarm(alarmInfo);
  }

  override async stop(
    signal?: Parameters<BaseSandbox<Env>['stop']>[0]
  ): Promise<void> {
    void signal;
    await this.forceStopForLifecycle({
      runtimeEpoch: this.runtimeGate?.runtimeEpoch,
      operationId: crypto.randomUUID()
    });
  }

  private async doPurgeInstance(): Promise<PurgeInstanceResult> {
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
    await Promise.all([
      this.waitForOperationDrain(),
      this.waitForLifecycleDrain()
    ]);

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

    // Deletion must not create one final backup after the purge barrier has
    // been raised. Avoid the SDK's unbounded destroy() for the same reason as
    // normal lifecycle stops: a control-plane outage must remain retryable.
    if (this.persistenceState.container?.running === true) {
      const terminated = await this.terminateContainerBounded();
      if (!terminated) {
        return { outcome: 'termination_pending' };
      }
    }
    await this.waitForContainerMonitorToSettle();
    await this.deleteBackupObjects(backups);
    await this.persistenceState.storage.deleteAll();
    return { outcome: 'purged' };
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
    throw new Error('Container monitor did not settle after termination');
  }

  private async terminateContainerBounded(): Promise<boolean> {
    // Lifecycle callers have already checkpointed; purge callers have raised
    // an irreversible deletion barrier. A graceful SIGTERM can wait for
    // OpenCode's long-lived server for minutes while admission is closed. Send
    // SIGKILL directly, then bound the read-only monitor wait. We do not call
    // the SDK's unbounded destroy(): its late completion could kill a newly
    // woken generation after admission reopened.
    const container = this.persistenceState.container;
    if (!container) {
      return true;
    }
    const monitor = container.monitor();
    container.signal(9);
    try {
      const stopped = await Promise.race([
        monitor.then(() => true),
        scheduler
          .wait(CONTAINER_TERMINATION_TIMEOUT_MS)
          .then(() => false)
      ]);
      return stopped && this.persistenceState.container?.running !== true;
    } catch (error) {
      // SIGKILL is reported by the local monitor as an exit-code 137 rejection.
      // That is still a successful termination once the physical state agrees.
      if (container.running !== true) {
        return true;
      }
      console.warn('Container termination monitor failed', error);
      // The signal was already accepted. Keep admission closed and let the
      // coordinator alarm reconcile physical state before taking another step.
      return false;
    }
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

  private async waitForLifecycleDrain(): Promise<void> {
    if (this.lifecycleOperations === 0) {
      return;
    }
    await new Promise<void>((resolve) =>
      this.lifecycleDrainWaiters.add(resolve)
    );
  }

  private beginLifecycleOperation(): void {
    this.assertInstanceActive();
    this.lifecycleOperations += 1;
  }

  private finishLifecycleOperation(): void {
    this.lifecycleOperations -= 1;
    if (this.lifecycleOperations === 0) {
      for (const resolve of this.lifecycleDrainWaiters) {
        resolve();
      }
      this.lifecycleDrainWaiters.clear();
    }
  }

  private async withLifecycleRead<T>(operation: () => Promise<T>): Promise<T> {
    this.beginLifecycleOperation();
    try {
      return await operation();
    } finally {
      this.finishLifecycleOperation();
    }
  }

  private async withLifecycleMutation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    this.beginLifecycleOperation();
    const previous = this.lifecycleMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.lifecycleMutationTail = previous.then(() => current);
    await previous;
    try {
      this.assertInstanceActive();
      return await operation();
    } finally {
      release();
      this.finishLifecycleOperation();
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
      this.checkpointInProgress = this.withControlPlaneAccess(() =>
        this.doCreateCheckpoint(reason)
      ).finally(() => {
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
            value.name.startsWith(`opencode:${owner}:`)
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

  private async setRuntimeGate(
    gate: Omit<RuntimeGate, 'updatedAt'>
  ): Promise<void> {
    const stored: RuntimeGate = {
      phase: gate.phase,
      revision: gate.revision,
      updatedAt: new Date().toISOString(),
      ...(gate.runtimeEpoch ? { runtimeEpoch: gate.runtimeEpoch } : {}),
      ...(gate.operationId ? { operationId: gate.operationId } : {})
    };
    await this.persistenceState.storage.put(RUNTIME_GATE_STORAGE_KEY, stored);
    this.runtimeGate = stored;
  }

  private async withControlPlaneAccess<T>(operation: () => Promise<T>): Promise<T> {
    this.controlPlaneOperations += 1;
    try {
      return await operation();
    } finally {
      this.controlPlaneOperations -= 1;
    }
  }

  private async rememberRequestLocation(request: Request): Promise<void> {
    const location = extractOpenCodeLocation(request, WORKSPACE_DIRECTORY);
    if (!location || !isWorkspaceLocation(location.directory)) {
      return;
    }
    if (!this.addKnownLocation(location)) {
      return;
    }
    await this.persistenceState.storage.put(
      KNOWN_LOCATIONS_STORAGE_KEY,
      [...this.knownLocations.values()]
    );
  }

  private addKnownLocation(location: OpenCodeLocation): boolean {
    const key = openCodeLocationKey(location);
    if (this.knownLocations.has(key)) {
      return false;
    }
    if (this.knownLocations.size >= MAX_KNOWN_OPENCODE_LOCATIONS) {
      const rootKey = openCodeLocationKey({ directory: WORKSPACE_DIRECTORY });
      const oldest = [...this.knownLocations.keys()].find(
        (value) => value !== rootKey
      );
      if (oldest) {
        this.knownLocations.delete(oldest);
      }
    }
    this.knownLocations.set(key, location);
    return true;
  }

  private async discoverKnownLocationsIfNeeded(): Promise<string | undefined> {
    if (!this.locationsNeedDiscovery) {
      return undefined;
    }
    const container = this.persistenceState.container;
    if (container?.running !== true) {
      return 'Cannot discover OpenCode locations while the container is stopped';
    }

    try {
      const url = new URL(
        GLOBAL_SESSION_LIST_PATH,
        `http://localhost:${OPENCODE_PORT}`
      );
      url.searchParams.set('roots', 'true');
      url.searchParams.set('limit', '1000');
      const response = await container.getTcpPort(OPENCODE_PORT).fetch(
        new Request(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(ACTIVITY_PROBE_TIMEOUT_MS)
        })
      );
      if (!response.ok) {
        return `${GLOBAL_SESSION_LIST_PATH} returned HTTP ${response.status}`;
      }
      const locations = openCodeLocationsFromGlobalSessions(
        await response.json()
      );
      if (!locations) {
        return `${GLOBAL_SESSION_LIST_PATH} returned an invalid response`;
      }
      for (const location of locations) {
        if (isWorkspaceLocation(location.directory)) {
          this.addKnownLocation(location);
        }
      }
      await this.persistenceState.storage.put(
        KNOWN_LOCATIONS_STORAGE_KEY,
        [...this.knownLocations.values()]
      );
      this.locationsNeedDiscovery = false;
      return undefined;
    } catch (error) {
      return `${GLOBAL_SESSION_LIST_PATH} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async inspectExecutionIfRunning(): Promise<ExecutionSnapshot> {
    const observedAt = new Date().toISOString();
    const container = this.persistenceState.container;
    if (container?.running !== true) {
      return notRunningExecutionSnapshot(observedAt);
    }

    const discoveryError = await this.discoverKnownLocationsIfNeeded();
    if (discoveryError) {
      return {
        state: 'unknown',
        observedAt,
        active: true,
        activeSessionCount: 0,
        retrySessionCount: 0,
        locations: [...this.knownLocations.values()].map(openCodeLocationKey),
        error: discoveryError
      };
    }

    const activity = await queryOpenCodeActivity({
      baseUrl: `http://localhost:${OPENCODE_PORT}`,
      locations: this.knownLocations.values(),
      signal: AbortSignal.timeout(ACTIVITY_PROBE_TIMEOUT_MS),
      fetcher: async (request) => {
        if (container.running !== true) {
          throw new Error('Container stopped during activity probe');
        }
        return container.getTcpPort(OPENCODE_PORT).fetch(request);
      }
    });
    return {
      state: activity.state === 'unknown' ? 'unknown' : 'running',
      observedAt: new Date(activity.observedAt).toISOString(),
      active: activity.state !== 'idle',
      activeSessionCount: activity.activeSessionIds.length,
      // This remains a conservative diagnostic count; both busy and retry
      // already block shutdown through `active`.
      retrySessionCount: 0,
      locations: [...this.knownLocations.values()].map(openCodeLocationKey),
      ...(activity.reason ? { error: activity.reason } : {})
    };
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

/** The same persisted Sandbox behavior backed by the Logto template image. */
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

      if (url.pathname === '/api/sessions' || url.pathname.startsWith('/api/sessions/')) {
        return await handleSessionApi(request, env);
      }

      if (url.pathname === '/api/catalog' && request.method === 'GET') {
        return json({ repos: REPOS, models: MODEL_OPTIONS });
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
        await requireReadyInstance(
          env,
          decodeRouteSegment(openMatch[1])
        );
        return Response.redirect(new URL('/', url).toString(), 302);
      }

      const uiInstanceId = url.searchParams.get(UI_INSTANCE_PARAM);
      const uiRuntimeEpoch = url.searchParams.get(UI_RUNTIME_PARAM);
      if (uiInstanceId && request.method === 'GET' && acceptsHtml(request)) {
        if (!uiRuntimeEpoch || !isSafeRuntimeEpoch(uiRuntimeEpoch)) {
          return runtimeEntryRequiredResponse();
        }
        return await serveOpencodeUi(
          request,
          env,
          uiInstanceId,
          uiRuntimeEpoch
        );
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

  // Instances are only created as part of a session. What remains here is the
  // operational surface: reading container state and driving one runtime.
  if (url.pathname === '/api/instances') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    const records = await hub.listInstances();
    return json(
      await Promise.all(records.map((record) => getInstanceView(env, record)))
    );
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
  const lifecycle = resolveLifecycle(env, record.id);
  switch (action) {
    case 'wake': {
      const wake = await wakeInstance(env, record, lifecycle);
      return json({
        launchUrl: `/?${UI_INSTANCE_PARAM}=${encodeURIComponent(record.id)}&${UI_RUNTIME_PARAM}=${encodeURIComponent(wake.runtimeEpoch)}`,
        runtime: await getMergedRuntimeStatus(sandbox, wake.status)
      });
    }
    case 'checkpoint': {
      const runtime = await ensureLifecycleInitialized(env, record.id, lifecycle);
      // A sleeping instance was already checkpointed before it stopped. Do
      // not start it merely to create an identical manual checkpoint.
      if (!runtime.admissionOpen) {
        return json(await sandbox.getPersistenceStatus());
      }
      if (!runtime.runtimeEpoch) {
        throw new HttpError(409, 'Running lifecycle has no runtime epoch');
      }
      return json(await sandbox.checkpointWorkspace(runtime.runtimeEpoch));
    }
    case 'stop':
      await ensureLifecycleInitialized(env, record.id, lifecycle);
      await lifecycle.forceStop();
      return json(await getInstanceView(env, record));
    case 'test': {
      const wake = await wakeInstance(env, record, lifecycle);
      const lease = await lifecycle.beginWork(wake.runtimeEpoch);
      if (!lease.admitted) {
        return lifecycleUnavailableResponse(lease.reason, lease.phase);
      }
      try {
        return await sandbox.runSdkTest(wake.runtimeEpoch);
      } finally {
        await lifecycle.endWork(wake.runtimeEpoch, lease.leaseId);
      }
    }
    default:
      throw new HttpError(404, 'Instance action not found');
  }
}

/**
 * Session API.
 *
 * The Hub creates a session, its instance, and its dispatch agent in one
 * request and returns immediately: waking the container, provisioning the
 * repository and starting the agent loop all happen in the SessionAgent alarm.
 */
async function handleSessionApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hub = getHub(env);

  if (url.pathname === '/api/sessions') {
    if (request.method === 'GET') {
      const records = await hub.listSessions();
      return json(
        await Promise.all(records.map((record) => getSessionView(env, record)))
      );
    }
    if (request.method === 'POST') {
      return await createSession(request, env);
    }
    return methodNotAllowed('GET, POST');
  }

  const match = /^\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'Session API route not found');
  }
  const id = decodeRouteSegment(match[1]);
  const action = match[2];
  const record = await requireSession(env, id);

  if (!action) {
    if (request.method === 'GET') {
      return json(await getSessionView(env, record));
    }
    if (request.method === 'DELETE') {
      // Clearing the agent first stops a queued dispatch from waking a
      // container the Hub is about to destroy.
      await resolveSessionAgent(env, record.id).markDeleted();
      const deleting = await hub.beginDelete(record.instanceId);
      if (!deleting) {
        throw new HttpError(404, 'Session instance not found');
      }
      return json(
        { deleting: true, id: record.id, operationId: deleting.deleteOperationId },
        202
      );
    }
    return methodNotAllowed('GET, DELETE');
  }

  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (action !== 'retry') {
    throw new HttpError(404, 'Session action not found');
  }
  await resolveSessionAgent(env, record.id).retrySession();
  return json(await getSessionView(env, await requireSession(env, record.id)), 202);
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const input = await readCreateSessionInput(request);
  const repo = findRepo(input.repoKey);
  if (!repo) {
    throw new HttpError(400, 'Unknown repository');
  }

  const record = await getHub(env).createSession({
    repoKey: input.repoKey,
    model: input.model,
    title: deriveSessionTitle(input.prompt)
  });
  try {
    await resolveSessionAgent(env, record.id).startSession({
      sessionId: record.id,
      instanceId: record.instanceId,
      repoKey: record.repoKey,
      directory: repoWorkspaceDirectory(repo),
      model: record.model,
      title: record.title,
      prompt: input.prompt
    });
  } catch (error) {
    // The session exists, so surface the failure on the record instead of
    // leaving an orphaned instance behind an error response.
    const message = error instanceof Error ? error.message : String(error);
    await getHub(env)
      .updateSession(record.id, { phase: 'failed', lastError: message })
      .catch(() => undefined);
    return json(
      await getSessionView(env, (await getHub(env).getSession(record.id)) ?? record),
      202
    );
  }
  return json(
    await getSessionView(env, (await getHub(env).getSession(record.id)) ?? record),
    202
  );
}

interface CreateSessionInput {
  repoKey: string;
  model: string;
  prompt: string;
}

async function readCreateSessionInput(
  request: Request
): Promise<CreateSessionInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  const { repoKey, model, prompt } = value as {
    repoKey?: unknown;
    model?: unknown;
    prompt?: unknown;
  };
  if (!isRepoKey(repoKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  const modelRef = model === undefined ? DEFAULT_MODEL_REF : model;
  if (!isModelRef(modelRef)) {
    throw new HttpError(400, 'Unknown model');
  }
  const text = normalizeSessionPrompt(prompt);
  if (!text) {
    throw new HttpError(400, 'A prompt of up to 32000 characters is required');
  }
  return { repoKey, model: modelRef, prompt: text };
}

async function requireSession(env: Env, id: string): Promise<SessionRecord> {
  if (!isSafeInstanceId(id)) {
    throw new HttpError(400, 'Invalid session id');
  }
  const record = await getHub(env).getSession(id);
  if (!record) {
    throw new HttpError(404, 'Session not found');
  }
  return record;
}

async function getSessionView(
  env: Env,
  record: SessionRecord
): Promise<SessionView> {
  const instance = await getHub(env).getInstance(record.instanceId);
  return {
    ...record,
    instance: instance
      ? await getInstanceView(env, instance)
      : {
          id: record.instanceId,
          name: record.instanceId,
          repoKey: record.repoKey,
          lifecycle: 'deleting',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          runtime: unknownRuntimeStatus(true)
        }
  };
}

function resolveSessionAgent(env: Env, sessionId: string) {
  return env.SessionAgent.getByName(sessionId);
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
    const sandbox = resolveSandbox(env, record);
    const lifecycle = resolveLifecycle(env, record.id);
    const lifecycleStatus = await ensureLifecycleInitialized(
      env,
      record.id,
      lifecycle
    );
    return {
      ...record,
      runtime: await getMergedRuntimeStatus(sandbox, lifecycleStatus)
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
  const match = /^\/gateway\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'Gateway route not found');
  }

  const id = decodeRouteSegment(match[1]);
  const runtimeEpoch = decodeRouteSegment(match[2]);
  if (!isSafeRuntimeEpoch(runtimeEpoch)) {
    throw new HttpError(410, 'Runtime epoch is stale');
  }
  const instance = await requireReadyInstance(env, id);
  const lifecycle = resolveLifecycle(env, instance.id);
  const admission = await lifecycle.admit(runtimeEpoch);
  if (!admission.admitted) {
    return lifecycleUnavailableResponse(admission.reason, admission.phase);
  }
  url.pathname = match[3] || '/';
  const rewritten = createContainerRequest(url, request, runtimeEpoch);
  const sandbox = resolveSandbox(env, instance);
  if (isWebSocketUpgrade(request)) {
    return sandbox.wsConnect(rewritten, OPENCODE_PORT);
  }
  const requiresLease = openCodeRouteRequiresWorkLease({
    method: rewritten.method,
    url: rewritten.url
  });
  const lease = requiresLease
    ? await lifecycle.beginWork(runtimeEpoch)
    : undefined;
  if (lease && !lease.admitted) {
    return lifecycleUnavailableResponse(lease.reason, lease.phase);
  }
  try {
    const upstream = await proxyRunningContainerRequest(sandbox, rewritten);
    return rewriteGatewayResponse(
      upstream,
      gatewayPrefix(instance.id, runtimeEpoch),
      new URL(request.url).origin
    );
  } finally {
    if (lease?.admitted) {
      await lifecycle.endWork(runtimeEpoch, lease.leaseId);
    }
  }
}

async function serveOpencodeUi(
  request: Request,
  env: Env,
  id: string,
  runtimeEpoch: string
): Promise<Response> {
  const instance = await requireReadyInstance(env, id);
  const denied = await rejectUnlessRuntimeAdmitted(
    env,
    instance.id,
    runtimeEpoch
  );
  if (denied) {
    return denied;
  }
  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = '/';
  upstreamUrl.search = '';
  upstreamUrl.hash = '';
  const upstream = await proxyRunningContainerRequest(
    resolveSandbox(env, instance),
    createContainerRequest(upstreamUrl, request, runtimeEpoch)
  );

  if (!upstream.ok) {
    return upstream;
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    return upstream;
  }

  const scope = scopedUiPrefix(instance.id, runtimeEpoch);
  const bootstrap = `/hub/bootstrap.js?${UI_INSTANCE_PARAM}=${encodeURIComponent(instance.id)}&${UI_RUNTIME_PARAM}=${encodeURIComponent(runtimeEpoch)}&v=${UI_COMPAT_VERSION}`;
  let html = await upstream.text();
  html = html
    .replaceAll('src="/', `src="${scope}/`)
    .replaceAll("src='/", `src='${scope}/`)
    .replaceAll('href="/', `href="${scope}/`)
    .replaceAll("href='/", `href='${scope}/`)
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
  const match = /^\/ui\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'UI asset route not found');
  }
  const instance = await requireReadyInstance(
    env,
    decodeRouteSegment(match[1])
  );
  const runtimeEpoch = decodeRouteSegment(match[2]);
  if (!isSafeRuntimeEpoch(runtimeEpoch)) {
    throw new HttpError(410, 'Runtime epoch is stale');
  }
  const denied = await rejectUnlessRuntimeAdmitted(
    env,
    instance.id,
    runtimeEpoch
  );
  if (denied) {
    return denied;
  }
  const scopedPath = match[3] || '/';
  const versionRoot = `/${UI_ASSET_VERSION_SEGMENT}`;
  url.pathname =
    scopedPath === versionRoot
      ? '/'
      : scopedPath.startsWith(`${versionRoot}/`)
        ? scopedPath.slice(versionRoot.length)
        : scopedPath;
  // v2 used this query parameter to bust the entry bundle cache. That gave
  // the entry module a different URL from the copy imported by lazy chunks,
  // so framework contexts were duplicated. Version the entire asset path
  // instead, keeping every relative ESM import in one module graph.
  url.searchParams.delete('hub-ui');
  const rewritten = createContainerRequest(url, request, runtimeEpoch);
  const upstream = await proxyRunningContainerRequest(
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
    const scope = scopedUiPrefix(instance.id, runtimeEpoch);
    const manifest = (await upstream.text())
      .replace('"id": "/"', `"id": "/instances/${encodeURIComponent(instance.id)}"`)
      .replace(
        '"start_url": "/"',
        `"start_url": "/?${UI_INSTANCE_PARAM}=${encodeURIComponent(instance.id)}&${UI_RUNTIME_PARAM}=${encodeURIComponent(runtimeEpoch)}"`
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
  const context = instanceContextFromReferrer(request.headers.get('referer'));
  if (!context) {
    throw new HttpError(404, 'UI asset has no instance context');
  }
  const instance = await requireReadyInstance(env, context.id);
  const denied = await rejectUnlessRuntimeAdmitted(
    env,
    instance.id,
    context.runtimeEpoch
  );
  if (denied) {
    return denied;
  }
  const response = await proxyRunningContainerRequest(
    resolveSandbox(env, instance),
    createContainerRequest(new URL(request.url), request, context.runtimeEpoch)
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
  const runtimeEpoch = url.searchParams.get(UI_RUNTIME_PARAM);
  if (
    !id ||
    !isSafeInstanceId(id) ||
    !runtimeEpoch ||
    !isSafeRuntimeEpoch(runtimeEpoch)
  ) {
    return new Response('Invalid instance id', { status: 400 });
  }

  const encodedId = JSON.stringify(id);
  const encodedParam = JSON.stringify(UI_INSTANCE_PARAM);
  const encodedRuntimeEpoch = JSON.stringify(runtimeEpoch);
  const encodedRuntimeParam = JSON.stringify(UI_RUNTIME_PARAM);
  const source = String.raw`(() => {
  const instanceId = ${encodedId};
  const instanceParam = ${encodedParam};
  const runtimeEpoch = ${encodedRuntimeEpoch};
  const runtimeParam = ${encodedRuntimeParam};
  const gateway = location.origin + "/gateway/" + encodeURIComponent(instanceId) + "/" + encodeURIComponent(runtimeEpoch);
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
      next.searchParams.set(runtimeParam, runtimeEpoch);
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
  if (
    current.searchParams.get(instanceParam) !== instanceId ||
    current.searchParams.get(runtimeParam) !== runtimeEpoch
  ) {
    current.searchParams.set(instanceParam, instanceId);
    current.searchParams.set(runtimeParam, runtimeEpoch);
    replaceState.call(history, history.state, "", current.pathname + current.search + current.hash);
  }

  let sleeping = false;
  const showSleeping = () => {
    if (sleeping) return;
    if (!document.body) {
      addEventListener("DOMContentLoaded", showSleeping, { once: true });
      return;
    }
    sleeping = true;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:#090b0ee8;color:#e7eaf0;font:14px ui-monospace,monospace";
    const panel = document.createElement("div");
    panel.style.cssText = "max-width:440px;padding:28px;border:1px solid #343a45;border-radius:12px;background:#15191f;text-align:center;box-shadow:0 20px 70px #000b";
    const title = document.createElement("strong");
    title.textContent = "实例已休眠";
    title.style.cssText = "display:block;margin-bottom:12px;font-size:18px";
    const detail = document.createElement("div");
    detail.textContent = "任务完成超过 10 分钟，工作区已经备份。请返回 Hub 重新进入以唤醒容器。";
    detail.style.cssText = "color:#aab1bd;line-height:1.6";
    const link = document.createElement("a");
    link.href = "/";
    link.textContent = "返回 Hub";
    link.style.cssText = "display:inline-block;margin-top:20px;border-radius:7px;background:#d6ff53;color:#101408;padding:8px 13px;text-decoration:none;font-weight:700";
    panel.append(title, detail, link);
    overlay.append(panel);
    document.body.append(overlay);
  };

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (response.status === 410 && response.headers.get("X-OpenCode-Hub-State")) {
      showSleeping();
    }
    return response;
  };

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

    const checkRuntime = async () => {
      try {
        const response = await nativeFetch("/api/instances/" + encodeURIComponent(instanceId), { cache: "no-store" });
        if (!response.ok) return;
        const instance = await response.json();
        if (instance?.runtime?.lifecycle === "sleeping" || instance?.runtime?.lifecycle === "stopping") {
          showSleeping();
        }
      } catch {}
    };
    setInterval(checkRuntime, 15000);
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

function createContainerRequest(
  target: URL,
  request: Request,
  runtimeEpoch?: string
): Request {
  // The public Worker request is HTTPS in production, but a container TCP
  // port only accepts plain HTTP on Cloudflare's already-secure internal
  // transport. Preserve the route/query while replacing the external origin.
  const containerTarget = new URL(target);
  containerTarget.protocol = 'http:';
  containerTarget.hostname = 'localhost';
  containerTarget.port = String(OPENCODE_PORT);
  containerTarget.username = '';
  containerTarget.password = '';
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name.toLowerCase().startsWith('cf-access-') ||
      name.toLowerCase() === 'cf-authorization'
    ) {
      headers.delete(name);
    }
  }
  if (runtimeEpoch) {
    headers.set(RUNTIME_EPOCH_HEADER, runtimeEpoch);
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

  return new Request(containerTarget.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal
  });
}

async function proxyRunningContainerRequest(
  sandbox: Sandbox,
  request: Request
): Promise<Response> {
  // Keep streaming Response bodies on the built-in Sandbox RPC path. Returning
  // them through a custom Durable Object RPC method can pin that method for the
  // lifetime of SSE responses and eventually stall unrelated requests.
  return await sandbox.containerFetch(request, OPENCODE_PORT);
}

function resolveSandbox(env: Env, instance: InstanceRecord): Sandbox {
  return getSandbox(env.Sandbox, instance.id, {
    normalizeId: true,
    keepAlive: true
  });
}

function resolveLifecycle(env: Env, instanceId: string) {
  return env.LifecycleCoordinator.getByName(instanceId);
}

async function wakeInstance(
  env: Env,
  record: InstanceRecord,
  lifecycle = resolveLifecycle(env, record.id)
): Promise<{
  runtimeEpoch: string;
  status: LifecycleStatus;
}> {
  try {
    return await wakeInstanceRuntime(env, record.id, lifecycle);
  } catch (error) {
    if (error instanceof InstanceWakePendingError) {
      throw new HttpError(503, error.message);
    }
    throw error;
  }
}

async function getMergedRuntimeStatus(
  sandbox: Sandbox,
  lifecycle: LifecycleStatus
): Promise<InstanceRuntimeStatus> {
  const platform = await sandbox.getInstanceRuntimeStatus();
  return {
    ...platform,
    lifecycle: lifecycle.lifecycle,
    ...(lifecycle.idleSince ? { idleSince: lifecycle.idleSince } : {}),
    ...(lifecycle.idleDeadlineAt
      ? { idleDeadlineAt: lifecycle.idleDeadlineAt }
      : {}),
    ...(lifecycle.activeSessionCount !== undefined
      ? { activeSessionCount: lifecycle.activeSessionCount }
      : {}),
    ...(lifecycle.lastActivityProbeAt
      ? { lastActivityProbeAt: lifecycle.lastActivityProbeAt }
      : {}),
    ...(lifecycle.lifecycleError
      ? { lifecycleError: lifecycle.lifecycleError }
      : {})
  };
}

async function rejectUnlessRuntimeAdmitted(
  env: Env,
  instanceId: string,
  runtimeEpoch: string
): Promise<Response | undefined> {
  const admission = await resolveLifecycle(env, instanceId).admit(runtimeEpoch);
  return admission.admitted
    ? undefined
    : lifecycleUnavailableResponse(admission.reason, admission.phase);
}

function lifecycleUnavailableResponse(reason: string, phase: string): Response {
  return Response.json(
    {
      error: 'INSTANCE_SLEEPING',
      message: 'This runtime generation no longer accepts passive requests',
      reason,
      phase
    },
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'X-OpenCode-Hub-State': phase
      }
    }
  );
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
    lifecycle: deleting ? 'stopping' : 'error',
    persistence: {
      hasBackup: false,
      trackedBackupCount: 0
    },
    platformRunning: false
  };
}

function notRunningExecutionSnapshot(
  observedAt = new Date().toISOString()
): ExecutionSnapshot {
  return {
    state: 'not_running',
    observedAt,
    active: false,
    activeSessionCount: 0,
    retrySessionCount: 0,
    locations: []
  };
}

function runtimeUnavailableResponse(phase: RuntimeGatePhase): Response {
  return Response.json(
    {
      error: 'INSTANCE_SLEEPING',
      message: 'This OpenCode runtime is not accepting passive requests',
      phase
    },
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'X-OpenCode-Hub-State': phase
      }
    }
  );
}

function runtimeEntryRequiredResponse(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>OpenCode 已休眠</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7eaf0;font:14px ui-monospace,monospace}.panel{max-width:430px;padding:28px;border:1px solid #343a45;border-radius:12px;background:#15191f;text-align:center}a{display:inline-block;margin-top:18px;border-radius:7px;background:#d6ff53;color:#101408;padding:8px 13px;text-decoration:none;font-weight:700}</style><div class="panel"><h1>请从 Hub 进入</h1><p>这个地址没有有效的运行代际，普通页面刷新不会自动唤醒容器。</p><a href="/">返回 Hub</a></div>',
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      }
    }
  );
}

function parseContainerFetchRequest(
  requestOrUrl: Request | string | URL,
  portOrInit: number | RequestInit | undefined,
  portParam: number | undefined,
  defaultPort: number
): { request: Request; port: number } {
  const request =
    requestOrUrl instanceof Request
      ? requestOrUrl
      : new Request(
          typeof requestOrUrl === 'string'
            ? requestOrUrl
            : requestOrUrl.toString(),
          typeof portOrInit === 'number' ? undefined : portOrInit
        );
  const port =
    typeof portOrInit === 'number'
      ? portOrInit
      : typeof portParam === 'number'
        ? portParam
        : defaultPort;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid container port: ${String(port)}`);
  }
  return { request, port };
}

function isWorkspaceLocation(value: string): boolean {
  return value === WORKSPACE_ROOT || value.startsWith(`${WORKSPACE_ROOT}/`);
}

/** Summarize an OpenCode SDK result whose body is an error or unexpected. */
function describeSdkFailure(result: {
  error?: unknown;
  response?: { status: number };
}): string {
  const status = result.response?.status;
  const detail =
    result.error === undefined
      ? 'no response body'
      : truncateOutput(JSON.stringify(result.error));
  return status === undefined ? detail : `HTTP ${status}: ${detail}`;
}

function truncateOutput(value: string, limit = 600): string {
  const collapsed = value.trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit)}…`
    : collapsed;
}

function isSafeRuntimeEpoch(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function runtimeLifecycleFromGate(
  gate: RuntimeGate | undefined,
  platformRunning: boolean
): InstanceRuntimeStatus['lifecycle'] {
  if (!platformRunning || gate?.phase === 'sleeping') {
    return 'sleeping';
  }
  switch (gate?.phase) {
    case 'waking':
      return 'waking';
    case 'quiescing':
      return 'quiescing';
    case 'checkpointing':
      return 'checkpointing';
    case 'stopping':
      return 'stopping';
    case 'running':
    default:
      return 'idle';
  }
}

function isStopGatePhase(phase: RuntimeGatePhase): boolean {
  return (
    phase === 'quiescing' ||
    phase === 'checkpointing' ||
    phase === 'stopping'
  );
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

function instanceContextFromReferrer(
  referrer: string | null
): { id: string; runtimeEpoch: string } | undefined {
  if (!referrer) {
    return undefined;
  }
  try {
    const url = new URL(referrer);
    const fromQuery = url.searchParams.get(UI_INSTANCE_PARAM);
    const runtimeFromQuery = url.searchParams.get(UI_RUNTIME_PARAM);
    if (
      fromQuery &&
      isSafeInstanceId(fromQuery) &&
      runtimeFromQuery &&
      isSafeRuntimeEpoch(runtimeFromQuery)
    ) {
      return { id: fromQuery, runtimeEpoch: runtimeFromQuery };
    }
    const scoped = /^\/ui\/([^/]+)\/([^/]+)/.exec(url.pathname);
    if (scoped) {
      const id = decodeRouteSegment(scoped[1]);
      const runtimeEpoch = decodeRouteSegment(scoped[2]);
      return isSafeInstanceId(id) && isSafeRuntimeEpoch(runtimeEpoch)
        ? { id, runtimeEpoch }
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function scopedUiPrefix(instanceId: string, runtimeEpoch: string): string {
  return `/ui/${encodeURIComponent(instanceId)}/${encodeURIComponent(runtimeEpoch)}/${UI_ASSET_VERSION_SEGMENT}`;
}

function gatewayPrefix(instanceId: string, runtimeEpoch: string): string {
  return `/gateway/${encodeURIComponent(instanceId)}/${encodeURIComponent(runtimeEpoch)}`;
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
