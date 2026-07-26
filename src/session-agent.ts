/**
 * Per-session dispatch agent.
 *
 * One SessionAgent Durable Object per session owns the "start working"
 * sequence: wake the sandbox (which restores the workspace and provisions the
 * repository), create the OpenCode session on first use, then hand every queued
 * prompt to `session.promptAsync`. `promptAsync` returns as soon as the
 * container has accepted the task, so no Worker or Durable Object holds a
 * connection for the lifetime of an agent run.
 *
 * This object deliberately holds no runtime lifecycle policy. It only calls the
 * LifecycleCoordinator's explicit wake path, and takes a short work lease so a
 * task that starts between two activity probes still resets the idle window.
 */
import { DurableObject } from 'cloudflare:workers';
import { HUB_DURABLE_OBJECT_ID } from './instances';
import {
  resolveInstanceLifecycle,
  resolveInstanceSandbox,
  wakeInstanceRuntime
} from './instance-runtime';
import { isModelRef, parseModelRef } from './opencode-config';
import { findRepo } from './repos';
import type { SessionPhase, SessionStatePatch } from './sessions';

const STATE_KEY = 'session-agent:state';
const SCHEMA_VERSION = 1;

/**
 * Automatic retries cover transient wake failures (cold start, a racing idle
 * stop). A repository or model problem needs a human, so dispatch then stops at
 * `failed` and waits for an explicit retry from the Hub.
 */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000] as const;

/**
 * The lease deliberately outlives dispatch and is never explicitly ended: a
 * just-accepted task can take a moment to appear as busy, and expiring the
 * lease is the conservative way to bridge that gap.
 */
const DISPATCH_WORK_LEASE_MS = 90_000;

interface PendingPrompt {
  id: string;
  text: string;
  model: string;
  queuedAt: string;
}

