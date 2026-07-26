/**
 * The instance container: one Sandbox Durable Object per Hub instance.
 *
 * This object owns everything that happens inside a container — the R2-backed
 * workspace checkpoint/restore cycle, the runtime gate that admits requests
 * only for the current runtime generation, repository provisioning at wake
 * time, the semantic activity probe, and the deletion barrier. The Worker
 * router in [index.ts](index.ts) never reaches into a container except through
 * the RPC surface declared here.
 */
import {
  Sandbox as BaseSandbox,
  type DirectoryBackup
} from '@cloudflare/sandbox';
import { createOpencodeServer } from '@cloudflare/sandbox/opencode';
import type { Part } from '@opencode-ai/sdk/v2';
import {
  createOpencodeClient,
  type OpencodeClient
} from '@opencode-ai/sdk/v2/client';
import {
  isSafeRuntimeEpoch,
  isWebSocketUpgrade,
  truncateOutput
} from './http';
import type { InstanceRuntimeStatus } from './instances';
import {
  OPENCODE_PORT,
  RUNTIME_EPOCH_HEADER,
  type CreateOpencodeSessionInput,
  type ListOpencodeSessionMessagesInput,
  type PromptOpencodeSessionInput
} from './instance-runtime';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  OPENCODE_CONFIG
} from './opencode-config';
import {
  extractOpenCodeLocation,
  GLOBAL_SESSION_LIST_PATH,
  openCodeLocationsFromGlobalSessions,
  openCodeLocationKey,
  queryOpenCodeActivity,
  type OpenCodeLocation
} from './opencode-activity';
import {
  findRepo,
  isRepoKey,
  repoWorkspaceDirectory,
  WORKSPACE_ROOT
} from './repos';
import type { SessionMessage } from './sessions';

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
const QUIESCE_SETTLE_MS = 1_500;
const ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_TERMINATION_TIMEOUT_MS = 10_000;
const REPO_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_KNOWN_OPENCODE_LOCATIONS = 64;

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
   * Read one session's full message history from the running container.
   *
   * This is a passive read: it takes no work lease and does not touch the idle
   * deadline, so a session page left open never keeps a container alive. It
   * also never starts a stopped container — callers must resolve the running
   * runtime epoch first and treat its absence as "sleeping".
   */
  async listOpencodeSessionMessages(
    runtimeEpoch: string,
    input: ListOpencodeSessionMessagesInput
  ): Promise<SessionMessage[]> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      const client = this.createRuntimeClient(
        runtimeEpoch,
        'Reading OpenCode session messages'
      );
      const result = await client.session.messages({
        sessionID: input.opencodeSessionId,
        directory: input.directory
      });
      if (result.error !== undefined || result.response.status >= 400) {
        throw new Error(
          `Failed to read OpenCode session messages: ${describeSdkFailure(result)}`
        );
      }
      return result.data ?? [];
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
