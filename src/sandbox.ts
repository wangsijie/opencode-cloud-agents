/**
 * The instance orchestrator: one Sandbox Durable Object per Hub instance.
 *
 * This object owns everything that happens inside a container — the R2-backed
 * workspace checkpoint/restore cycle, the runtime gate that admits requests
 * only for the current runtime generation, repository provisioning at wake
 * time, the semantic activity probe, and the deletion barrier. The Worker
 * router in [index.ts](index.ts) never reaches into a container except through
 * the RPC surface declared here.
 *
 * It no longer *runs* the container. Everything physical — booting, exec, file
 * I/O, the OpenCode server, the HTTP proxy, snapshots — goes out over the
 * [Sandbox Host protocol](../protocol/PROTOCOL.md) through
 * [host-client.ts](host-client.ts), to whichever host the instance's provider
 * names. What stays here is the part no host may have: policy, state, and the
 * decision of when anything is allowed to happen.
 *
 * Because the platform's `container.running` is gone with the container
 * binding, "is it up" is this object's own record (`host:runtime`), written
 * whenever it starts or stops one and calibrated against the host's
 * `GET /sessions/:id` on the paths that can afford a round trip.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Part } from '@opencode-ai/sdk/v2';
import type { SessionProvider, SnapshotHandle } from '../protocol/types.ts';
import {
  createOpencodeClient,
  type OpencodeClient
} from '@opencode-ai/sdk/v2/client';
import {
  isContainerNotRunning,
  opencodeServerEnv,
  resolveHostClient,
  type HostClient
} from './host-client';
import {
  injectContainerCredentials,
  provisionRepository,
  readSessionChanges as readChangesOnHost
} from './runtime-ops';
import {
  isSafeRuntimeEpoch,
  isWebSocketUpgrade,
  truncateOutput
} from './http';
import { updateSession } from './hub-store';
import type {
  InstanceRuntimeStatus,
  WakeStageTimings,
  WakeTimings,
  WorkspaceLoss
} from './instances';
import {
  OPENCODE_PORT,
  RUNTIME_EPOCH_HEADER,
  type AbortOpencodeSessionInput,
  type CreateOpencodeSessionInput,
  type GetOpencodeSessionLineageInput,
  type ListOpencodeSessionMessagesInput,
  type OpencodeSessionActivityInput,
  type PromptOpencodeSessionInput
} from './instance-runtime';
import { loadContainerCredentials } from './container-credentials';
import { loadOpencodeConfig } from './model-catalog';
import {
  classifyLegacySessionStatuses,
  extractOpenCodeLocation,
  GLOBAL_SESSION_LIST_PATH,
  LEGACY_SESSION_STATUS_PATH,
  openCodeLocationsFromGlobalSessions,
  openCodeLocationKey,
  queryOpenCodeActivity,
  type OpenCodeLocation
} from './opencode-activity';
import {
  isSafeRepoDefinition,
  workspaceDirectory,
  WORKSPACE_ROOT,
  type RepoDefinition
} from './repos';
import type { SessionChanges } from './session-changes';
import { frameBelongsToSession, SseFrameBuffer } from './session-events';
import {
  walkSessionLineage,
  type AgentSessionLineage
} from './session-lineage';
import {
  buildWorkspaceFile,
  buildWorkspaceListing,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
  type WorkspaceDownload,
  type WorkspaceFile,
  type WorkspaceListing
} from './workspace-files';
import type { SessionAttachmentRef, SessionMessage } from './sessions';
import {
  buildTranscriptMirror,
  deleteTranscriptMirror,
  isOpencodePlaceholderTitle,
  putTranscriptMirror,
  transcriptMirrorSummary,
  type TranscriptMirrorReason,
  type TranscriptMirrorSummary
} from './transcript-mirror';

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
const TRANSCRIPT_TARGET_STORAGE_KEY = 'transcript:target';
const TRANSCRIPT_MIRROR_STORAGE_KEY = 'transcript:mirror';
const WAKE_TIMINGS_STORAGE_KEY = 'runtime:last-wake';
const WORKSPACE_LOST_STORAGE_KEY = 'persistence:workspace-lost';
/**
 * This object's own answer to "is the container up".
 *
 * The platform used to answer it synchronously through the container binding.
 * A host is a network hop away, so the answer is recorded here — written by
 * every call that starts or stops one, and re-read from the host wherever a
 * round trip is affordable (the runtime status, the activity probe, the stop
 * paths). It is persisted because a Durable Object restart must not come back
 * believing a running container is stopped.
 */
const HOST_RUNTIME_STORAGE_KEY = 'host:runtime';

const QUIESCE_SETTLE_MS = 1_500;
const ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
const MAX_KNOWN_OPENCODE_LOCATIONS = 64;

/**
 * How long a resolved sandbox host is reused before its settings are read
 * again.
 *
 * Only the remote host has settings to re-read, and the thing that changes
 * under a live session is its bearer token. A minute is the bound on how long a
 * rotated token keeps failing: short enough to be a rollout step rather than an
 * incident, long enough that a wake's dozen host calls share one D1 read.
 */
const HOST_CLIENT_TTL_MS = 60_000;

/**
 * Grace before a stop escalates to SIGKILL.
 *
 * Zero, deliberately. Lifecycle callers have already checkpointed and purge
 * callers have raised an irreversible deletion barrier, while a graceful
 * SIGTERM can wait on OpenCode's long-lived server for minutes with admission
 * already closed. The host bounds its own wait for the kill to land and answers
 * `stopped: false` if it has not, which keeps the operation retryable rather
 * than hanging.
 */
const STOP_GRACE_SECONDS = 0;

/**
 * How often a running container re-exports its transcript.
 *
 * This is the crash window: a container that dies without quiescing loses
 * whatever it produced since the last refresh. The activity probe drives the
 * beat, so a busy session (10s probes) refreshes on this interval while an idle
 * one (60s probes) refreshes at most once and then stops, because nothing has
 * changed to export.
 */
const TRANSCRIPT_MIRROR_REFRESH_MS = 60 * 1000;

/**
 * How long the live mirror waits after an event before exporting.
 *
 * The container's own event stream is what tells this object the conversation
 * moved, so the crash window above is no longer the probe interval — it is this
 * debounce. It is a trailing delay rather than a rate limit: a burst of part
 * updates during one generation costs a single export, and the last event of a
 * turn is always followed by one more.
 */
const TRANSCRIPT_MIRROR_LIVE_MS = 3 * 1000;

