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
import { getHub } from './instance-access';
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
  type ListOpencodeSessionMessagesInput,
  type OpencodeSessionActivityInput,
  type PromptOpencodeSessionInput
} from './instance-runtime';
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER_ID,
  OPENCODE_CONFIG
} from './opencode-config';
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
  repoWorkspaceDirectory,
  WORKSPACE_ROOT,
  type RepoDefinition
} from './repos';
import {
  isSafeBranchName,
  limitDiff,
  normalizeCommitMessage,
  parseGitStatus,
  parsePullRequestUrl,
  resolvePublishBranch,
  shellQuote,
  type PublishSessionChangesInput,
  type PublishSessionChangesResult,
  type SessionChanges,
  type SessionChangesHead
} from './session-changes';
import { frameBelongsToSession, SseFrameBuffer } from './session-events';
import {
  buildWorkspaceFile,
  buildWorkspaceListing,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
  type WorkspaceFile,
  type WorkspaceListing
} from './workspace-files';
import type { SessionMessage } from './sessions';
import {
  buildTranscriptMirror,
  deleteTranscriptMirror,
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
 * Nothing is left out of the workspace snapshot.
 *
 * This used to exclude `.opencode-state/cache`, and that one entry silently
 * dropped the whole `.opencode-state` tree from every archive — including
 * `data/opencode/opencode.db`, which is the entire conversation. Every session
 * that slept between 2026-07-26 08:15 UTC and this fix came back to a container
 * that had never heard of it, and answered the next prompt with a 404.
 *
 * The mechanism is in the container, not here. `createArchive` expands every
 * exclude into two patterns — the pattern itself and `... <pattern>`, the
 * match-at-any-depth form — and writes both into an `-ef` file. Verified inside
 * `cloudflare/sandbox:0.12.3`, whose mksquashfs is 4.5:
 *
 *   .opencode-state/cache        → drops the cache, correctly
 *   ... .opencode-state/cache    → drops all of .opencode-state
 *
 * So any exclude with a `/` in it takes its parent directory with it. (4.6
 * locally does not, which is what makes this so easy to miss.)
 *
 * Do not add an exclude back without unpacking a real archive afterwards to see
 * what survived. This failure is invisible from every angle the Hub can see:
 * the checkpoint succeeds, the restore succeeds, `hasBackup` is true, and the
 * only symptom arrives one wake later as somebody else's 404.
 *
 * The cache it was saving was 3 MB of a 165 MB archive.
 */
const CHECKPOINT_EXCLUDES: string[] = [];
const QUIESCE_SETTLE_MS = 1_500;
const ACTIVITY_PROBE_TIMEOUT_MS = 5_000;
const CONTAINER_TERMINATION_TIMEOUT_MS = 10_000;
const REPO_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const GH_COMMAND_TIMEOUT_MS = 60 * 1000;
const MAX_KNOWN_OPENCODE_LOCATIONS = 64;

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
  /**
   * The catalog entry, pinned when the instance was created. Absent on
   * instances created before the catalog became dynamic, which resolve their
   * key against the static list instead.
   */
  repo?: RepoDefinition;
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
        lastWake
      ] = await Promise.all([
        ctx.storage.get<boolean>(PURGE_STORAGE_KEY),
        ctx.storage.get<InstanceIdentity>(IDENTITY_STORAGE_KEY),
        ctx.storage.get<RuntimeGate>(RUNTIME_GATE_STORAGE_KEY),
        ctx.storage.get<OpenCodeLocation[]>(KNOWN_LOCATIONS_STORAGE_KEY),
        ctx.storage.get<TranscriptTarget>(TRANSCRIPT_TARGET_STORAGE_KEY),
        ctx.storage.get<TranscriptMirrorSummary>(TRANSCRIPT_MIRROR_STORAGE_KEY),
        ctx.storage.get<WakeTimings>(WAKE_TIMINGS_STORAGE_KEY)
      ]);
      this.purgeRequested = Boolean(purgeRequested);
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

  async initializeInstance(
    id: string,
    repoKey: string,
    repo?: RepoDefinition
  ): Promise<void> {
    await this.lifecycleReady;
    await this.setKeepAlive(true);
    if (this.purgeRequested) {
      throw new Error('A deleting instance cannot be initialized');
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

    // A new instance must arrive with its whole catalog entry: the clone URL is
    // needed at wake time, and nothing here can look one up.
    if (!isSafeRepoDefinition(repo) || repo.repoKey !== repoKey) {
      throw new Error(`Unknown repository: ${String(repoKey)}`);
    }
    const identity: InstanceIdentity = {
      id,
      repoKey,
      repo,
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
    const cold = this.persistenceState.container?.running !== true;

    try {
      const restoreStartedAt = Date.now();
      await this.ensureWorkspaceRestored();
      // Container boot is inside this number: the first call into a stopped
      // container is what starts it, and that call is the restore.
      timings.restoreMs = since(restoreStartedAt);

      // Provisioning and the server start share one control-plane scope. The
      // resumed-checkout fetch outlives the call that started it, and the scope
      // is what admits its container traffic — closing it in between would fail
      // the fetch on the next command it issues.
      await this.withControlPlaneAccess(async () => {
        const provisionStartedAt = Date.now();
        const deferredFetch = await this.ensureRepoProvisioned();
        timings.repoMs = since(provisionStartedAt);

        const serverStartedAt = Date.now();
        // That fetch gates nothing the server needs, so it runs alongside the
        // server start instead of in front of it. On a warm wake this takes the
        // fetch — seconds against an SSH remote — off the serial path.
        await Promise.all([
          createOpencodeServer(this, {
            port: OPENCODE_PORT,
            directory: WORKSPACE_DIRECTORY,
            config: OPENCODE_CONFIG,
            env: OPENCODE_ENV
          }),
          deferredFetch ?? Promise.resolve()
        ]);
        timings.serverMs = since(serverStartedAt);
      });

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

  /**
   * Provision the instance's catalog repository below /workspace during wake.
   * The first wake clones; later wakes see the snapshot-restored checkout and
   * only run a best-effort fetch, never touching the working tree.
   *
   * Returns the fetch when there was already a checkout: it is deliberately not
   * awaited here so the caller can overlap it with starting the server.
   */
  private async ensureRepoProvisioned(): Promise<Promise<void> | undefined> {
    const identity = this.instanceIdentity;
    if (!identity) {
      return undefined;
    }
    const { repo, repoKey, directory } = this.requireCheckout();
    const checkout = await this.exists(`${directory}/.git`);
    if (checkout.exists) {
      // A restored checkout knows its own remote, so resuming one needs nothing
      // from the catalog. That is what keeps an instance created before the
      // catalog was dynamic — or one whose repository has since left it —
      // working exactly as it did.
      //
      // A fetch failure (offline remote, revoked key) must not block resuming
      // the already-restored workspace — and neither must its latency, so this
      // is handed back unawaited for the caller to overlap with the server
      // start. Nothing downstream reads the refs it updates.
      return this.exec(`git -C ${shellQuote(directory)} fetch origin --prune`, {
        timeout: REPO_FETCH_TIMEOUT_MS
      }).then(
        (fetched) => {
          if (!fetched.success) {
            console.warn(
              `Repo fetch failed for ${repoKey}: ${truncateOutput(fetched.stderr)}`
            );
          }
        },
        (error) => {
          // A timed-out or refused fetch is a warning, not a failed wake: the
          // checkout it was refreshing is already restored and usable.
          console.warn(`Repo fetch failed for ${repoKey}`, error);
        }
      );
    }

    if (!repo) {
      throw new Error(
        `Instance ${identity.id} has no checkout and no pinned repository for ${repoKey}; wake refused`
      );
    }
    const cloned = await this.exec(
      `git clone --depth 1 --branch ${shellQuote(repo.defaultBranch)} ${shellQuote(
        repo.cloneUrl
      )} ${shellQuote(directory)}`,
      { timeout: REPO_CLONE_TIMEOUT_MS }
    );
    if (!cloned.success) {
      throw new Error(
        `git clone failed for ${repoKey}: ${truncateOutput(cloned.stderr)}`
      );
    }
    return undefined;
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
        // The OpenCode server is still up here, so the whole conversation can be
        // read in one call. After the checkpoint it is unreachable until the
        // next wake, which is exactly what the mirror exists to avoid.
        await this.mirrorTranscript('idle-stop');
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
        await this.mirrorTranscript('force-stop');
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
    const [state, persistence, workspaceLost] = await Promise.all([
      this.getState(),
      this.getPersistenceStatus(),
      this.persistenceState.storage.get<WorkspaceLoss>(
        WORKSPACE_LOST_STORAGE_KEY
      )
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
      persistence,
      ...(workspaceLost ? { workspaceLost } : {}),
      ...(this.lastWake ? { lastWake: this.lastWake } : {}),
      ...(this.transcriptMirror ? { transcript: this.transcriptMirror } : {})
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
        parts: [{ type: 'text', text: input.text }]
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
      const response = await this.containerFetch(
        new Request(url.toString(), {
          headers: {
            accept: 'application/json',
            [RUNTIME_EPOCH_HEADER]: runtimeEpoch
          }
        }),
        OPENCODE_PORT
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
      const listing = await this.withControlPlaneAccess(() =>
        this.listFiles(target, { includeHidden: true })
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
      const result = await this.withControlPlaneAccess(() =>
        this.readFile(resolveWorkspacePath(directory, relative))
      );
      return buildWorkspaceFile({
        path: relative,
        content: result.content,
        ...(result.encoding ? { encoding: result.encoding } : {})
      });
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Read what the agent changed in the session's checkout.
   *
   * This is a git read and not an OpenCode one: the diff the user cares about is
   * the working tree, including edits an agent made through a shell rather than
   * through the edit tool. Untracked files are listed but not diffed — showing
   * their content would mean staging them, and a read must not move the index.
   */
  async readSessionChanges(runtimeEpoch: string): Promise<SessionChanges> {
    await this.lifecycleReady;
    this.assertCurrentRuntime(runtimeEpoch, 'Reading session changes');
    this.beginActiveOperation();
    try {
      const { repo, repoKey, directory, sessionId } = this.requireCheckout();
      const defaultBranch = await this.resolveDefaultBranch(directory, repo);
      const at = shellQuote(directory);
      const [branchOut, headOut, statusOut, diffOut, remoteOut] =
        await this.withControlPlaneAccess(() =>
          Promise.all([
            this.exec(`git -C ${at} rev-parse --abbrev-ref HEAD`),
            this.exec(`git -C ${at} log -1 --format='%H%x09%s'`),
            this.exec(`git -C ${at} status --porcelain=v1 -z`),
            this.exec(`git -C ${at} diff HEAD --no-color`),
            this.exec(`git -C ${at} branch --remotes --list 'origin/*'`)
          ])
        );
      if (!branchOut.success) {
        throw new Error(
          `git rev-parse failed: ${truncateOutput(branchOut.stderr)}`
        );
      }
      if (!statusOut.success) {
        throw new Error(
          `git status failed: ${truncateOutput(statusOut.stderr)}`
        );
      }

      const branch = branchOut.stdout.trim();
      const remoteBranches = new Set(
        remoteOut.success
          ? remoteOut.stdout
              .split('\n')
              .map((line) => line.trim().replace(/^origin\//, ''))
              .filter(Boolean)
          : []
      );
      const publishBranch = resolvePublishBranch({
        sessionId,
        currentBranch: branch,
        defaultBranch
      });
      return {
        observedAt: new Date().toISOString(),
        repoKey,
        branch,
        defaultBranch,
        onDefaultBranch: branch === defaultBranch,
        ...(headOut.success && headOut.stdout.trim()
          ? { head: parseHeadLine(headOut.stdout) }
          : {}),
        files: parseGitStatus(statusOut.stdout),
        // A diff that fails on a repository whose status read worked is an empty
        // diff as far as the user is concerned; the file list is the part that
        // must be right.
        ...limitDiff(diffOut.success ? diffOut.stdout : ''),
        unpushedCommits: await this.countUnpushedCommits(
          directory,
          branch,
          defaultBranch,
          remoteBranches.has(branch)
        ),
        publishBranch,
        ...(remoteBranches.has(publishBranch)
          ? { remoteBranch: publishBranch }
          : {})
      };
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * How far this branch is ahead of what the remote already has.
   *
   * A branch that has been pushed is measured against its own remote; one that
   * has not is measured against the default branch, because "5 commits nobody
   * else has" is the useful answer either way.
   */
  private async countUnpushedCommits(
    directory: string,
    branch: string,
    defaultBranch: string,
    hasRemoteBranch: boolean
  ): Promise<number> {
    const base = hasRemoteBranch ? branch : defaultBranch;
    const result = await this.withControlPlaneAccess(() =>
      this.exec(
        `git -C ${shellQuote(directory)} rev-list --count ${shellQuote(
          `origin/${base}..HEAD`
        )}`
      )
    );
    const count = Number.parseInt(result.stdout.trim(), 10);
    return result.success && Number.isFinite(count) ? count : 0;
  }

  /**
   * Commit the working tree onto the session branch, push it, and optionally
   * open a pull request.
   *
   * Every step is sequential and stops at the first failure, so a push that
   * cannot reach the remote leaves a real commit behind rather than an unclear
   * half-state — the commit is in the workspace snapshot and the next publish
   * pushes it.
   */
  async publishSessionChanges(
    runtimeEpoch: string,
    input: PublishSessionChangesInput
  ): Promise<PublishSessionChangesResult> {
    await this.lifecycleReady;
    this.assertCurrentRuntime(runtimeEpoch, 'Publishing session changes');
    const message = normalizeCommitMessage(input.message);
    if (!message) {
      throw new Error('A commit message of up to 4000 characters is required');
    }
    if (input.branch !== undefined && !isSafeBranchName(input.branch)) {
      throw new Error('Invalid branch name');
    }

    this.beginActiveOperation();
    try {
      const { repo, directory, sessionId } = this.requireCheckout();
      const defaultBranch = await this.resolveDefaultBranch(directory, repo);
      const at = shellQuote(directory);
      const current = await this.runGit(
        directory,
        'rev-parse --abbrev-ref HEAD',
        'read the current branch'
      );
      const branch = resolvePublishBranch({
        sessionId,
        currentBranch: current.trim(),
        defaultBranch,
        ...(input.branch === undefined ? {} : { requested: input.branch })
      });
      if (branch === defaultBranch) {
        throw new Error(
          `Publishing to the default branch (${defaultBranch}) is not supported; use a branch of its own`
        );
      }

      if (current.trim() !== branch) {
        // `switch -c` refuses an existing branch, which is the safe order: a
        // second publish reuses the branch instead of resetting it to HEAD.
        const created = await this.exec(
          `git -C ${at} switch -c ${shellQuote(branch)}`
        );
        if (!created.success) {
          await this.runGit(
            directory,
            `switch ${shellQuote(branch)}`,
            `switch to branch ${branch}`
          );
        }
      }

      await this.runGit(directory, 'add -A', 'stage the working tree');
      const staged = await this.withControlPlaneAccess(() =>
        this.exec(`git -C ${at} diff --cached --quiet`)
      );
      // `--quiet` exits non-zero when there *is* a difference, so a successful
      // run means the tree was already clean.
      const nothingToCommit = staged.success;
      if (!nothingToCommit) {
        await this.runGit(
          directory,
          `commit -m ${shellQuote(message)}`,
          'commit the working tree'
        );
      }

      const head = parseHeadLine(
        await this.runGit(
          directory,
          `log -1 --format='%H%x09%s'`,
          'read the new commit'
        )
      );
      await this.runGit(
        directory,
        `push --set-upstream origin ${shellQuote(branch)}`,
        `push ${branch}`
      );

      return {
        branch,
        ...(nothingToCommit ? {} : { commit: head }),
        pushed: true,
        nothingToCommit,
        ...(input.pullRequest
          ? await this.openPullRequest(directory, {
              branch,
              base: defaultBranch,
              title: input.pullRequest.title,
              ...(input.pullRequest.body === undefined
                ? {}
                : { body: input.pullRequest.body })
            })
          : {})
      };
    } finally {
      this.finishActiveOperation();
    }
  }

  /**
   * Open a pull request for a branch that was just pushed.
   *
   * An existing pull request is not an error: `gh` refuses to create a second
   * one and names the existing URL in the refusal, which is the answer the
   * caller wanted anyway.
   */
  private async openPullRequest(
    directory: string,
    input: { branch: string; base: string; title: string; body?: string }
  ): Promise<{ pullRequestUrl?: string }> {
    const result = await this.withControlPlaneAccess(() =>
      this.exec(
        [
          `cd ${shellQuote(directory)} &&`,
          'gh pr create',
          `--base ${shellQuote(input.base)}`,
          `--head ${shellQuote(input.branch)}`,
          `--title ${shellQuote(input.title)}`,
          `--body ${shellQuote(input.body ?? '')}`
        ].join(' '),
        { timeout: GH_COMMAND_TIMEOUT_MS }
      )
    );
    const url =
      parsePullRequestUrl(result.stdout) ?? parsePullRequestUrl(result.stderr);
    if (!result.success && !url) {
      throw new Error(
        `gh pr create failed: ${truncateOutput(result.stderr || result.stdout)}`
      );
    }
    return url ? { pullRequestUrl: url } : {};
  }

  /** Run one git command in a checkout, raising its stderr on failure. */
  private async runGit(
    directory: string,
    args: string,
    intent: string
  ): Promise<string> {
    const result = await this.withControlPlaneAccess(() =>
      this.exec(`git -C ${shellQuote(directory)} ${args}`, {
        timeout: GIT_COMMAND_TIMEOUT_MS
      })
    );
    if (!result.success) {
      throw new Error(
        `Failed to ${intent}: ${truncateOutput(result.stderr || result.stdout)}`
      );
    }
    return result.stdout;
  }

  /**
   * The checkout this instance owns.
   *
   * The directory comes from the key alone, so it is always known. The catalog
   * entry is only pinned on instances created since the catalog became dynamic,
   * and is only needed for the initial clone — everything afterwards asks the
   * checkout itself, which is both more available and more truthful.
   */
  private requireCheckout(): {
    repo?: RepoDefinition;
    repoKey: string;
    directory: string;
    sessionId: string;
  } {
    const identity = this.instanceIdentity;
    if (!identity) {
      throw new Error('This instance has no repository checkout');
    }
    return {
      ...(identity.repo ? { repo: identity.repo } : {}),
      repoKey: identity.repoKey,
      directory: repoWorkspaceDirectory(identity.repoKey),
      sessionId: identity.id
    };
  }

  /**
   * The branch this checkout treats as its trunk.
   *
   * Read from `origin/HEAD` rather than from the pinned catalog entry: the
   * remote's own answer is the correct one, it is available to instances that
   * predate pinning, and it stays right if the repository's default branch is
   * renamed. The pinned value is the fallback for a checkout whose `origin/HEAD`
   * was never set — a shallow clone that has not fetched since.
   */
  private async resolveDefaultBranch(
    directory: string,
    repo?: RepoDefinition
  ): Promise<string> {
    const result = await this.withControlPlaneAccess(() =>
      this.exec(
        `git -C ${shellQuote(directory)} symbolic-ref --short refs/remotes/origin/HEAD`
      )
    );
    const branch = result.stdout.trim().replace(/^origin\//, '');
    return (result.success && branch) || repo?.defaultBranch || 'main';
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
      this.persistenceState.container?.running !== true
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
    const container = this.persistenceState.container;
    if (container?.running !== true) {
      return;
    }
    const url = new URL(`http://localhost:${OPENCODE_PORT}/event`);
    url.searchParams.set('directory', target.directory);
    // Straight to the port, like the mirror client: this read outlives the
    // runtime gate's `running` phase by design, ending when the stream ends
    // rather than when the gate closes to outside requests.
    const response = await container.getTcpPort(OPENCODE_PORT).fetch(
      url.toString(),
      {
        headers: { accept: 'text/event-stream' },
        signal: subscription.abort.signal
      }
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
   * checkpoint. It stays honest by reading `this.persistenceState.container`
   * directly, which is by construction this object's current container.
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
      this.persistenceState.container?.running !== true
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
        void getHub(this.persistenceEnv)
          .updateSession(sessionId, { title: opencodeTitle })
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
      await putTranscriptMirror(this.persistenceEnv.BACKUP_BUCKET, mirror);

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
   * A failure returns the title already known rather than dropping it, because
   * losing a good title to a transient read would rename the session in the list.
   */
  private async readOpencodeTitle(
    target: TranscriptTarget
  ): Promise<string | undefined> {
    const known = this.transcriptMirror?.opencodeTitle;
    try {
      const result = await this.createTranscriptClient().session.get({
        sessionID: target.opencodeSessionId,
        directory: target.directory
      });
      const title = result.data?.title;
      return typeof title === 'string' && title.trim() ? title.trim() : known;
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
      fetch: (input, init) => {
        const container = this.persistenceState.container;
        if (container?.running !== true) {
          throw new Error('Mirroring requires a running container');
        }
        return container
          .getTcpPort(OPENCODE_PORT)
          .fetch(new Request(input, init));
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
      // WebSockets must cross the Durable Object fetch boundary rather than
      // JSRPC. Since the stock UI's gateway was retired this path carries
      // exactly one thing: the terminal's PTY socket, opened by the session
      // API through getSandbox(...).terminal().
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
    if (this.instanceIdentity?.id) {
      // The transcript mirror is R2 state this instance owns, so it goes with
      // the backups rather than outliving the session as an orphan.
      await deleteTranscriptMirror(
        this.persistenceEnv.BACKUP_BUCKET,
        this.instanceIdentity.id
      );
    }
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
        // Snapshot size is restore time, and restore time is the cold start.
        // Only caches are excluded: everything a session might have installed
        // or built stays, because re-creating it costs the user far more than
        // the seconds the smaller archive saves.
        excludes: CHECKPOINT_EXCLUDES,
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

/**
 * Split `git log -1 --format='%H<tab>%s'`. A subject may contain anything but a
 * newline, so only the first tab separates the two fields.
 */
function parseHeadLine(output: string): SessionChangesHead {
  const line = output.split('\n')[0] ?? '';
  const tab = line.indexOf('\t');
  return tab === -1
    ? { sha: line.trim(), subject: '' }
    : { sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() };
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
