import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import {
  CURRENT_IMAGE_KEY,
  LOGTO_IMAGE_KEY,
  isImageKey,
  type ImageKey,
  type RuntimeLifecycle
} from './instances';

/**
 * Semantic lifecycle policy for one OpenCode instance.
 *
 * This deliberately lives in a separate Durable Object from Sandbox. The
 * Sandbox SDK owns the container DO alarm and renews it for transport traffic;
 * keeping the policy alarm here means an SSE stream or WebSocket cannot move an
 * OpenCode execution deadline. The Worker must still enforce the runtime epoch
 * before forwarding a request to Sandbox.
 */

export const LIFECYCLE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const LIFECYCLE_BUSY_PROBE_INTERVAL_MS = 10 * 1000;
export const LIFECYCLE_IDLE_PROBE_INTERVAL_MS = 60 * 1000;
export const LIFECYCLE_IDLE_CONFIRM_INTERVAL_MS = 3 * 1000;
export const LIFECYCLE_DEFAULT_WORK_LEASE_MS = 90 * 1000;

const LIFECYCLE_STATE_KEY = 'lifecycle:state';
const LIFECYCLE_SCHEMA_VERSION = 1;
const REQUIRED_IDLE_CONFIRMATIONS = 2;
const MIN_WORK_LEASE_MS = 5 * 1000;
const MAX_WORK_LEASE_MS = 5 * 60 * 1000;
const OPERATION_RECOVERY_INTERVAL_MS = 30 * 1000;
const MAX_PROBE_BACKOFF_MS = 60 * 1000;

export interface ExecutionSnapshot {
  state: 'running' | 'not_running' | 'unknown';
  observedAt: string;
  active: boolean;
  activeSessionCount: number;
  retrySessionCount: number;
  locations: string[];
  error?: string;
}

export interface InitializeLifecycleInput {
  instanceId: string;
  imageKey: ImageKey;
  /** Used only while creating the coordinator record for a legacy instance. */
  containerRunning?: boolean;
}

export type LifecyclePhase =
  | 'sleeping'
  | 'waking'
  | 'running_unknown'
  | 'running_busy'
  | 'running_idle'
  | 'quiescing'
  | 'error_running'
  | 'error_waking'
  | 'deleting';

type LifecycleOperationType =
  | 'wake'
  | 'adopt'
  | 'idle-stop'
  | 'force-stop';

interface LifecycleOperation {
  id: string;
  type: LifecycleOperationType;
  startedAt: number;
}

interface WorkLease {
  id: string;
  runtimeEpoch: string;
  startedAt: number;
  expiresAt: number;
}

interface LifecycleError {
  at: number;
  operation: 'wake' | 'adopt' | 'probe' | 'idle-stop' | 'force-stop';
  message: string;
}

interface StoredLifecycleState {
  schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
  instanceId: string;
  imageKey: ImageKey;
  phase: LifecyclePhase;
  revision: number;
  runtimeEpoch?: string;
  idleCandidateSince?: number;
  idleConfirmations: number;
  idleSince?: number;
  idleDeadlineAt?: number;
  nextProbeAt?: number;
  lastSemanticWorkAt?: number;
  lastActivityProbeAt?: number;
  activeSessionCount: number;
  retrySessionCount: number;
  activityLocations: string[];
  consecutiveProbeFailures: number;
  workLeases: Record<string, WorkLease>;
  operation?: LifecycleOperation;
  wakeAfterStop: boolean;
  lastStoppedAt?: number;
  lastStopReason?: 'idle' | 'manual' | 'unexpected';
  lastError?: LifecycleError;
  updatedAt: number;
}

export interface LifecycleStatus {
  lifecycle: RuntimeLifecycle;
  phase: LifecyclePhase | 'uninitialized';
  admissionOpen: boolean;
  revision: number;
  runtimeEpoch?: string;
  idleSince?: string;
  idleDeadlineAt?: string;
  activeSessionCount?: number;
  retrySessionCount?: number;
  activeWorkLeaseCount: number;
  lastActivityProbeAt?: string;
  lastStoppedAt?: string;
  lastStopReason?: 'idle' | 'manual' | 'unexpected';
  lifecycleError?: string;
}

export type AdmissionResult =
  | {
      admitted: true;
      runtimeEpoch: string;
      revision: number;
    }
  | {
      admitted: false;
      reason:
        | 'uninitialized'
        | 'epoch_mismatch'
        | 'not_running'
        | 'quiescing'
        | 'deleting';
      phase: LifecyclePhase | 'uninitialized';
    };

export type BeginWorkResult =
  | {
      admitted: true;
      leaseId: string;
      expiresAt: string;
      revision: number;
    }
  | Extract<AdmissionResult, { admitted: false }>;

export interface LifecycleWakeResult {
  ready: boolean;
  pending: boolean;
  runtimeEpoch?: string;
  status: LifecycleStatus;
}

interface LifecycleSandboxRpc {
  adoptRunningForLifecycle(input: {
    instanceId: string;
    imageKey: ImageKey;
    runtimeEpoch: string;
  }): Promise<ExecutionSnapshot>;
  wakeForLifecycle(input: {
    instanceId: string;
    imageKey: ImageKey;
    runtimeEpoch: string;
  }): Promise<ExecutionSnapshot>;
  getExecutionSnapshotIfRunning(
    runtimeEpoch: string
  ): Promise<ExecutionSnapshot>;
  quiesceAndStopIfIdle(input: {
    runtimeEpoch: string;
    revision: number;
    operationId: string;
  }): Promise<
    | {
      outcome: 'stopped' | 'busy' | 'not_running';
      snapshot?: ExecutionSnapshot;
    }
    | { outcome: 'termination_pending'; snapshot?: ExecutionSnapshot }
    | { outcome: 'failed_running'; error: string }
  >;
  forceStopForLifecycle(input: {
    runtimeEpoch?: string;
    operationId: string;
  }): Promise<
    | { outcome: 'stopped' | 'termination_pending' }
    | { outcome: 'failed_running'; error: string }
  >;
}