interface StoredSessionAgentState {
  schemaVersion: number;
  sessionId: string;
  instanceId: string;
  repoKey: string;
  /** Absolute container path the OpenCode session is bound to. */
  directory: string;
  model: string;
  title: string;
  opencodeSessionId?: string;
  phase: SessionPhase;
  pending: PendingPrompt[];
  attempt: number;
  lastError?: string;
  lastPromptAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StartSessionInput {
  sessionId: string;
  instanceId: string;
  repoKey: string;
  directory: string;
  model: string;
  title: string;
  prompt: string;
  promptId?: string;
}

export interface SessionAgentSnapshot {
  sessionId: string;
  phase: SessionPhase;
  pendingPromptCount: number;
  opencodeSessionId?: string;
  lastError?: string;
  lastPromptAt?: string;
  updatedAt: string;
}

export class SessionAgent extends DurableObject<Env> {
  private readonly agentState: DurableObjectState<{}>;
  private readonly ready: Promise<void>;
  private state: StoredSessionAgentState | undefined;
  private advanceInProgress: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.agentState = ctx;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<StoredSessionAgentState>(STATE_KEY);
      if (this.state && this.state.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(
          `Unsupported session agent schema: ${String(this.state.schemaVersion)}`
        );
      }
      if (
        this.state &&
        needsDispatch(this.state) &&
        (await ctx.storage.getAlarm()) === null
      ) {
        await ctx.storage.setAlarm(Date.now());
      }
    });
  }

  /**
   * Record the session and queue its opening prompt. This returns as soon as
   * the work is durable; the alarm performs the wake and dispatch.
   */
  async startSession(input: StartSessionInput): Promise<SessionAgentSnapshot> {
    await this.ready;
    if (this.state) {
      if (this.state.sessionId !== input.sessionId) {
        throw new Error('Session agent identity does not match the Hub record');
      }
      return this.snapshot();
    }
    if (!findRepo(input.repoKey)) {
      throw new Error(`Unknown repository: ${input.repoKey}`);
    }
    if (!isModelRef(input.model)) {
      throw new Error(`Unknown model: ${input.model}`);
    }

    const now = new Date().toISOString();
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      repoKey: input.repoKey,
      directory: input.directory,
      model: input.model,
      title: input.title,
      phase: 'queued',
      pending: [
        {
          id: input.promptId ?? crypto.randomUUID(),
          text: input.prompt,
          model: input.model,
          queuedAt: now
        }
      ],
      attempt: 0,
      createdAt: now,
      updatedAt: now
    };
    await this.persist();
    await this.agentState.storage.setAlarm(Date.now());
    return this.snapshot();
  }

  /** Clear a failure and dispatch the still-pending prompts again. */
  async retrySession(): Promise<SessionAgentSnapshot> {
    await this.ready;
    const state = this.requireState();
    this.state = {
      ...state,
      phase: state.pending.length > 0 ? 'queued' : 'working',
      attempt: 0,
      lastError: undefined,
      updatedAt: new Date().toISOString()
    };
    delete this.state.lastError;
    await this.persist();
    await this.reportToHub();
    if (needsDispatch(this.state)) {
      await this.agentState.storage.setAlarm(Date.now());
    }
    return this.snapshot();
  }

  async getSnapshot(): Promise<SessionAgentSnapshot | undefined> {
    await this.ready;
    return this.state ? this.snapshot() : undefined;
  }

  /** Drop persisted state when the owning instance is deleted. */
  async markDeleted(): Promise<void> {
    await this.ready;
    this.state = undefined;
    await this.agentState.storage.deleteAll();
  }

  override async alarm(): Promise<void> {
    await this.ready;
    if (!this.advanceInProgress) {
      this.advanceInProgress = this.advance().finally(() => {
        this.advanceInProgress = undefined;
      });
    }
    await this.advanceInProgress;
  }

  private async advance(): Promise<void> {
    const state = this.state;
    if (!state || !needsDispatch(state)) {
      return;
    }

    await this.update({ phase: 'starting' });
    try {
      await this.dispatchPending();
      await this.update({ phase: 'working', attempt: 0, lastError: undefined });
    } catch (error) {
      if (!this.state) {
        // The session was deleted mid-dispatch; scheduling a retry would only
        // recreate storage for a session nobody can reach.
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const attempt = this.state.attempt + 1;
      const backoff = RETRY_BACKOFF_MS[attempt - 1];
      await this.update({
        phase: attempt > RETRY_BACKOFF_MS.length ? 'failed' : 'queued',
        attempt,
        lastError: message
      });
      console.warn('Session dispatch failed', {
        sessionId: state.sessionId,
        attempt,
        error: message
      });
      if (backoff !== undefined) {
        await this.agentState.storage.setAlarm(Date.now() + backoff);
      }
    }
  }

  private async dispatchPending(): Promise<void> {
    const state = this.requireState();
    const sandbox = resolveInstanceSandbox(this.env, state.instanceId);
    const lifecycle = resolveInstanceLifecycle(this.env, state.instanceId);
    const wake = await wakeInstanceRuntime(
      this.env,
      state.instanceId,
      lifecycle
    );

    const lease = await lifecycle.beginWork(
      wake.runtimeEpoch,
      DISPATCH_WORK_LEASE_MS
    );
    if (!lease.admitted) {
      throw new Error(
        `Runtime did not admit session work: ${lease.reason} (${lease.phase})`
      );
    }

    if (!this.state?.opencodeSessionId) {
      const opencodeSessionId = await sandbox.createOpencodeSession(
        wake.runtimeEpoch,
        { title: state.title, directory: state.directory }
      );
      await this.update({ opencodeSessionId });
    }
    const opencodeSessionId = this.requireState().opencodeSessionId!;

    // Prompts leave the queue one at a time so a failure halfway through a
    // batch cannot replay an already-accepted prompt on the next attempt.
    while (this.state && this.state.pending.length > 0) {
      const prompt = this.state.pending[0];
      const model = parseModelRef(prompt.model);
      if (!model) {
        throw new Error(`Unknown model: ${prompt.model}`);
      }
      await sandbox.promptOpencodeSessionAsync(wake.runtimeEpoch, {
        opencodeSessionId,
        directory: this.state.directory,
        providerID: model.providerID,
        modelID: model.modelID,
        text: prompt.text
      });
      await this.update({
        pending: this.state.pending.filter((queued) => queued.id !== prompt.id),
        lastPromptAt: new Date().toISOString()
      });
    }
  }

  private async update(
    patch: Partial<
      Pick<
        StoredSessionAgentState,
        | 'phase'
        | 'pending'
        | 'attempt'
        | 'opencodeSessionId'
        | 'lastPromptAt'
        | 'lastError'
      >
    >
  ): Promise<void> {
    const state = this.state;
    if (!state) {
      // The session was deleted while a dispatch was in flight. Do not
      // resurrect its storage.
      return;
    }
    this.state = {
      ...state,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    if (patch.lastError === undefined && 'lastError' in patch) {
      delete this.state.lastError;
    }
    await this.persist();
    await this.reportToHub();
  }

  /**
   * Mirror dispatch state into the Hub registry so the session list stays
   * readable without touching this object or the container.
   */
  private async reportToHub(): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }
    const update: SessionStatePatch = {
      phase: state.phase,
      pendingPromptCount: state.pending.length,
      lastError: state.lastError ?? null,
      ...(state.opencodeSessionId
        ? { opencodeSessionId: state.opencodeSessionId }
        : {}),
      ...(state.lastPromptAt ? { lastPromptAt: state.lastPromptAt } : {})
    };
    try {
      await this.env.Hub.getByName(HUB_DURABLE_OBJECT_ID).updateSession(
        state.sessionId,
        update
      );
    } catch (error) {
      // The agent remains the source of truth; a stale list entry is repaired
      // by the next successful report.
      console.warn('Failed to mirror session state to the Hub', {
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async persist(): Promise<void> {
    if (this.state) {
      await this.agentState.storage.put(STATE_KEY, this.state);
    }
  }

  private requireState(): StoredSessionAgentState {
    if (!this.state) {
      throw new Error('Session agent is not initialized');
    }
    return this.state;
  }

  private snapshot(): SessionAgentSnapshot {
    const state = this.requireState();
    return {
      sessionId: state.sessionId,
      phase: state.phase,
      pendingPromptCount: state.pending.length,
      ...(state.opencodeSessionId
        ? { opencodeSessionId: state.opencodeSessionId }
        : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
      ...(state.lastPromptAt ? { lastPromptAt: state.lastPromptAt } : {}),
      updatedAt: state.updatedAt
    };
  }
}

function needsDispatch(state: StoredSessionAgentState): boolean {
  return state.pending.length > 0 && state.phase !== 'failed';
}