const OPENCODE_ENV = {
  // Keep OpenCode sessions and caches inside the snapshotted directory.
  // XDG_CONFIG_HOME remains unchanged so gh reads the injected
  // /root/.config/gh/hosts.yml login.
  XDG_DATA_HOME: `${WORKSPACE_ROOT}/.opencode-state/data`,
  XDG_STATE_HOME: `${WORKSPACE_ROOT}/.opencode-state/state`,
  XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.opencode-state/cache`
};

type CheckpointReason = 'manual' | 'idle-stop';

/**
 * A snapshot handle as this object stores it.
 *
 * The protocol treats handles as opaque and hands them back verbatim, which is
 * all the wake path needs. The ledger needs slightly more: purge deletes the R2
 * objects itself (PROTOCOL.md leaves snapshot deletion to the caller, which
 * holds both the ledger and the bucket), and the keys are derived from `id`.
 * Nothing else here reads inside a handle.
 */
interface StoredSnapshotHandle extends SnapshotHandle {
  id: string;
  dir: string;
}

interface StoredBackup {
  backup: StoredSnapshotHandle;
  createdAt: string;
  reason: CheckpointReason;
}

/**
 * What this object believes about the container behind it.
 *
 * `running` is the local truth every gate check reads; the rest is what
 * {@link InstanceRuntimeStatus} used to take from the platform's container
 * state and now takes from the host's `GET /sessions/:id`.
 */
interface HostRuntimeState {
  running: boolean;
  /** When the host last saw the run state change, if it said. */
  changedAt?: string;
  exitCode?: number;
  /** When this record was last written, from either a call or a probe. */
  observedAt: string;
  /** Set when the last read of the host itself failed. */
  error?: string;
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
  /**
   * Catalog repository provisioned during wake. Absent on an instance created
   * without one: nothing is cloned and the session works in `/workspace`.
   */
  repoKey?: string;
  /**
   * The catalog entry, pinned when the instance was created. Absent on
   * instances created before the catalog became dynamic, which resolve their
   * key against the static list instead — and on ones created with no
   * repository at all.
   */
  repo?: RepoDefinition;
  /**
   * Which sandbox host runs this instance's container. Absent on identities
   * stored before providers existed, which are all Cloudflare.
   */
  provider?: SessionProvider;
  state: 'active' | 'deleting';
  initializedAt: string;
}

/**
 * The OpenCode conversation this container mirrors.
 *
 * The Sandbox learns it by creating the session itself, so nothing has to plumb
 * the Hub's session record down here: one container is one session, and the
 * instance id is the session id.
 */
interface TranscriptTarget {
  opencodeSessionId: string;
  directory: string;
}

/**
 * An attached read of the container's event stream, bound to one runtime
 * generation. Both handles are kept because cancelling the reader is what
 * actually ends the read; the signal only covers the request that opened it.
 */
interface LiveEventSubscription {
  runtimeEpoch: string;
  abort: AbortController;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
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
export class Sandbox extends DurableObject<Env> {
  private readonly persistenceState: DurableObjectState<{}>;
  private readonly persistenceEnv: Env;
  private readonly lifecycleReady: Promise<void>;
  /** Local truth about the container; see {@link HOST_RUNTIME_STORAGE_KEY}. */
  private hostRuntime: HostRuntimeState = {
    running: false,
    observedAt: new Date(0).toISOString()
  };
  private hostClient: { client: HostClient; expiresAt: number } | undefined;
  private restoreInProgress: Promise<void> | undefined;
  private checkpointInProgress: Promise<StoredBackup> | undefined;
  private purgeInProgress: Promise<PurgeInstanceResult> | undefined;
  private cleanInProgress: Promise<PurgeInstanceResult> | undefined;
  private purgeRequested = false;
  private instanceIdentity: InstanceIdentity | undefined;
  private runtimeGate: RuntimeGate | undefined;
  private locationsNeedDiscovery = false;
  private knownLocations = new Map<string, OpenCodeLocation>([
    [
      openCodeLocationKey({ directory: WORKSPACE_DIRECTORY }),
      { directory: WORKSPACE_DIRECTORY }
    ]
  ]);
  private transcriptTarget: TranscriptTarget | undefined;
  private transcriptMirror: TranscriptMirrorSummary | undefined;
  /** Stage timings of the most recent wake, surfaced on the runtime status. */
  private lastWake: WakeTimings | undefined;
  private mirrorInProgress: Promise<TranscriptMirrorSummary | undefined> | undefined;
  /**
   * Whether anything may have happened since the last export. It starts true so
   * a Durable Object that was just restarted re-exports once instead of trusting
   * a watermark it did not write.
   */
  private transcriptDirty = true;
  /** The container event subscription that drives the live mirror, if attached. */
  private liveEvents: LiveEventSubscription | undefined;
  /** Whether a debounced live export is already scheduled. */
  private liveMirrorPending = false;
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
      const [
        purgeRequested,
        identity,
        runtimeGate,
        knownLocations,
        transcriptTarget,
        transcriptMirror,
        lastWake,
        hostRuntime
      ] = await Promise.all([
        ctx.storage.get<boolean>(PURGE_STORAGE_KEY),
        ctx.storage.get<InstanceIdentity>(IDENTITY_STORAGE_KEY),
        ctx.storage.get<RuntimeGate>(RUNTIME_GATE_STORAGE_KEY),
        ctx.storage.get<OpenCodeLocation[]>(KNOWN_LOCATIONS_STORAGE_KEY),
        ctx.storage.get<TranscriptTarget>(TRANSCRIPT_TARGET_STORAGE_KEY),
        ctx.storage.get<TranscriptMirrorSummary>(TRANSCRIPT_MIRROR_STORAGE_KEY),
        ctx.storage.get<WakeTimings>(WAKE_TIMINGS_STORAGE_KEY),
        ctx.storage.get<HostRuntimeState>(HOST_RUNTIME_STORAGE_KEY)
      ]);
      this.purgeRequested = Boolean(purgeRequested);
      if (hostRuntime) {
        this.hostRuntime = hostRuntime;
      }
      this.instanceIdentity = identity;
      this.runtimeGate = runtimeGate;
      this.transcriptTarget = transcriptTarget;
      this.transcriptMirror = transcriptMirror;
      this.lastWake = lastWake;
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

  /**
   * The host that runs this instance's container.
   *
   * An instance's provider is chosen when its session is created and never
   * changes, but *how* to reach that provider can: the Docker agent's origin,
   * token and image are operator settings. So the resolved client is cached for
   * {@link HOST_CLIENT_TTL_MS} rather than for this object's lifetime — long
   * enough that a wake does not re-read D1 a dozen times, short enough that a
   * rotated token takes effect without evicting the object.
   */
  private async host(): Promise<HostClient> {
    const identity = this.instanceIdentity;
    if (!identity) {
      throw new Error('This instance has no sandbox host');
    }
    const now = Date.now();
    if (this.hostClient && this.hostClient.expiresAt > now) {
      return this.hostClient.client;
    }
    const client = await resolveHostClient(
      this.persistenceEnv,
      identity.id,
      identity.provider ?? 'cloudflare'
    );
    this.hostClient = { client, expiresAt: now + HOST_CLIENT_TTL_MS };
    return client;
  }

  /**
   * Whether this instance's host can archive the workspace to durable storage.
   *
   * The capability is what the checkpoint and restore paths branch on: a host
   * without snapshots keeps the workspace on storage that outlives the
   * container, so there is nothing to archive and nothing to put back.
   */
  private async hostSupportsSnapshots(): Promise<boolean> {
    return (await this.host()).supportsSnapshots;
  }

  /** Record what this object now believes about the container. */
  private async setHostRuntime(
    state: Omit<HostRuntimeState, 'observedAt'>
  ): Promise<void> {
    const stored: HostRuntimeState = {
      ...state,
      observedAt: new Date().toISOString()
    };
    this.hostRuntime = stored;
    await this.persistenceState.storage.put(HOST_RUNTIME_STORAGE_KEY, stored);
  }

  /** Whether the container is up, as far as this object knows. */
  private get hostRunning(): boolean {
    return this.hostRuntime.running;
  }

  /**
   * Ask the host what is actually true and adopt the answer.
   *
   * A host that cannot be reached leaves the previous belief in place with the
   * failure recorded beside it: an unreachable host is not evidence that the
   * container stopped, and treating it as such would let a wake tear down a
   * container that is still serving.
   */
  private async refreshHostRuntime(): Promise<HostRuntimeState> {
    if (!this.instanceIdentity) {
      return this.hostRuntime;
    }
    try {
      const state = await (await this.host()).state();
      await this.setHostRuntime({
        running: state.running,
        ...(state.changedAt ? { changedAt: state.changedAt } : {}),
        ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode })
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.setHostRuntime({ ...this.hostRuntime, error: message });
      console.warn('Failed to read sandbox host session state', {
        instanceId: this.instanceIdentity.id,
        error: message
      });
    }
    return this.hostRuntime;
  }

  /**
   * Run one host call, keeping the local truth in step with what it reports.
   *
   * `CONTAINER_NOT_RUNNING` is the host telling us the container went away
   * under us, which is exactly the transition this record exists to notice.
   */
  private async onHost<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (isContainerNotRunning(error) && this.hostRuntime.running) {
        await this.setHostRuntime({ running: false });
      }
      throw error;
    }
  }

  async initializeInstance(
    id: string,
    repoKey?: string,
    repo?: RepoDefinition,
    provider: SessionProvider = 'cloudflare'
  ): Promise<void> {
    await this.lifecycleReady;
    if (this.purgeRequested) {
      throw new Error('A deleting instance cannot be initialized');
    }
    if (this.instanceIdentity) {
      if (
        this.instanceIdentity.id !== id ||
        this.instanceIdentity.repoKey !== repoKey ||
        (this.instanceIdentity.provider ?? 'cloudflare') !== provider
      ) {
        throw new Error('Sandbox identity does not match the Hub record');
      }
      if (this.instanceIdentity.state !== 'active') {
        throw new Error('A deleted instance cannot be reactivated');
      }
      this.instanceActive = true;
      if (!this.runtimeGate && !this.hostRunning) {
        await this.setRuntimeGate({ phase: 'sleeping', revision: 0 });
      }
      return;
    }

    // A new instance must arrive with its whole catalog entry: the clone URL is
    // needed at wake time, and nothing here can look one up. No key at all is
    // the other legal shape — a session with no repository, which clones
    // nothing and works in the workspace root.
    if (repoKey !== undefined && (!isSafeRepoDefinition(repo) || repo.repoKey !== repoKey)) {
      throw new Error(`Unknown repository: ${String(repoKey)}`);
    }
    const identity: InstanceIdentity = {
      id,
      ...(repoKey && repo ? { repoKey, repo } : {}),
      provider,
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

  /**
   * Bring the container up and put the workspace back inside it.
   *
   * The two are one step: the host's `ensure` is what boots a stopped
   * container, and a booted container is by definition on a fresh writable
   * filesystem until a snapshot is restored into it.
   */
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
      (await this.refreshHostRuntime()).running
    ) {
      return this.inspectExecutionIfRunning();
    }

    const revision = (this.runtimeGate?.revision ?? 0) + 1;
    await this.setRuntimeGate({
      phase: 'waking',
      runtimeEpoch: input.runtimeEpoch,
      revision
    });

    // Wake is the one thing a user waits through, so it is measured. The clock
    // starts here rather than in the coordinator: this is where the work is,
    // and attributing it per stage is what makes "the cold start is slow" an
    // answerable question instead of a complaint.
    const startedAt = Date.now();
    const timings: WakeStageTimings = {};
    const since = (mark: number) => Date.now() - mark;
    // A wake that finds the container already up is a restart of the OpenCode
    // server, not a cold start, and mixing the two would make the number
    // meaningless.
    const cold = !this.hostRunning;

    try {
      // The config lives in D1 now, so read it before touching the container:
      // an unconfigured deployment must fail the wake here, not after a boot.
      const opencodeConfig = await loadOpencodeConfig(this.persistenceEnv);
      const host = await this.host();

      const restoreStartedAt = Date.now();
      await this.ensureWorkspaceRestored();
      // Container boot is inside this number: `ensure` is what starts a stopped
      // container, and the restore is what follows it into the fresh
      // filesystem.
      timings.restoreMs = since(restoreStartedAt);

      // Credentials live outside /workspace, so a restored snapshot never
      // carries them; every boot injects them fresh, and before anything
      // reaches the repository over SSH.
      const credentialsStartedAt = Date.now();
      const operatorEnv = await injectContainerCredentials(
        host,
        await loadContainerCredentials(this.persistenceEnv),
        this.requireCheckout()
      );
      timings.credentialsMs = since(credentialsStartedAt);

      const provisionStartedAt = Date.now();
      const { fetching } = await provisionRepository(
        host,
        this.requireCheckout()
      );
      timings.repoMs = since(provisionStartedAt);

      const serverStartedAt = Date.now();
      // That fetch gates nothing the server needs, so it runs alongside the
      // server start instead of in front of it. On a warm wake this takes the
      // fetch — seconds against an SSH remote — off the serial path.
      await Promise.all([
        this.onHost(() =>
          host.opencodeStart({
            port: OPENCODE_PORT,
            directory: WORKSPACE_DIRECTORY,
            // The host never sees the stored config: the site derives the
            // environment the SDK used to derive in-container, and the operator's
            // variables and the XDG redirects are merged last so they win.
            env: opencodeServerEnv(opencodeConfig, {
              ...operatorEnv,
              ...OPENCODE_ENV
            })
          })
        ),
        fetching ?? Promise.resolve()
      ]);
      timings.serverMs = since(serverStartedAt);

      await this.setRuntimeGate({
        phase: 'running',
        runtimeEpoch: input.runtimeEpoch,
        revision
      });
      await this.recordWakeTimings({
        ...timings,
        totalMs: since(startedAt),
        at: new Date().toISOString(),
        cold
      });
      return await this.inspectExecutionIfRunning();
    } catch (error) {
      await this.setRuntimeGate({ phase: 'sleeping', revision });
      throw error;
    }
  }

  /**
   * Remember how long the last wake took, per stage.
   *
   * Kept on the Sandbox rather than the coordinator because this object is the
   * one that performs the stages, and it rides out to the UI on the runtime
   * status the session list already reads — so measuring costs no extra call.
   */
  private async recordWakeTimings(timings: WakeTimings): Promise<void> {
    this.lastWake = timings;
    await this.persistenceState.storage.put(WAKE_TIMINGS_STORAGE_KEY, timings);
  }

  async getExecutionSnapshotIfRunning(
    runtimeEpoch: string
  ): Promise<ExecutionSnapshot> {
    await this.lifecycleReady;
    return this.withLifecycleRead(async () => {
      if (
        this.runtimeGate?.phase !== 'running' ||
        this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
        !this.hostRunning
      ) {
        return notRunningExecutionSnapshot();
      }
      const snapshot = await this.inspectExecutionIfRunning();
      if (snapshot.active) {
        this.transcriptDirty = true;
      }
      // The live subscription is what normally keeps the mirror current, but it
      // does not survive a Durable Object restart. The probe is the beat that
      // notices and re-attaches it.
      this.startLiveTranscriptEvents();
      // The probe is also the mirror's safety net, and it must not wait for it:
      // the coordinator's idle accounting depends on this call staying quick,
      // and an export that fails is not a probe failure.
      this.scheduleTranscriptRefresh(runtimeEpoch);
      return snapshot;
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
    // A stop is rare and irreversible, so it starts from the host's own answer
    // rather than from what this object last believed.
    if (!(await this.refreshHostRuntime()).running) {
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
        // Let already-admitted requests finish before stopping. The parent
        // proxy can start a runtime while serving one, so none may remain
        // suspended across this boundary.
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
        // The OpenCode server is still up here, so the whole conversation can be
        // read in one call. After the checkpoint it is unreachable until the
        // next wake, which is exactly what the mirror exists to avoid.
        await this.mirrorTranscript('idle-stop');
        await this.persistWorkspaceBeforeStop('idle-stop');
        await this.setRuntimeGate({
          phase: 'stopping',
          revision,
          operationId: input.operationId
        });
      }
      if (this.hostRunning) {
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
      if ((await this.refreshHostRuntime()).running) {
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
    if (!(await this.refreshHostRuntime()).running) {
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
        await this.mirrorTranscript('force-stop');
        await this.persistWorkspaceBeforeStop('idle-stop');
        await this.setRuntimeGate({
          phase: 'stopping',
          revision,
          operationId: input.operationId
        });
      }
      if (this.hostRunning) {
        const terminated = await this.terminateContainerBounded();
        if (!terminated) {
          return { outcome: 'termination_pending' };
        }
      }
      await this.setRuntimeGate({ phase: 'sleeping', revision });
      return { outcome: 'stopped' };
    } catch (error) {
      if ((await this.refreshHostRuntime()).running) {
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
        !this.hostRunning
      ) {
        throw new Error('Manual checkpoint requires the current running epoch');
      }
      if (!(await this.hostSupportsSnapshots())) {
        // Not a failure to report on the persistence record: there is nothing
        // to check point because nothing is at risk. The workspace is on a
        // volume that outlives every container this session runs.
        throw new Error(
          'This session runs on a sandbox host that keeps the workspace on a persistent volume, so there is nothing to check point'
        );
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

  /**
   * The status the instance API and the session list read.
   *
   * This is the calibration point: it is called on every instance view, it can
   * afford one `GET /sessions/:id`, and it is where a container that stopped
   * without this object noticing — a host rollout, a crash — is turned back
   * into local truth before anything decides to wake or sleep it.
   */
  async getInstanceRuntimeStatus(): Promise<InstanceRuntimeStatus> {
    await this.lifecycleReady;
    const [state, persistence, workspaceLost] = await Promise.all([
      this.refreshHostRuntime(),
      this.getPersistenceStatus(),
      this.persistenceState.storage.get<WorkspaceLoss>(
        WORKSPACE_LOST_STORAGE_KEY
      )
    ]);

    return {
      container: containerStatusFromHost(state),
      ...(state.changedAt ? { containerLastChangedAt: state.changedAt } : {}),
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
      provider: this.instanceIdentity?.provider ?? 'cloudflare',
      deleting: this.purgeRequested,
      platformRunning: state.running,
      lifecycle: this.purgeRequested
        ? 'stopping'
        : runtimeLifecycleFromGate(this.runtimeGate, state.running),
      persistence,
      ...(workspaceLost ? { workspaceLost } : {}),
      ...(this.lastWake ? { lastWake: this.lastWake } : {}),
      ...(this.transcriptMirror ? { transcript: this.transcriptMirror } : {})
    };
  }

  /**
   * Forward one request to the container's OpenCode server, under the gate.
   *
   * This is what `containerFetch` was: the single door every passive read and
   * every SDK call goes through, refusing anything that is not for the current
   * running runtime generation. What changed is the far side — the host's
   * `proxy/` route rather than a container port — and that the epoch header is
   * consumed here rather than travelling into the container.
   *
   * It never starts anything. A stopped container answers 503 from the host and
   * a closed gate answers 410 from here; neither is a reason to boot one, which
   * is the whole point of a passive path.
   */
  private async proxyOpencodeFetch(request: Request): Promise<Response> {
    await this.lifecycleReady;
    const runtimeEpoch = request.headers.get(RUNTIME_EPOCH_HEADER);
    if (
      !runtimeEpoch ||
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
      !this.hostRunning
    ) {
      return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
    }

    await this.rememberRequestLocation(request);
    if (
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch ||
      !this.hostRunning
    ) {
      return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
    }
    this.beginActiveOperation();
    try {
      const response = await (await this.host()).proxyFetch(request);
      if (response.status === 503) {
        // The host is telling us the container went away under the gate. Adopt
        // that before answering, so the next caller is not admitted into a
        // runtime that no longer exists.
        await this.setHostRuntime({ running: false });
        await response.body?.cancel().catch(() => undefined);
        return runtimeUnavailableResponse(this.runtimeGate?.phase ?? 'sleeping');
      }
      return response;
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Attach to the container's event stream on behalf of a browser.
   *
   * The Worker used to reach the container through `containerFetch` for this
   * one path. It goes through the class instead, so the runtime gate decides —
   * and so the SSE body streams host → this object → the API → the browser
   * without ever being buffered.
   */
  async streamOpencodeEvents(
    runtimeEpoch: string,
    directory: string
  ): Promise<Response> {
    const url = new URL(`http://localhost:${OPENCODE_PORT}/event`);
    url.searchParams.set('directory', directory);
    return await this.proxyOpencodeFetch(
      new Request(url.toString(), {
        headers: {
          accept: 'text/event-stream',
          [RUNTIME_EPOCH_HEADER]: runtimeEpoch
        }
      })
    );
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
        directory: input.directory
      });
      const id = session.data?.id;
      if (!id) {
        throw new Error(
          `Failed to create OpenCode session: ${describeSdkFailure(session)}`
        );
      }
      // Creating the session is also how this object learns what to mirror.
      // Nothing else has to tell it: one container is one session.
      await this.setTranscriptTarget({
        opencodeSessionId: id,
        directory: input.directory
      });
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
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; filename?: string; url: string }
      > = [];
      for (const attachment of input.attachments ?? []) {
        const object = await this.persistenceEnv.SESSION_BUCKET.get(
          attachment.key
        );
        if (!object) {
          // The staging copy is gone for good; deliver the text rather than
          // wedging the retry ladder on an object no retry can bring back.
          console.warn('Prompt attachment missing from R2', {
            key: attachment.key
          });
          continue;
        }
        const bytes = new Uint8Array(await object.arrayBuffer());
        parts.push({
          type: 'file',
          mime: attachment.mime,
          ...(attachment.filename ? { filename: attachment.filename } : {}),
          url: `data:${attachment.mime};base64,${encodeBase64(bytes)}`
        });
      }
      parts.push({ type: 'text', text: input.text });
      // The message id is left to OpenCode: it encodes a sortable timestamp
      // that message ordering depends on, so an arbitrary id is not safe.
      const result = await client.session.promptAsync({
        sessionID: input.opencodeSessionId,
        directory: input.directory,
        model: {
          providerID: input.providerID,
          modelID: input.modelID
        },
        ...(input.variant ? { variant: input.variant } : {}),
        parts
      });
      if (result.error !== undefined || result.response.status >= 400) {
        throw new Error(
          `Failed to dispatch OpenCode prompt: ${describeSdkFailure(result)}`
        );
      }
      // An accepted prompt is the one moment this object knows for certain that
      // the transcript is about to move, even before the probe observes it.
      this.transcriptDirty = true;
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Whether the container is currently running agent work for one session.
   *
   * This reads the same `/session/status` the activity probe classifies, so it
   * is a passive observation: no work lease, no effect on the idle deadline,
   * and no ability to start a stopped container. The dispatcher uses it to
   * confirm one prompt has taken hold before handing over the next — see
   * [session-agent.ts](session-agent.ts) for why that ordering matters.
   */
  async isOpencodeSessionActive(
    runtimeEpoch: string,
    input: OpencodeSessionActivityInput
  ): Promise<boolean> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      const url = new URL(
        LEGACY_SESSION_STATUS_PATH,
        `http://localhost:${OPENCODE_PORT}`
      );
      url.searchParams.set('directory', input.directory);
      const response = await this.proxyOpencodeFetch(
        new Request(url.toString(), {
          headers: {
            accept: 'application/json',
            [RUNTIME_EPOCH_HEADER]: runtimeEpoch
          }
        })
      );
      if (!response.ok) {
        throw new Error(
          `Failed to read OpenCode session status (${response.status})`
        );
      }
      const activity = classifyLegacySessionStatuses(await response.json());
      return activity.activeSessionIds.includes(input.opencodeSessionId);
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
   * Resolve a subagent session's place under this container's root session.
   *
   * Passive like the message read, and for the same reason: the breadcrumb over
   * a subagent transcript is not worth waking a container for. `undefined` is
   * the honest answer for an id this container's session tree does not contain,
   * and the caller answers 404 rather than reading its messages.
   */
  async getOpencodeSessionLineage(
    runtimeEpoch: string,
    input: GetOpencodeSessionLineageInput
  ): Promise<AgentSessionLineage | undefined> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      const client = this.createRuntimeClient(
        runtimeEpoch,
        'Reading OpenCode session lineage'
      );
      const lineage = await walkSessionLineage(
        input.opencodeSessionId,
        input.rootOpencodeSessionId,
        async (id) => {
          const result = await client.session.get({
            sessionID: id,
            directory: input.directory
          });
          // A session OpenCode does not know is a dead end for the walk, not a
          // failure: it is how an id from a stale link reports itself.
          if (result.response.status === 404) {
            return undefined;
          }
          if (result.error !== undefined || result.response.status >= 400) {
            throw new Error(
              `Failed to read OpenCode session: ${describeSdkFailure(result)}`
            );
          }
          const session = result.data;
          return session
            ? {
                id: session.id,
                title: session.title,
                ...(session.agent ? { agent: session.agent } : {}),
                ...(session.parentID ? { parentID: session.parentID } : {})
              }
            : undefined;
        }
      );
      return lineage ? { lineage } : undefined;
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Stop whatever the agent is currently doing in this session.
   *
   * Abort is deliberately not treated as work: it ends activity rather than
   * creating it, so it takes no work lease and lets the idle window start
   * running as soon as the container settles.
   */
  async abortOpencodeSession(
    runtimeEpoch: string,
    input: AbortOpencodeSessionInput
  ): Promise<boolean> {
    await this.lifecycleReady;
    this.beginActiveOperation();
    try {
      const client = this.createRuntimeClient(
        runtimeEpoch,
        'Aborting an OpenCode session'
      );
      const result = await client.session.abort({
        sessionID: input.opencodeSessionId,
        directory: input.directory
      });
      if (result.error !== undefined || result.response.status >= 400) {
        throw new Error(
          `Failed to abort OpenCode session: ${describeSdkFailure(result)}`
        );
      }
      // OpenCode answers with a plain boolean: false means there was nothing
      // running to abort. Anything else is not a confirmation, so it is not
      // reported as one.
      return result.data === true;
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * List one directory of the session's checkout.
   *
   * A read, in the lifecycle sense: it needs a container that is already
   * running and never starts one, and it takes no work lease — browsing files
   * is looking at the session, not working in it.
   */
  async listWorkspaceDirectory(
    runtimeEpoch: string,
    path?: string
  ): Promise<WorkspaceListing> {
    await this.lifecycleReady;
    this.assertCurrentRuntime(runtimeEpoch, 'Listing workspace files');
    this.beginActiveOperation();
    try {
      const { directory } = this.requireCheckout();
      const relative = normalizeWorkspaceRelativePath(path);
      const target = resolveWorkspacePath(directory, relative);
      const listing = await this.onHost(async () =>
        (await this.host()).listFiles(target)
      );
      return buildWorkspaceListing(relative, listing.files);
    } finally {
      this.finishActiveOperation();
    }
  }

  /** Read one file of the session's checkout, under the same rules as listing. */
  async readWorkspaceFile(
    runtimeEpoch: string,
    path: string
  ): Promise<WorkspaceFile> {
    await this.lifecycleReady;
    this.assertCurrentRuntime(runtimeEpoch, 'Reading a workspace file');
    this.beginActiveOperation();
    try {
      const { directory } = this.requireCheckout();
      const relative = normalizeWorkspaceRelativePath(path);
      if (!relative) {
        throw new Error('A file path is required');
      }
      const result = await this.onHost(async () =>
        (await this.host()).readFile(resolveWorkspacePath(directory, relative))
      );
      return buildWorkspaceFile({
        path: relative,
        content: result.content,
        encoding: result.encoding
      });
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Read one file raw, for download rather than preview.
   *
   * Same path rules as {@link readWorkspaceFile}, but binary content comes back
   * instead of being described, and text is not truncated — the caller serves
   * the bytes as an attachment, not a page.
   */
  async downloadWorkspaceFile(
    runtimeEpoch: string,
    path: string
  ): Promise<WorkspaceDownload> {
    await this.lifecycleReady;
    this.assertCurrentRuntime(runtimeEpoch, 'Downloading a workspace file');
    this.beginActiveOperation();
    try {
      const { directory } = this.requireCheckout();
      const relative = normalizeWorkspaceRelativePath(path);
      if (!relative) {
        throw new Error('A file path is required');
      }
      const result = await this.onHost(async () =>
        (await this.host()).readFile(resolveWorkspacePath(directory, relative))
      );
      return {
        path: relative,
        content: result.content,
        encoding: result.encoding
      };
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Read what the agent changed in the session's checkout.
   *
   * The git itself is in [runtime-ops.ts](runtime-ops.ts), against the host
   * protocol; what stays here is the gate, the operation lease, and the refusal
   * to run git in a session that has no repository.
   */
  async readSessionChanges(runtimeEpoch: string): Promise<SessionChanges> {
    await this.lifecycleReady;
    this.assertCurrentRuntime(runtimeEpoch, 'Reading session changes');
    this.beginActiveOperation();
    try {
      return await this.onHost(async () =>
        readChangesOnHost(await this.host(), this.requireRepoCheckout())
      );
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * The directory this instance works in.
   *
   * It comes from the key alone, so it is always known — and it is the
   * workspace root itself for an instance created without a repository. The
   * catalog entry is only pinned on instances created since the catalog became
   * dynamic, and is only needed for the initial clone — everything afterwards
   * asks the checkout itself, which is both more available and more truthful.
   */
  private requireCheckout(): {
    repo?: RepoDefinition;
    repoKey?: string;
    directory: string;
    sessionId: string;
  } {
    const identity = this.instanceIdentity;
    if (!identity) {
      throw new Error('This instance has no workspace');
    }
    return {
      ...(identity.repo ? { repo: identity.repo } : {}),
      ...(identity.repoKey ? { repoKey: identity.repoKey } : {}),
      directory: workspaceDirectory(identity.repoKey),
      sessionId: identity.id
    };
  }

  /**
   * The same, for the git operations that only exist because there is a
   * checkout. A session created without a repository has no branch and no
   * diff, and saying so is better than running git in a directory that is not a
   * repository and relaying its message.
   */
  private requireRepoCheckout(): {
    repo?: RepoDefinition;
    repoKey: string;
    directory: string;
    sessionId: string;
  } {
    const checkout = this.requireCheckout();
    if (!checkout.repoKey) {
      throw new Error('This session was created without a repository');
    }
    return { ...checkout, repoKey: checkout.repoKey };
  }

  private assertCurrentRuntime(runtimeEpoch: string, intent: string): void {
    if (
      this.runtimeGate?.phase !== 'running' ||
      this.runtimeGate.runtimeEpoch !== runtimeEpoch
    ) {
      throw new Error(`${intent} requires the current runtime epoch`);
    }
  }

  private async setTranscriptTarget(target: TranscriptTarget): Promise<void> {
    if (
      this.transcriptTarget?.opencodeSessionId === target.opencodeSessionId &&
      this.transcriptTarget.directory === target.directory
    ) {
      return;
    }
    await this.persistenceState.storage.put(
      TRANSCRIPT_TARGET_STORAGE_KEY,
      target
    );
    this.transcriptTarget = target;
    this.transcriptDirty = true;
    // The subscription needs a target to filter by, so a container that only
    // learns its conversation now is where the live mirror starts.
    this.startLiveTranscriptEvents();
  }

  /**
   * Attach to the container's event stream so the mirror follows the
   * conversation instead of the probe.
   *
   * OpenCode publishes every message and part update on one server-wide stream.
   * Reading it here — inside the object that owns the container — is what makes
   * the mirror current within seconds, so a container that dies without
   * quiescing loses seconds of history rather than a probe interval, and the
   * session list sees a conversation move while it is still moving.
   *
   * This deliberately takes no work lease and no operation lease: it observes
   * work rather than performing it, so it neither holds off the idle deadline
   * nor blocks the drain that quiesce waits on.
   */
  private startLiveTranscriptEvents(): void {
    const runtimeEpoch = this.runtimeGate?.runtimeEpoch;
    if (
      this.runtimeGate?.phase !== 'running' ||
      !runtimeEpoch ||
      !this.transcriptTarget ||
      this.purgeRequested ||
      !this.hostRunning
    ) {
      return;
    }
    if (this.liveEvents?.runtimeEpoch === runtimeEpoch) {
      return;
    }
    this.stopLiveTranscriptEvents();

    const subscription: LiveEventSubscription = {
      runtimeEpoch,
      abort: new AbortController()
    };
    this.liveEvents = subscription;
    this.persistenceState.waitUntil(
      this.consumeLiveTranscriptEvents(subscription, this.transcriptTarget)
        .catch((error) => {
          // A dropped subscription degrades to the probe-driven refresh, which
          // is the behaviour that existed before it. It is not worth failing
          // anything over, but it is worth knowing about.
          console.warn('Live transcript event subscription ended', {
            instanceId: this.instanceIdentity?.id,
            error: error instanceof Error ? error.message : String(error)
          });
        })
        .finally(() => {
          if (this.liveEvents === subscription) {
            this.liveEvents = undefined;
          }
        })
    );
  }

  private stopLiveTranscriptEvents(): void {
    const subscription = this.liveEvents;
    if (!subscription) {
      return;
    }
    this.liveEvents = undefined;
    subscription.abort.abort();
    void subscription.reader?.cancel().catch(() => undefined);
  }

  private async consumeLiveTranscriptEvents(
    subscription: LiveEventSubscription,
    target: TranscriptTarget
  ): Promise<void> {
    if (!this.hostRunning) {
      return;
    }
    const url = new URL(`http://localhost:${OPENCODE_PORT}/event`);
    url.searchParams.set('directory', target.directory);
    // Straight through the host proxy, like the mirror client, rather than
    // through the gate: this read outlives the gate's `running` phase by
    // design, ending when the stream ends rather than when the gate closes to
    // outside requests.
    const response = await (await this.host()).proxyFetch(
      new Request(url.toString(), {
        headers: { accept: 'text/event-stream' }
      }),
      subscription.abort.signal
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Event stream unavailable (${response.status})`);
    }

    const reader = response.body.getReader();
    subscription.reader = reader;
    const decoder = new TextDecoder();
    const frames = new SseFrameBuffer();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.liveEvents !== subscription) {
          return;
        }
        for (const frame of frames.push(
          decoder.decode(value, { stream: true })
        )) {
          if (frameBelongsToSession(frame, target.opencodeSessionId)) {
            this.noteLiveTranscriptEvent(subscription.runtimeEpoch);
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  /**
   * Record that the conversation moved and schedule one export for the burst.
   *
   * The delay is trailing, so the export that runs after a quiet moment always
   * includes the event that started the timer and everything that followed it.
   */
  private noteLiveTranscriptEvent(runtimeEpoch: string): void {
    this.transcriptDirty = true;
    if (this.liveMirrorPending) {
      return;
    }
    this.liveMirrorPending = true;
    this.persistenceState.waitUntil(
      (async () => {
        try {
          await scheduler.wait(TRANSCRIPT_MIRROR_LIVE_MS);
        } finally {
          this.liveMirrorPending = false;
        }
        await this.mirrorTranscript('live', runtimeEpoch);
      })().catch(() => undefined)
    );
  }

  /**
   * Export the session transcript to R2 if enough has changed since the last one.
   *
   * This runs detached from the probe that triggers it. It is the only mirror
   * path that may be skipped: the export during quiesce is the one that has to
   * be complete, and this one exists purely to bound what a crashed container
   * loses.
   */
  private scheduleTranscriptRefresh(runtimeEpoch: string): void {
    if (!this.transcriptTarget || !this.transcriptDirty || this.mirrorInProgress) {
      return;
    }
    const mirroredAt = this.transcriptMirror?.mirroredAt;
    if (
      mirroredAt &&
      Date.now() - Date.parse(mirroredAt) < TRANSCRIPT_MIRROR_REFRESH_MS
    ) {
      return;
    }
    this.persistenceState.waitUntil(
      this.mirrorTranscript('refresh', runtimeEpoch).catch(() => undefined)
    );
  }

  /**
   * Copy the whole conversation to R2 and record the watermark.
   *
   * The read deliberately bypasses the runtime gate: the gate exists to keep
   * *outside* requests away from a container that is shutting down, whereas this
   * call is the shutdown, running between the last idle confirmation and the
   * checkpoint. It stays honest by going straight to the host's proxy, which by
   * construction reaches this object's own container or nothing.
   *
   * A failure is reported and swallowed. Losing an export means a sleeping
   * session shows an older history; failing the stop around it would mean a
   * container that never sleeps.
   */
  private async mirrorTranscript(
    reason: TranscriptMirrorReason,
    runtimeEpoch?: string
  ): Promise<TranscriptMirrorSummary | undefined> {
    const pending = this.mirrorInProgress;
    if (pending && reason === 'refresh') {
      // A refresh only has to be recent, so it rides along with the export that
      // is already running instead of reading the whole history twice.
      return pending;
    }
    // A shutdown export has to be complete, so it waits out an in-flight
    // refresh rather than adopting its slightly older result. `pending` never
    // rejects, so this cannot fail the stop it belongs to.
    const run = pending
      ? pending.then(() => this.captureTranscript(reason, runtimeEpoch))
      : this.captureTranscript(reason, runtimeEpoch);
    this.mirrorInProgress = run;
    void run.finally(() => {
      if (this.mirrorInProgress === run) {
        this.mirrorInProgress = undefined;
      }
    });
    return run;
  }

  /** One export attempt, reporting its own failure rather than raising it. */
  private async captureTranscript(
    reason: TranscriptMirrorReason,
    runtimeEpoch?: string
  ): Promise<TranscriptMirrorSummary | undefined> {
    try {
      return await this.doMirrorTranscript(reason, runtimeEpoch);
    } catch (error) {
      console.warn('Failed to mirror session transcript', {
        instanceId: this.instanceIdentity?.id,
        reason,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }

  private async doMirrorTranscript(
    reason: TranscriptMirrorReason,
    runtimeEpoch?: string
  ): Promise<TranscriptMirrorSummary | undefined> {
    const target = this.transcriptTarget;
    const sessionId = this.instanceIdentity?.id;
    if (
      !target ||
      !sessionId ||
      this.purgeRequested ||
      !this.hostRunning
    ) {
      return undefined;
    }
    if (runtimeEpoch && this.runtimeGate?.runtimeEpoch !== runtimeEpoch) {
      // A refresh scheduled by a probe of a runtime that has since been replaced
      // has nothing useful to say about the current one.
      return undefined;
    }

    // Clear the flag before reading, not after: anything that happens during the
    // read must leave the transcript marked dirty for the next beat.
    this.transcriptDirty = false;
    const mirroredAt = new Date().toISOString();
    try {
      const result = await this.createTranscriptClient().session.messages({
        sessionID: target.opencodeSessionId,
        directory: target.directory
      });
      if (result.error !== undefined || result.response.status >= 400) {
        throw new Error(
          `Failed to read OpenCode session messages: ${describeSdkFailure(result)}`
        );
      }
      const opencodeTitle = await this.readOpencodeTitle(target);
      if (opencodeTitle && opencodeTitle !== this.transcriptMirror?.opencodeTitle) {
        void updateSession(this.persistenceEnv, sessionId, { title: opencodeTitle })
          .catch((error: unknown) => {
            console.warn('Failed to sync auto-generated title to Hub session', {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            });
          });
      }
      const mirror = buildTranscriptMirror({
        sessionId,
        opencodeSessionId: target.opencodeSessionId,
        reason,
        mirroredAt,
        messages: result.data ?? [],
        ...(opencodeTitle ? { opencodeTitle } : {})
      });
      await putTranscriptMirror(this.persistenceEnv.SESSION_BUCKET, mirror);

      const summary = transcriptMirrorSummary(mirror);
      await this.persistenceState.storage.put(
        TRANSCRIPT_MIRROR_STORAGE_KEY,
        summary
      );
      this.transcriptMirror = summary;
      return summary;
    } catch (error) {
      this.transcriptDirty = true;
      throw error;
    }
  }

  /**
   * The title OpenCode gave this conversation, for the mirror to carry.
   *
   * The placeholder a fresh session wears until OpenCode names it counts as no
   * title: adopting it would briefly rename the session to "New session - …"
   * between the prompt-derived label and the generated one. A failure returns
   * the title already known rather than dropping it, because losing a good
   * title to a transient read would rename the session in the list.
   */
  private async readOpencodeTitle(
    target: TranscriptTarget
  ): Promise<string | undefined> {
    const stored = this.transcriptMirror?.opencodeTitle;
    const known =
      stored && !isOpencodePlaceholderTitle(stored) ? stored : undefined;
    try {
      const result = await this.createTranscriptClient().session.get({
        sessionID: target.opencodeSessionId,
        directory: target.directory
      });
      const title =
        typeof result.data?.title === 'string' ? result.data.title.trim() : '';
      return title && !isOpencodePlaceholderTitle(title) ? title : known;
    } catch {
      return known;
    }
  }

  /**
   * An OpenCode client for the mirror, valid for as long as this object's own
   * container is running — including the quiescing and checkpointing phases the
   * epoch-gated client refuses.
   */
  private createTranscriptClient(): OpencodeClient {
    return createOpencodeClient({
      baseUrl: `http://localhost:${OPENCODE_PORT}`,
      fetch: async (input, init) => {
        if (!this.hostRunning) {
          throw new Error('Mirroring requires a running container');
        }
        return (await this.host()).proxyFetch(new Request(input, init));
      }
    });
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
    this.assertCurrentRuntime(runtimeEpoch, intent);
    return createOpencodeClient({
      baseUrl: `http://localhost:${OPENCODE_PORT}`,
      fetch: (input, init) => {
        const request = new Request(input, init);
        const headers = new Headers(request.headers);
        headers.set(RUNTIME_EPOCH_HEADER, runtimeEpoch);
        return this.proxyOpencodeFetch(new Request(request, { headers }));
      }
    });
  }

  async runSdkTest(runtimeEpoch: string): Promise<Response> {
    await this.lifecycleReady;
    this.beginActiveOperation();

    try {
      const client = this.createRuntimeClient(runtimeEpoch, 'The SDK test');

      // The default model is whatever the stored config says it is.
      const config = await loadOpencodeConfig(this.persistenceEnv);
      const defaultRef = config.model ?? '';
      const separator = defaultRef.indexOf('/');
      if (separator <= 0) {
        throw new Error(`The configured default model is invalid: ${defaultRef}`);
      }

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
          providerID: defaultRef.slice(0, separator),
          modelID: defaultRef.slice(separator + 1)
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
      this.purgeInProgress = this.doPurgeInstance({
        keepTranscript: false
      }).finally(() => {
        this.purgeInProgress = undefined;
      });
    }
    return this.purgeInProgress;
  }

  /**
   * The idle sweep's ending: like {@link purgeInstance} it destroys the
   * container, its workspace and every snapshot, but the transcript mirror and
   * this object's storage stay — they are what keeps the cleaned session
   * readable. A later real deletion still runs the full purge on top of this.
   */
  async cleanInstance(): Promise<PurgeInstanceResult> {
    await this.lifecycleReady;
    if (!this.cleanInProgress) {
      this.cleanInProgress = this.doPurgeInstance({
        keepTranscript: true
      }).finally(() => {
        this.cleanInProgress = undefined;
      });
    }
    return this.cleanInProgress;
  }

  /**
   * The stored transcript summary, without touching the host. The runtime
   * status would ask the host how the container is doing — the wrong question
   * about an instance whose container has been cleaned away.
   */
  async getTranscriptSummary(): Promise<TranscriptMirrorSummary | undefined> {
    await this.lifecycleReady;
    return this.transcriptMirror;
  }

  /**
   * Nothing reaches this object over HTTP.
   *
   * Every operation the Worker asks for is an RPC method on this class, and
   * each one takes the runtime gate on the way in. The one thing that ever
   * arrived here as a request was the terminal's WebSocket upgrade, which the
   * control-plane admission check refused every single time; it is named
   * because a future terminal must go through the class rather than around it
   * (see AGENTS.md).
   */
  async fetch(request: Request): Promise<Response> {
    return new Response(
      isWebSocketUpgrade(request)
        ? 'This Sandbox does not serve WebSocket upgrades'
        : 'This Sandbox is reached by RPC, not by HTTP',
      { status: 404 }
    );
  }

  /**
   * Nothing sets an alarm on this object.
   *
   * The sandbox SDK's transport-activity timer did, and a Durable Object that
   * has one stored will keep being called until it is cleared — so this exists
   * to clear the inherited one rather than to fail forever on a handler that no
   * longer exists.
   */
  async alarm(): Promise<void> {
    await this.persistenceState.storage.deleteAlarm();
  }

  private async doPurgeInstance(options: {
    /**
     * True for cleanup: the R2 transcript mirror and this object's storage
     * survive so the session's history stays readable; only the container, its
     * workspace and the snapshots go.
     */
    keepTranscript: boolean;
  }): Promise<PurgeInstanceResult> {
    this.purgeRequested = true;
    this.instanceActive = false;
    // Nothing about a deleted instance is worth mirroring, and the stream would
    // otherwise hold a read open against a container being destroyed.
    this.stopLiveTranscriptEvents();
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
    // been raised, and it must destroy the workspace storage as well as the
    // container — which is `DELETE`, not `stop`. It stays retryable: a host
    // that is still terminating answers `removed: false` rather than blocking.
    const removed = await this.onHost(async () => (await this.host()).remove());
    if (!removed.removed) {
      return { outcome: 'termination_pending' };
    }
    await this.setHostRuntime({ running: false });
    await this.deleteBackupObjects(backups);
    if (options.keepTranscript) {
      // Cleanup keeps the mirror and this object's storage — the stored
      // transcript summary is what the session list still renders — but the
      // snapshots are gone, so the backup bookkeeping must say so too.
      await this.persistenceState.storage.delete(BACKUP_STORAGE_KEY);
      await this.replaceBackupHandleLedger([]);
      return { outcome: 'purged' };
    }
    if (this.instanceIdentity?.id) {
      // The transcript mirror is R2 state this instance owns — in the session
      // bucket rather than with the snapshots, but swept at the same moment so
      // it does not outlive the session as an orphan.
      await deleteTranscriptMirror(
        this.persistenceEnv.SESSION_BUCKET,
        this.instanceIdentity.id
      );
    }
    await this.persistenceState.storage.deleteAll();
    return { outcome: 'purged' };
  }

  /**
   * Stop the container and wait, bounded, for the host to agree it is down.
   *
   * The grace period is zero: callers have either checkpointed or raised the
   * deletion barrier, and a graceful SIGTERM can wait on OpenCode's long-lived
   * server for minutes with admission already closed. `false` means termination
   * is still pending — admission stays closed and the coordinator's alarm takes
   * the next step, rather than this object blocking on a host that may be in
   * trouble.
   */
  private async terminateContainerBounded(): Promise<boolean> {
    try {
      const result = await (await this.host()).stop(STOP_GRACE_SECONDS);
      if (result.stopped) {
        await this.setHostRuntime({ running: false });
      }
      return result.stopped;
    } catch (error) {
      if (isContainerNotRunning(error)) {
        await this.setHostRuntime({ running: false });
        return true;
      }
      console.warn('Container termination failed', error);
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
    const host = await this.host();
    // `ensure` is what boots a stopped container, so it comes first: every call
    // below needs one running, and on an ephemeral host a container that had to
    // be started is by definition on an empty workspace.
    await host.ensure();
    await this.setHostRuntime({ running: true });

    const marker = await this.onHost(() => host.exists(PERSISTENCE_MARKER));
    if (marker.exists) {
      return;
    }

    // A host without snapshots keeps the workspace on storage that outlives the
    // container, so there is never anything to put back — and by the same
    // token, a missing marker is not "the snapshot has not been restored yet"
    // but "the storage itself was recreated". Reading the ledger would only
    // find handles that host never wrote.
    const storedBackup = host.supportsSnapshots
      ? await this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY)
      : undefined;

    // A fresh writable filesystem with no snapshot to put back means the
    // previous container died without checkpointing. OpenCode keeps its whole
    // state under /workspace (see OPENCODE_ENV), so the conversation this
    // instance was running no longer exists anywhere the container can reach.
    // Record it here, at the first moment it is knowable, rather than letting
    // the session discover it a wake and a 404 later.
    if (!storedBackup) {
      await this.recordWorkspaceLoss();
    }

    try {
      if (storedBackup) {
        await this.onHost(() => host.snapshotRestore(storedBackup.backup));
        await this.persistenceState.storage.put(
          RESTORE_STORAGE_KEY,
          new Date().toISOString()
        );
      }

      // The marker lives inside /workspace and therefore distinguishes a fresh
      // image from the currently restored writable filesystem — or, on a
      // volume-persistent host, a recreated volume from the one this session
      // has been working in.
      await this.onHost(() =>
        host.writeBatch([
          {
            path: PERSISTENCE_MARKER,
            content: JSON.stringify({ readyAt: new Date().toISOString() })
          }
        ])
      );
      await this.persistenceState.storage.delete(ERROR_STORAGE_KEY);
    } catch (error) {
      await this.recordPersistenceError('restore', error);
      throw error;
    }
  }

  /**
   * Remember that this instance came up on an empty workspace while it owned an
   * OpenCode session.
   *
   * Only recorded when there is a session to lose: an instance that has never
   * created one has nothing to restore, which is the ordinary first wake. The
   * record is keyed by the session id it invalidates so a later session on the
   * same instance is not condemned by an older loss.
   */
  private async recordWorkspaceLoss(): Promise<void> {
    const opencodeSessionId = this.transcriptTarget?.opencodeSessionId;
    if (!opencodeSessionId) {
      return;
    }
    const existing =
      await this.persistenceState.storage.get<WorkspaceLoss>(
        WORKSPACE_LOST_STORAGE_KEY
      );
    if (existing?.opencodeSessionId === opencodeSessionId) {
      return;
    }
    const loss: WorkspaceLoss = {
      at: new Date().toISOString(),
      opencodeSessionId
    };
    await this.persistenceState.storage.put(WORKSPACE_LOST_STORAGE_KEY, loss);
    console.warn('Workspace lost without a checkpoint', {
      instanceId: this.instanceIdentity?.id,
      opencodeSessionId
    });
  }

  /**
   * Make the workspace survive the container that is about to stop.
   *
   * On a host with snapshots that is a checkpoint: the workspace only exists
   * inside the container, so it has to be archived or it is gone. On one
   * without, the workspace is on storage that outlives the container and the
   * only thing left to do is flush dirty pages onto it — the same `sync` a
   * checkpoint runs before archiving, without the archive.
   *
   * Both paths run after the transcript export, which is the part that must
   * happen while OpenCode is still answering; this is what makes stopping a
   * volume-persistent session a degradation of the same sequence rather than a
   * second one.
   */
  private async persistWorkspaceBeforeStop(
    reason: CheckpointReason
  ): Promise<void> {
    if (await this.hostSupportsSnapshots()) {
      await this.createCheckpoint(reason);
      return;
    }
    const host = await this.host();
    await this.onHost(() => host.exec('sync'));
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

    const host = await this.host();
    const [previous, tracked] = await Promise.all([
      this.persistenceState.storage.get<StoredBackup>(BACKUP_STORAGE_KEY),
      this.getTrackedBackupHandles()
    ]);

    if (!host.supportsSnapshots) {
      throw new Error('This sandbox host does not support snapshots');
    }
    try {
      await this.onHost(() =>
        host.writeBatch([
          {
            path: PERSISTENCE_MARKER,
            content: JSON.stringify({
              checkpointStartedAt: new Date().toISOString()
            })
          }
        ])
      );
      await this.onHost(() => host.exec('sync'));

      // The protocol has no excludes and never will: the host is the one that
      // runs mksquashfs, and the rule — with the eight hours of lost
      // conversations behind it — is written down beside it in host/host.ts.
      const { handle } = await this.onHost(() =>
        host.snapshot({
          dir: WORKSPACE_ROOT,
          name: `opencode:${this.instanceIdentity!.id}:${reason}`,
          ttlSeconds: BACKUP_TTL_SECONDS
        })
      );
      const backup = asStoredHandle(handle);
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
      const remaining: StoredSnapshotHandle[] = [backup];
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

  private async getTrackedBackupHandles(): Promise<StoredSnapshotHandle[]> {
    const [legacy, ledger] = await Promise.all([
      this.persistenceState.storage.get<StoredSnapshotHandle[]>(
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
    Map<string, StoredSnapshotHandle>
  > {
    const result = new Map<string, StoredSnapshotHandle>();
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.persistenceState.storage.list<StoredSnapshotHandle>({
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
    backups: StoredSnapshotHandle[]
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
    backups: StoredSnapshotHandle[]
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

  private async discoverOwnedBackups(): Promise<StoredSnapshotHandle[]> {
    const owner = this.instanceIdentity?.id;
    if (!owner) {
      return [];
    }
    // This walks the whole `backups/` prefix looking for objects the ledger
    // lost track of. A host without snapshots never put one there, so the scan
    // could only ever return other instances' objects.
    if (!(await this.hostSupportsSnapshots())) {
      return [];
    }

    const discovered: StoredSnapshotHandle[] = [];
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
    // The gate is the one place every runtime transition passes through, so it
    // is where the live subscription is bound to a generation: it follows a
    // container that starts running and is dropped the moment one stops being
    // the current one.
    if (stored.phase === 'running') {
      this.startLiveTranscriptEvents();
    } else {
      // Every other phase is on the way down (or already there). The shutdown
      // export reads the whole history anyway, so nothing is lost by letting go
      // of the stream first.
      this.stopLiveTranscriptEvents();
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
    if (!this.hostRunning) {
      return 'Cannot discover OpenCode locations while the container is stopped';
    }

    try {
      const url = new URL(
        GLOBAL_SESSION_LIST_PATH,
        `http://localhost:${OPENCODE_PORT}`
      );
      url.searchParams.set('roots', 'true');
      url.searchParams.set('limit', '1000');
      const response = await (await this.host()).proxyFetch(
        new Request(url, { headers: { Accept: 'application/json' } }),
        AbortSignal.timeout(ACTIVITY_PROBE_TIMEOUT_MS)
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
    if (!this.hostRunning) {
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
        if (!this.hostRunning) {
          throw new Error('Container stopped during activity probe');
        }
        return this.onHost(async () => (await this.host()).proxyFetch(request));
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
  handles: StoredSnapshotHandle[],
  ...optional: Array<StoredSnapshotHandle | undefined>
): StoredSnapshotHandle[] {
  const merged = new Map<string, StoredSnapshotHandle>();
  for (const backup of [...handles, ...optional]) {
    if (backup) {
      merged.set(backup.id, backup);
    }
  }
  return [...merged.values()];
}

/**
 * The container state the instance API reports, from what the host said.
 *
 * The platform used to distinguish `healthy` from `running`; a host reports
 * neither, so a running container is `running` and a stopped one is
 * `stopped_with_code` when it left an exit code behind. `unknown` is reserved
 * for the case the status field exists to carry: the host could not be reached
 * at all, so nothing here is known rather than presumed stopped.
 */
function containerStatusFromHost(
  state: HostRuntimeState
): InstanceRuntimeStatus['container'] {
  if (state.error) {
    return 'unknown';
  }
  if (state.running) {
    return 'running';
  }
  return state.exitCode === undefined ? 'stopped' : 'stopped_with_code';
}

/**
 * Adopt a snapshot handle into the ledger.
 *
 * Handles are opaque to the protocol, but the ledger indexes them by `id` and
 * purge derives the R2 keys from it, so a host that returned something else has
 * handed back a handle this object cannot track — which is worth failing the
 * checkpoint over rather than storing an entry nothing can ever delete.
 */
function asStoredHandle(handle: SnapshotHandle): StoredSnapshotHandle {
  if (typeof handle.id !== 'string' || typeof handle.dir !== 'string') {
    throw new Error('The sandbox host returned an untrackable snapshot handle');
  }
  return handle as StoredSnapshotHandle;
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

function isWorkspaceLocation(value: string): boolean {
  return value === WORKSPACE_ROOT || value.startsWith(`${WORKSPACE_ROOT}/`);
}

/** Summarize an OpenCode SDK result whose body is an error or unexpected. */
/**
 * Base64-encode in chunks: spreading a multi-megabyte image into one
 * `String.fromCharCode(...)` call overflows the argument limit.
 */
function encodeBase64(bytes: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE)
    );
  }
  return btoa(binary);
}

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