export class LifecycleCoordinator extends DurableObject<Env> {
  private readonly lifecycleState: DurableObjectState<{}>;
  private readonly ready: Promise<void>;
  private state: StoredLifecycleState | undefined;
  private adoptionInProgress: Promise<void> | undefined;
  private wakeInProgress: Promise<LifecycleWakeResult> | undefined;
  private probeInProgress: Promise<void> | undefined;
  private stopInProgress: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.lifecycleState = ctx;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<StoredLifecycleState>(
        LIFECYCLE_STATE_KEY
      );
      if (
        this.state &&
        this.state.schemaVersion !== LIFECYCLE_SCHEMA_VERSION
      ) {
        throw new Error(
          `Unsupported lifecycle schema: ${String(this.state.schemaVersion)}`
        );
      }

      const alarm = await ctx.storage.getAlarm();
      if (this.state && needsAlarm(this.state) && alarm === null) {
        await ctx.storage.setAlarm(Date.now());
      } else if ((!this.state || !needsAlarm(this.state)) && alarm !== null) {
        await ctx.storage.deleteAlarm();
      }
    });
  }

  async initializeInstance(
    input: InitializeLifecycleInput
  ): Promise<LifecycleStatus> {
    await this.ready;
    if (!isImageKey(input.imageKey)) {
      throw new Error(`Unsupported image: ${String(input.imageKey)}`);
    }

    if (this.state) {
      if (
        this.state.instanceId !== input.instanceId ||
        this.state.imageKey !== input.imageKey
      ) {
        throw new Error('Lifecycle identity does not match the Hub record');
      }
      if (this.state.phase === 'deleting') {
        throw new Error('A deleting lifecycle cannot be initialized');
      }
      return this.toStatus();
    }

    const now = Date.now();
    const containerRunning = input.containerRunning === true;
    const runtimeEpoch = containerRunning ? newRuntimeEpoch() : undefined;
    this.state = {
      schemaVersion: LIFECYCLE_SCHEMA_VERSION,
      instanceId: input.instanceId,
      imageKey: input.imageKey,
      // A legacy running container has no matching Sandbox runtime gate yet.
      // Treat migration as a recoverable wake so Sandbox acknowledges the new
      // epoch before ordinary traffic can be admitted.
      phase: containerRunning ? 'waking' : 'sleeping',
      revision: 0,
      ...(runtimeEpoch ? { runtimeEpoch } : {}),
      idleConfirmations: 0,
      ...(containerRunning ? { nextProbeAt: now } : {}),
      activeSessionCount: 0,
      retrySessionCount: 0,
      activityLocations: [],
      consecutiveProbeFailures: 0,
      workLeases: {},
      ...(containerRunning
        ? {
            operation: {
              id: crypto.randomUUID(),
              type: 'adopt' as const,
              startedAt: now
            }
          }
        : {}),
      wakeAfterStop: false,
      updatedAt: now
    };
    await this.persistAndSchedule();
    if (containerRunning) {
      await this.continueAdoption();
    }
    return this.toStatus();
  }

  /**
   * Explicit user intent from the Hub. Merely calling admit(), fetching an
   * asset, or reconnecting an event stream can never reach this path.
   */
  async wake(): Promise<LifecycleWakeResult> {
    await this.ready;
    const state = this.requireState();
    if (state.phase === 'deleting') {
      throw new Error('A deleting instance cannot be woken');
    }

    if (isAdmissionPhase(state.phase) && state.runtimeEpoch) {
      return {
        ready: true,
        pending: false,
        runtimeEpoch: state.runtimeEpoch,
        status: this.toStatus()
      };
    }

    if (state.phase === 'quiescing') {
      this.state = {
        ...state,
        wakeAfterStop: true,
        updatedAt: Date.now()
      };
      await this.persistAndSchedule();
      return {
        ready: false,
        pending: true,
        status: this.toStatus()
      };
    }

    return this.continueWake(true);
  }

  /** Passive admission check. It intentionally has no timer side effects. */
  async admit(runtimeEpoch: string): Promise<AdmissionResult> {
    await this.ready;
    return this.admissionFor(runtimeEpoch);
  }

  /**
   * Fence a request which can start OpenCode work. This closes the short-task
   * polling hole: even if a task starts and ends between two status probes, the
   * lease invalidates the previous idle deadline and endWork() probes again.
   */
  async beginWork(
    runtimeEpoch: string,
    requestedTtlMs = LIFECYCLE_DEFAULT_WORK_LEASE_MS
  ): Promise<BeginWorkResult> {
    await this.ready;
    const admission = this.admissionFor(runtimeEpoch);
    if (!admission.admitted) {
      return admission;
    }

    const now = Date.now();
    const ttlMs = normalizeLeaseTtl(requestedTtlMs);
    const lease: WorkLease = {
      id: crypto.randomUUID(),
      runtimeEpoch,
      startedAt: now,
      expiresAt: now + ttlMs
    };
    const state = this.requireState();
    this.state = {
      ...clearIdleWindow(state),
      phase: 'running_busy',
      revision: state.revision + 1,
      lastSemanticWorkAt: now,
      nextProbeAt: Math.min(
        state.nextProbeAt ?? now + LIFECYCLE_BUSY_PROBE_INTERVAL_MS,
        now + LIFECYCLE_BUSY_PROBE_INTERVAL_MS
      ),
      workLeases: { ...state.workLeases, [lease.id]: lease },
      updatedAt: now
    };
    await this.persistAndSchedule();
    return {
      admitted: true,
      leaseId: lease.id,
      expiresAt: toIso(lease.expiresAt),
      revision: this.state.revision
    };
  }

  async renewWork(
    runtimeEpoch: string,
    leaseId: string,
    requestedTtlMs = LIFECYCLE_DEFAULT_WORK_LEASE_MS
  ): Promise<boolean> {
    await this.ready;
    const state = this.state;
    const lease = state?.workLeases[leaseId];
    if (
      !state ||
      !lease ||
      lease.runtimeEpoch !== runtimeEpoch ||
      state.runtimeEpoch !== runtimeEpoch ||
      !isAdmissionPhase(state.phase)
    ) {
      return false;
    }

    const now = Date.now();
    const expiresAt = now + normalizeLeaseTtl(requestedTtlMs);
    this.state = {
      ...state,
      workLeases: {
        ...state.workLeases,
        [leaseId]: { ...lease, expiresAt }
      },
      updatedAt: now
    };
    await this.persistAndSchedule();
    return true;
  }

  async endWork(runtimeEpoch: string, leaseId: string): Promise<void> {
    await this.ready;
    const state = this.state;
    const lease = state?.workLeases[leaseId];
    if (
      !state ||
      !lease ||
      lease.runtimeEpoch !== runtimeEpoch ||
      state.runtimeEpoch !== runtimeEpoch
    ) {
      return;
    }

    const now = Date.now();
    const workLeases = { ...state.workLeases };
    delete workLeases[leaseId];
    this.state = {
      ...clearIdleWindow(state),
      phase:
        Object.keys(workLeases).length > 0
          ? 'running_busy'
          : 'running_unknown',
      revision: state.revision + 1,
      lastSemanticWorkAt: now,
      nextProbeAt: now,
      workLeases,
      updatedAt: now
    };
    await this.persistAndSchedule();
  }

  /** Optional event fast path; periodic probes remain authoritative. */
  async observeExecution(
    runtimeEpoch: string,
    snapshot: ExecutionSnapshot
  ): Promise<LifecycleStatus> {
    await this.ready;
    const state = this.requireState();
    if (
      state.runtimeEpoch !== runtimeEpoch ||
      !isAdmissionPhase(state.phase)
    ) {
      return this.toStatus();
    }

    const observedAt = parseObservedAt(snapshot.observedAt);
    if (
      snapshot.state === 'running' &&
      snapshot.active === false &&
      state.lastSemanticWorkAt !== undefined &&
      observedAt < state.lastSemanticWorkAt
    ) {
      return this.toStatus();
    }

    this.applyExecutionSnapshot(snapshot, Date.now());
    await this.persistAndSchedule();
    return this.toStatus();
  }

  async reconcileNow(): Promise<LifecycleStatus> {
    await this.ready;
    if (this.state && isProbePhase(this.state.phase)) {
      await this.runProbe();
    }
    return this.toStatus();
  }

  /** Manual checkpoint-and-stop. Unlike idle stop, it does not require idle. */
  async forceStop(): Promise<void> {
    await this.ready;
    const state = this.requireState();
    if (state.phase === 'sleeping') {
      return;
    }
    if (state.phase === 'deleting') {
      throw new Error('A deleting instance cannot be stopped');
    }
    if (state.phase === 'quiescing') {
      if (this.stopInProgress) {
        await this.stopInProgress;
      }
      return;
    }

    const now = Date.now();
    const operation: LifecycleOperation = {
      id: crypto.randomUUID(),
      type: 'force-stop',
      startedAt: now
    };
    this.state = {
      ...clearIdleWindow(state),
      phase: 'quiescing',
      revision: state.revision + 1,
      nextProbeAt: now + OPERATION_RECOVERY_INTERVAL_MS,
      workLeases: {},
      operation,
      wakeAfterStop: false,
      updatedAt: now
    };
    await this.persistAndSchedule();
    await this.continueStop();
  }

  async beginDelete(): Promise<void> {
    await this.ready;
    const state = this.state;
    if (!state) {
      return;
    }
    this.state = {
      ...clearIdleWindow(state),
      phase: 'deleting',
      revision: state.revision + 1,
      runtimeEpoch: undefined,
      nextProbeAt: undefined,
      workLeases: {},
      operation: undefined,
      wakeAfterStop: false,
      updatedAt: Date.now()
    };
    await this.persistAndSchedule();
  }

  async markDeleted(): Promise<void> {
    await this.ready;
    this.state = undefined;
    await this.lifecycleState.storage.deleteAlarm();
    await this.lifecycleState.storage.deleteAll();
  }

  async getLifecycleStatus(): Promise<LifecycleStatus> {
    await this.ready;
    return this.toStatus();
  }

  override async alarm(): Promise<void> {
    await this.ready;
    const state = this.state;
    if (!state || state.phase === 'sleeping' || state.phase === 'deleting') {
      await this.lifecycleState.storage.deleteAlarm();
      return;
    }

    try {
      if (state.phase === 'waking' || state.phase === 'error_waking') {
        if (state.operation?.type === 'adopt') {
          await this.continueAdoption();
        } else {
          await this.continueWake(false);
        }
        return;
      }
      if (state.phase === 'quiescing') {
        await this.continueStop();
        return;
      }

      const now = Date.now();
      const expired = this.removeExpiredLeases(now);
      if (expired) {
        await this.persistAndSchedule();
      }
      const current = this.state;
      if (!current || !isProbePhase(current.phase)) {
        await this.persistAndSchedule();
        return;
      }

      if (
        current.phase === 'running_idle' &&
        current.idleDeadlineAt !== undefined &&
        now >= current.idleDeadlineAt &&
        activeLeaseCount(current, now) === 0
      ) {
        await this.beginIdleStop(now);
        return;
      }

      if (current.nextProbeAt === undefined || now >= current.nextProbeAt) {
        await this.runProbe();
      } else {
        await this.persistAndSchedule();
      }
    } catch (error) {
      console.error('Lifecycle alarm failed', {
        instanceId: this.state?.instanceId,
        phase: this.state?.phase,
        error: errorMessage(error)
      });
      await this.persistAndSchedule().catch(() => undefined);
    }
  }

  private async continueAdoption(): Promise<void> {
    if (!this.adoptionInProgress) {
      this.adoptionInProgress = this.performAdoption().finally(() => {
        this.adoptionInProgress = undefined;
      });
    }
    return this.adoptionInProgress;
  }

  private async performAdoption(): Promise<void> {
    let state = this.requireState();
    const operation = state.operation;
    const runtimeEpoch = state.runtimeEpoch;
    if (
      (state.phase !== 'waking' && state.phase !== 'error_waking') ||
      operation?.type !== 'adopt' ||
      !runtimeEpoch
    ) {
      return;
    }

    if (state.phase === 'error_waking') {
      this.state = {
        ...state,
        phase: 'waking',
        nextProbeAt: Date.now() + OPERATION_RECOVERY_INTERVAL_MS,
        updatedAt: Date.now()
      };
      await this.persistAndSchedule();
      state = this.requireState();
    }

    try {
      const snapshot =
        await this.resolveSandbox().adoptRunningForLifecycle({
          instanceId: state.instanceId,
          imageKey: state.imageKey,
          runtimeEpoch
        });
      state = this.requireState();
      if (
        state.phase !== 'waking' ||
        state.operation?.id !== operation.id ||
        state.operation.type !== 'adopt' ||
        state.runtimeEpoch !== runtimeEpoch
      ) {
        return;
      }
      if (snapshot.state === 'not_running') {
        this.state = toSleepingState(state, Date.now(), 'unexpected');
        await this.persistAndSchedule();
        return;
      }
      this.state = {
        ...state,
        phase: 'running_unknown',
        operation: undefined,
        nextProbeAt: Date.now(),
        consecutiveProbeFailures: 0,
        lastError: undefined,
        updatedAt: Date.now()
      };
      this.applyExecutionSnapshot(snapshot, Date.now());
      await this.persistAndSchedule();
    } catch (error) {
      state = this.requireState();
      if (
        state.phase !== 'waking' ||
        state.operation?.id !== operation.id ||
        state.operation.type !== 'adopt' ||
        state.runtimeEpoch !== runtimeEpoch
      ) {
        return;
      }
      const failures = state.consecutiveProbeFailures + 1;
      this.state = {
        ...state,
        phase: 'error_waking',
        consecutiveProbeFailures: failures,
        nextProbeAt: Date.now() + retryBackoff(failures),
        lastError: lifecycleError('adopt', error),
        updatedAt: Date.now()
      };
      await this.persistAndSchedule();
      console.warn('Failed to adopt running OpenCode container', {
        instanceId: state.instanceId,
        runtimeEpoch,
        error: errorMessage(error)
      });
    }
  }

  private async continueWake(
    explicitIntent: boolean
  ): Promise<LifecycleWakeResult> {
    if (!this.wakeInProgress) {
      this.wakeInProgress = this.performWake(explicitIntent).finally(() => {
        this.wakeInProgress = undefined;
      });
    }
    return this.wakeInProgress;
  }

  private async performWake(
    explicitIntent: boolean
  ): Promise<LifecycleWakeResult> {
    let state = this.requireState();
    if (state.phase === 'deleting') {
      throw new Error('A deleting instance cannot be woken');
    }

    if (isAdmissionPhase(state.phase) && state.runtimeEpoch) {
      return {
        ready: true,
        pending: false,
        runtimeEpoch: state.runtimeEpoch,
        status: this.toStatus()
      };
    }

    if (
      state.phase !== 'waking' &&
      state.phase !== 'error_waking' &&
      state.phase !== 'sleeping' &&
      state.phase !== 'error_running'
    ) {
      return {
        ready: false,
        pending: true,
        status: this.toStatus()
      };
    }

    const now = Date.now();
    const continueExisting =
      !explicitIntent &&
      (state.phase === 'waking' || state.phase === 'error_waking') &&
      state.runtimeEpoch &&
      state.operation?.type === 'wake';
    const runtimeEpoch = continueExisting
      ? state.runtimeEpoch!
      : newRuntimeEpoch();
    const operation = continueExisting
      ? state.operation!
      : {
          id: crypto.randomUUID(),
          type: 'wake' as const,
          startedAt: now
        };
    const revision = continueExisting ? state.revision : state.revision + 1;

    this.state = {
      ...clearIdleWindow(state),
      phase: 'waking',
      revision,
      runtimeEpoch,
      nextProbeAt: now + OPERATION_RECOVERY_INTERVAL_MS,
      activeSessionCount: 0,
      retrySessionCount: 0,
      activityLocations: [],
      workLeases: {},
      operation,
      wakeAfterStop: false,
      lastError: undefined,
      updatedAt: now
    };
    await this.persistAndSchedule();

    try {
      const snapshot = await this.resolveSandbox().wakeForLifecycle({
        instanceId: this.state.instanceId,
        imageKey: this.state.imageKey,
        runtimeEpoch
      });
      state = this.requireState();
      if (
        state.phase !== 'waking' ||
        state.operation?.id !== operation.id ||
        state.runtimeEpoch !== runtimeEpoch
      ) {
        return {
          ready: false,
          pending: state.phase !== 'deleting',
          status: this.toStatus()
        };
      }
      if (snapshot.state === 'not_running') {
        throw new Error(
          snapshot.error ?? 'Sandbox did not become running after wake'
        );
      }

      this.state = {
        ...state,
        phase: 'running_unknown',
        operation: undefined,
        nextProbeAt: Date.now(),
        consecutiveProbeFailures: 0,
        updatedAt: Date.now()
      };
      this.applyExecutionSnapshot(snapshot, Date.now());
      await this.persistAndSchedule();
      return {
        ready: true,
        pending: false,
        runtimeEpoch,
        status: this.toStatus()
      };
    } catch (error) {
      state = this.requireState();
      if (
        state.phase === 'waking' &&
        state.operation?.id === operation.id &&
        state.runtimeEpoch === runtimeEpoch
      ) {
        const failures = state.consecutiveProbeFailures + 1;
        this.state = {
          ...state,
          phase: 'error_waking',
          consecutiveProbeFailures: failures,
          nextProbeAt: Date.now() + retryBackoff(failures),
          lastError: lifecycleError('wake', error),
          updatedAt: Date.now()
        };
        await this.persistAndSchedule();
      }
      throw error;
    }
  }

  private async runProbe(): Promise<void> {
    if (!this.probeInProgress) {
      this.probeInProgress = this.performProbe().finally(() => {
        this.probeInProgress = undefined;
      });
    }
    return this.probeInProgress;
  }

  private async performProbe(): Promise<void> {
    let state = this.state;
    if (!state || !isProbePhase(state.phase) || !state.runtimeEpoch) {
      return;
    }

    const now = Date.now();
    if (this.removeExpiredLeases(now)) {
      await this.persistAndSchedule();
    }
    state = this.requireState();
    if (!isProbePhase(state.phase) || !state.runtimeEpoch) {
      return;
    }
    const revision = state.revision;
    const runtimeEpoch = state.runtimeEpoch;

    try {
      const snapshot =
        await this.resolveSandbox().getExecutionSnapshotIfRunning(
          runtimeEpoch
        );
      state = this.requireState();
      if (
        state.revision !== revision ||
        state.runtimeEpoch !== runtimeEpoch ||
        !isProbePhase(state.phase)
      ) {
        await this.persistAndSchedule();
        return;
      }
      this.applyExecutionSnapshot(snapshot, Date.now());
      await this.persistAndSchedule();
    } catch (error) {
      state = this.requireState();
      if (
        state.revision !== revision ||
        state.runtimeEpoch !== runtimeEpoch ||
        !isProbePhase(state.phase)
      ) {
        return;
      }
      this.applyUnknownActivity(error, Date.now());
      await this.persistAndSchedule();
    }
  }

  private applyExecutionSnapshot(
    snapshot: ExecutionSnapshot,
    now: number
  ): void {
    const state = this.requireState();
    const observedAt = parseObservedAt(snapshot.observedAt, now);
    if (snapshot.state === 'not_running') {
      this.state = toSleepingState(state, now, 'unexpected', {
        at: now,
        operation: 'probe',
        message: 'Container stopped outside the semantic lifecycle policy'
      });
      return;
    }
    if (snapshot.state === 'unknown') {
      this.applyUnknownActivity(
        snapshot.error ?? 'OpenCode activity is unknown',
        now
      );
      return;
    }

    const common = {
      lastActivityProbeAt: observedAt,
      activeSessionCount: snapshot.activeSessionCount,
      retrySessionCount: snapshot.retrySessionCount,
      activityLocations: [...snapshot.locations],
      consecutiveProbeFailures: 0,
      lastError: undefined,
      operation: undefined,
      updatedAt: now
    };
    const leases = activeLeaseCount(state, now);
    if (snapshot.active || leases > 0) {
      const invalidatesIdle =
        state.idleCandidateSince !== undefined ||
        state.idleDeadlineAt !== undefined ||
        state.phase !== 'running_busy';
      this.state = {
        ...clearIdleWindow(state),
        ...common,
        phase: 'running_busy',
        revision: invalidatesIdle ? state.revision + 1 : state.revision,
        nextProbeAt: now + LIFECYCLE_BUSY_PROBE_INTERVAL_MS
      };
      return;
    }

    if (
      state.lastSemanticWorkAt !== undefined &&
      observedAt < state.lastSemanticWorkAt
    ) {
      this.state = {
        ...clearIdleWindow(state),
        ...common,
        phase: 'running_unknown',
        nextProbeAt: now + LIFECYCLE_IDLE_CONFIRM_INTERVAL_MS
      };
      return;
    }

    if (
      state.phase === 'running_idle' &&
      state.idleSince !== undefined &&
      state.idleDeadlineAt !== undefined
    ) {
      this.state = {
        ...state,
        ...common,
        nextProbeAt: now + LIFECYCLE_IDLE_PROBE_INTERVAL_MS
      };
      return;
    }

    const idleCandidateSince = state.idleCandidateSince ?? observedAt;
    const idleConfirmations = state.idleCandidateSince
      ? state.idleConfirmations + 1
      : 1;
    if (idleConfirmations >= REQUIRED_IDLE_CONFIRMATIONS) {
      this.state = {
        ...state,
        ...common,
        phase: 'running_idle',
        idleCandidateSince,
        idleConfirmations,
        idleSince: idleCandidateSince,
        idleDeadlineAt:
          idleCandidateSince + LIFECYCLE_IDLE_TIMEOUT_MS,
        nextProbeAt: now + LIFECYCLE_IDLE_PROBE_INTERVAL_MS
      };
      return;
    }

    this.state = {
      ...state,
      ...common,
      phase: 'running_unknown',
      idleCandidateSince,
      idleConfirmations,
      idleSince: undefined,
      idleDeadlineAt: undefined,
      nextProbeAt: now + LIFECYCLE_IDLE_CONFIRM_INTERVAL_MS
    };
  }

  private applyUnknownActivity(error: unknown, now: number): void {
    const state = this.requireState();
    const failures = state.consecutiveProbeFailures + 1;
    const invalidatesIdle =
      state.idleCandidateSince !== undefined ||
      state.idleDeadlineAt !== undefined ||
      state.phase !== 'error_running';
    this.state = {
      ...clearIdleWindow(state),
      phase: 'error_running',
      revision: invalidatesIdle ? state.revision + 1 : state.revision,
      consecutiveProbeFailures: failures,
      nextProbeAt: now + retryBackoff(failures),
      lastError: lifecycleError('probe', error),
      updatedAt: now
    };
  }

  private async beginIdleStop(now: number): Promise<void> {
    const state = this.requireState();
    if (
      state.phase !== 'running_idle' ||
      !state.runtimeEpoch ||
      activeLeaseCount(state, now) > 0
    ) {
      await this.persistAndSchedule();
      return;
    }
    const operation: LifecycleOperation = {
      id: crypto.randomUUID(),
      type: 'idle-stop',
      startedAt: now
    };
    this.state = {
      ...state,
      phase: 'quiescing',
      nextProbeAt: now + OPERATION_RECOVERY_INTERVAL_MS,
      operation,
      wakeAfterStop: false,
      updatedAt: now
    };
    await this.persistAndSchedule();
    await this.continueStop();
  }

  private async continueStop(): Promise<void> {
    if (!this.stopInProgress) {
      this.stopInProgress = this.performStop().finally(() => {
        this.stopInProgress = undefined;
      });
    }
    return this.stopInProgress;
  }

  private async performStop(): Promise<void> {
    let state = this.requireState();
    if (state.phase !== 'quiescing' || !state.operation) {
      return;
    }
    const operation = state.operation;
    const runtimeEpoch = state.runtimeEpoch;
    const revision = state.revision;

    try {
      if (operation.type === 'force-stop') {
        const result = await this.resolveSandbox().forceStopForLifecycle({
          runtimeEpoch,
          operationId: operation.id
        });
        state = this.requireState();
        if (
          state.phase !== 'quiescing' ||
          state.operation?.id !== operation.id
        ) {
          return;
        }
        if (result.outcome === 'termination_pending') {
          this.state = {
            ...state,
            // The stop signal has been sent, but the control plane has not
            // confirmed termination yet. Keep admission closed and retry this
            // exact operation from the next alarm.
            phase: 'quiescing',
            nextProbeAt: Date.now() + OPERATION_RECOVERY_INTERVAL_MS,
            lastError: lifecycleError(
              'force-stop',
              'Container termination is still pending'
            ),
            updatedAt: Date.now()
          };
          await this.persistAndSchedule();
          return;
        }
        if (result.outcome === 'failed_running') {
          this.state = {
            ...clearIdleWindow(state),
            phase: 'error_running',
            revision: state.revision + 1,
            operation: undefined,
            wakeAfterStop: false,
            nextProbeAt: Date.now() + retryBackoff(1),
            consecutiveProbeFailures: 1,
            lastError: lifecycleError('force-stop', result.error),
            updatedAt: Date.now()
          };
          await this.persistAndSchedule();
          return;
        }
        const wakeAfterStop = state.wakeAfterStop;
        this.state = toSleepingState(state, Date.now(), 'manual');
        await this.persistAndSchedule();
        if (wakeAfterStop) {
          await this.continueWake(true);
        }
        return;
      }

      if (!runtimeEpoch) {
        throw new Error('Idle stop has no runtime epoch');
      }
      const result = await this.resolveSandbox().quiesceAndStopIfIdle({
        runtimeEpoch,
        revision,
        operationId: operation.id
      });
      state = this.requireState();
      if (
        state.phase !== 'quiescing' ||
        state.operation?.id !== operation.id
      ) {
        return;
      }
      if (result.outcome === 'termination_pending') {
        this.state = {
          ...state,
          // Do not reopen the old epoch while physical termination is
          // uncertain. The Sandbox gate and operation id make this replayable.
          phase: 'quiescing',
          nextProbeAt: Date.now() + OPERATION_RECOVERY_INTERVAL_MS,
          lastError: lifecycleError(
            'idle-stop',
            'Container termination is still pending'
          ),
          updatedAt: Date.now()
        };
        await this.persistAndSchedule();
        return;
      }
      if (result.outcome === 'failed_running') {
        this.state = {
          ...clearIdleWindow(state),
          phase: 'error_running',
          revision: state.revision + 1,
          operation: undefined,
          wakeAfterStop: false,
          nextProbeAt: Date.now() + retryBackoff(1),
          consecutiveProbeFailures: 1,
          lastError: lifecycleError('idle-stop', result.error),
          updatedAt: Date.now()
        };
        await this.persistAndSchedule();
        return;
      }
      if (result.outcome === 'busy') {
        this.state = {
          ...clearIdleWindow(state),
          phase: 'running_unknown',
          revision: state.revision + 1,
          operation: undefined,
          wakeAfterStop: false,
          nextProbeAt: Date.now(),
          updatedAt: Date.now()
        };
        if (result.snapshot) {
          this.applyExecutionSnapshot(result.snapshot, Date.now());
        }
        await this.persistAndSchedule();
        return;
      }

      const wakeAfterStop = state.wakeAfterStop;
      this.state = toSleepingState(state, Date.now(), 'idle');
      await this.persistAndSchedule();
      if (wakeAfterStop) {
        await this.continueWake(true);
      }
    } catch (error) {
      state = this.requireState();
      if (
        state.phase !== 'quiescing' ||
        state.operation?.id !== operation.id
      ) {
        return;
      }
      const errorOperation =
        operation.type === 'force-stop' ? 'force-stop' : 'idle-stop';
      const failures = state.consecutiveProbeFailures + 1;
      this.state = {
        ...clearIdleWindow(state),
        // Keep the operation id and admission closed. The Sandbox persists its
        // own quiescing/checkpointing/stopping gate, so the next alarm can
        // resume that exact operation after an RPC or deployment interruption.
        phase: 'quiescing',
        nextProbeAt: Date.now() + retryBackoff(failures),
        consecutiveProbeFailures: failures,
        lastError: lifecycleError(errorOperation, error),
        updatedAt: Date.now()
      };
      await this.persistAndSchedule();
      throw error;
    }
  }

  private removeExpiredLeases(now: number): boolean {
    const state = this.state;
    if (!state) {
      return false;
    }
    const workLeases = Object.fromEntries(
      Object.entries(state.workLeases).filter(([, lease]) =>
        isActiveLease(lease, state.runtimeEpoch, now)
      )
    );
    if (Object.keys(workLeases).length === Object.keys(state.workLeases).length) {
      return false;
    }

    this.state = {
      ...clearIdleWindow(state),
      phase: isAdmissionPhase(state.phase) ? 'running_unknown' : state.phase,
      revision: state.revision + 1,
      lastSemanticWorkAt: now,
      nextProbeAt: now,
      workLeases,
      updatedAt: now
    };
    return true;
  }

  private admissionFor(runtimeEpoch: string): AdmissionResult {
    const state = this.state;
    if (!state) {
      return {
        admitted: false,
        reason: 'uninitialized',
        phase: 'uninitialized'
      };
    }
    if (state.phase === 'deleting') {
      return { admitted: false, reason: 'deleting', phase: state.phase };
    }
    if (state.phase === 'quiescing') {
      return { admitted: false, reason: 'quiescing', phase: state.phase };
    }
    if (!isAdmissionPhase(state.phase) || !state.runtimeEpoch) {
      return { admitted: false, reason: 'not_running', phase: state.phase };
    }
    if (state.runtimeEpoch !== runtimeEpoch) {
      return {
        admitted: false,
        reason: 'epoch_mismatch',
        phase: state.phase
      };
    }
    return {
      admitted: true,
      runtimeEpoch,
      revision: state.revision
    };
  }

  private requireState(): StoredLifecycleState {
    if (!this.state) {
      throw new Error('Lifecycle is not initialized');
    }
    return this.state;
  }

  private resolveSandbox(): LifecycleSandboxRpc {
    const state = this.requireState();
    switch (state.imageKey) {
      case CURRENT_IMAGE_KEY:
        return getSandbox(this.env.Sandbox, state.instanceId, {
          normalizeId: true,
          keepAlive: true
        }) as unknown as LifecycleSandboxRpc;
      case LOGTO_IMAGE_KEY:
        return getSandbox(this.env.LogtoSandbox, state.instanceId, {
          normalizeId: true,
          keepAlive: true
        }) as unknown as LifecycleSandboxRpc;
      default:
        throw new Error(`Unsupported image: ${String(state.imageKey)}`);
    }
  }

  private toStatus(): LifecycleStatus {
    const state = this.state;
    if (!state) {
      return {
        lifecycle: 'sleeping',
        phase: 'uninitialized',
        admissionOpen: false,
        revision: 0,
        activeWorkLeaseCount: 0
      };
    }
    const now = Date.now();
    return {
      lifecycle: publicLifecycle(state.phase),
      phase: state.phase,
      admissionOpen: isAdmissionPhase(state.phase),
      revision: state.revision,
      ...(state.runtimeEpoch ? { runtimeEpoch: state.runtimeEpoch } : {}),
      ...(state.idleSince !== undefined
        ? { idleSince: toIso(state.idleSince) }
        : {}),
      ...(state.idleDeadlineAt !== undefined
        ? { idleDeadlineAt: toIso(state.idleDeadlineAt) }
        : {}),
      ...(isAdmissionPhase(state.phase)
        ? {
            activeSessionCount: state.activeSessionCount,
            retrySessionCount: state.retrySessionCount
          }
        : {}),
      activeWorkLeaseCount: activeLeaseCount(state, now),
      ...(state.lastActivityProbeAt !== undefined
        ? { lastActivityProbeAt: toIso(state.lastActivityProbeAt) }
        : {}),
      ...(state.lastStoppedAt !== undefined
        ? { lastStoppedAt: toIso(state.lastStoppedAt) }
        : {}),
      ...(state.lastStopReason
        ? { lastStopReason: state.lastStopReason }
        : {}),
      ...(state.lastError ? { lifecycleError: state.lastError.message } : {})
    };
  }

  private async persistAndSchedule(): Promise<void> {
    const state = this.state;
    if (!state) {
      await this.lifecycleState.storage.deleteAlarm();
      return;
    }
    await this.lifecycleState.storage.put(LIFECYCLE_STATE_KEY, state);
    const alarmAt = nextAlarmAt(state, Date.now());
    if (alarmAt === undefined) {
      await this.lifecycleState.storage.deleteAlarm();
    } else {
      await this.lifecycleState.storage.setAlarm(alarmAt);
    }
  }
}

function isAdmissionPhase(phase: LifecyclePhase): boolean {
  return (
    phase === 'running_unknown' ||
    phase === 'running_busy' ||
    phase === 'running_idle' ||
    phase === 'error_running'
  );
}

function isProbePhase(phase: LifecyclePhase): boolean {
  return isAdmissionPhase(phase);
}

function needsAlarm(state: StoredLifecycleState): boolean {
  return state.phase !== 'sleeping' && state.phase !== 'deleting';
}

function nextAlarmAt(
  state: StoredLifecycleState,
  now: number
): number | undefined {
  if (!needsAlarm(state)) {
    return undefined;
  }
  const candidates: number[] = [];
  if (state.nextProbeAt !== undefined) {
    candidates.push(state.nextProbeAt);
  }
  if (state.phase === 'running_idle' && state.idleDeadlineAt !== undefined) {
    candidates.push(state.idleDeadlineAt);
  }
  for (const lease of Object.values(state.workLeases)) {
    if (isActiveLease(lease, state.runtimeEpoch, now)) {
      candidates.push(lease.expiresAt);
    }
  }
  return candidates.length > 0
    ? Math.max(now, Math.min(...candidates))
    : now + OPERATION_RECOVERY_INTERVAL_MS;
}

function clearIdleWindow(state: StoredLifecycleState): StoredLifecycleState {
  return {
    ...state,
    idleCandidateSince: undefined,
    idleConfirmations: 0,
    idleSince: undefined,
    idleDeadlineAt: undefined
  };
}

function toSleepingState(
  state: StoredLifecycleState,
  now: number,
  reason: 'idle' | 'manual' | 'unexpected',
  lastError?: LifecycleError
): StoredLifecycleState {
  return {
    ...clearIdleWindow(state),
    phase: 'sleeping',
    revision: state.revision + 1,
    runtimeEpoch: undefined,
    nextProbeAt: undefined,
    activeSessionCount: 0,
    retrySessionCount: 0,
    activityLocations: [],
    consecutiveProbeFailures: 0,
    workLeases: {},
    operation: undefined,
    wakeAfterStop: false,
    lastStoppedAt: now,
    lastStopReason: reason,
    lastError,
    updatedAt: now
  };
}

function activeLeaseCount(state: StoredLifecycleState, now: number): number {
  return Object.values(state.workLeases).filter((lease) =>
    isActiveLease(lease, state.runtimeEpoch, now)
  ).length;
}

function isActiveLease(
  lease: WorkLease,
  runtimeEpoch: string | undefined,
  now: number
): boolean {
  return lease.runtimeEpoch === runtimeEpoch && lease.expiresAt > now;
}

function normalizeLeaseTtl(value: number): number {
  if (!Number.isFinite(value)) {
    return LIFECYCLE_DEFAULT_WORK_LEASE_MS;
  }
  return Math.min(MAX_WORK_LEASE_MS, Math.max(MIN_WORK_LEASE_MS, value));
}

function retryBackoff(failures: number): number {
  return Math.min(
    MAX_PROBE_BACKOFF_MS,
    LIFECYCLE_BUSY_PROBE_INTERVAL_MS * 2 ** Math.min(3, failures - 1)
  );
}

function lifecycleError(
  operation: LifecycleError['operation'],
  error: unknown
): LifecycleError {
  return {
    at: Date.now(),
    operation,
    message: errorMessage(error)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newRuntimeEpoch(): string {
  return crypto.randomUUID();
}

function parseObservedAt(value: string, fallback = Date.now()): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.min(parsed, fallback) : fallback;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function publicLifecycle(phase: LifecyclePhase): RuntimeLifecycle {
  switch (phase) {
    case 'sleeping':
      return 'sleeping';
    case 'waking':
    case 'error_waking':
      return phase === 'waking' ? 'waking' : 'error';
    case 'running_busy':
      return 'busy';
    case 'running_idle':
      return 'idle';
    case 'running_unknown':
    case 'error_running':
      return phase === 'running_unknown' ? 'busy' : 'error';
    case 'quiescing':
      return 'quiescing';
    case 'deleting':
      return 'stopping';
  }
}
