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
 * The queue is also how a sleeping session is continued: a prompt is durable
 * before the container exists, and the wake happens here rather than in the
 * request the user is waiting on. That is what lets the session page accept a
 * message during a cold start instead of sending the user off to wake the
 * container first.
 *
 * This object deliberately holds no runtime lifecycle policy. It only calls the
 * LifecycleCoordinator's explicit wake path, and takes a short work lease so a
 * task that starts between two activity probes still resets the idle window.
 */
import { DurableObject } from 'cloudflare:workers';
import type { SessionProvider } from '../protocol/types.ts';
import {
  insertSessionRow,
  markSessionStatusQuery,
  markSessionUnread,
  updateSession,
  type NewSession
} from './hub-store';
import {
  resolveInstanceLifecycle,
  resolveInstanceSandbox,
  wakeInstanceRuntime,
  type InstanceSandboxRpc,
  type OpencodeSessionActivityInput
} from './instance-runtime';
import { loadModelCatalog } from './model-catalog';
import { WORKSPACE_ROOT, type RepoDefinition } from './repos';
import {
  promptAttachmentPrefix,
  type SessionAttachmentRef,
  type SessionPhase,
  type SessionRecord,
  type SessionStatePatch
} from './sessions';

const STATE_KEY = 'session-agent:state';
/**
 * 2 added the creation intent — instance name, provider, repository definition
 * — so this object can register its own session. A version 1 state belongs to a
 * session the create request had already registered, which is what
 * `migrateState` records by marking it registered.
 */
const SCHEMA_VERSION = 2;

/**
 * Automatic retries cover transient wake failures (cold start, a racing idle
 * stop). A repository or model problem needs a human, so dispatch then stops at
 * `failed` and waits for an explicit retry from the Hub.
 */
const RETRY_BACKOFF_MS = [5_000, 20_000, 60_000] as const;

/**
 * The lease bridges the gap between a task being accepted and the activity
 * probe being able to see it, so it must outlive `prompt_async` returning.
 *
 * Dispatch ends it explicitly once the handover is observably real (see
 * `dispatchPending`), because holding it to expiry pins the session at
 * `working` for the full TTL even after the agent has finished — the dominant
 * term in perceived status lag for any task shorter than the lease. The TTL
 * remains the fallback for every path that cannot confirm: a dispatch that
 * throws, or a session that never becomes observably active.
 */
const DISPATCH_WORK_LEASE_MS = 90_000;

/**
 * How many delivered prompt ids to remember for deduplication.
 *
 * A client retry usually lands after the prompt has already been dispatched and
 * left the queue, so checking the queue alone would deliver it twice. The list
 * only has to outlive a retry, not the conversation.
 */
const MAX_DELIVERED_PROMPT_IDS = 50;

/**
 * How long to wait for the first prompt of a batch to make the session busy,
 * and how often to check.
 *
 * `prompt_async` answers 204 as soon as the container has *accepted* a task,
 * which is not the same as having started it. OpenCode serializes prompts that
 * arrive while a session is already running — but prompts that arrive at an
 * *idle* session within milliseconds of each other each try to start a turn and
 * race. Measured locally before this wait existed, three messages sent to a
 * sleeping session were recorded in the order 2, 3, 1.
 *
 * So the invariant to hold is narrow: never hand two prompts to an idle
 * session at once. Waiting for busy before the second prompt establishes it,
 * and the session stays busy for the rest of the batch, which puts every
 * remaining prompt on OpenCode's own ordered queue. (That queue may answer
 * several of them in one agent turn — order is preserved, one-turn-per-message
 * is not promised.)
 *
 * Giving up is deliberate: ordering is worth a bounded wait, not a stuck queue.
 */
const PROMPT_SETTLE_POLL_INTERVAL_MS = 250;
const PROMPT_SETTLE_POLL_ATTEMPTS = 40;

interface PendingPrompt {
  id: string;
  text: string;
  model: string;
  /** OpenCode variant for this prompt; absent when the model has none. */
  variant?: string;
  /**
   * R2 references to staged images. Only references ride the queue: the whole
   * agent state is one storage value with a 128 KiB cap, far below one image.
   */
  attachments?: SessionAttachmentRef[];
  queuedAt: string;
}

interface StoredSessionAgentState {
  schemaVersion: number;
  sessionId: string;
  instanceId: string;
  /**
   * The instance's display name, minted by the create request. Held here
   * because this object writes the registry row, and the name has to survive a
   * retry of that write unchanged.
   */
  instanceName: string;
  /** Which sandbox host runs the container. */
  provider: SessionProvider;
  /** Absent when the session was created without a repository. */
  repoKey?: string;
  /**
   * The catalog entry the Sandbox clones. Pinned here for the same reason it is
   * pinned on the row: nothing downstream can look a repository up, and the
   * catalog may not contain it any more by the time this session wakes.
   */
  repo?: RepoDefinition;
  /**
   * Set once the registry row exists and the Sandbox has been told what it
   * runs. Until then this object is the only place the session exists.
   */
  registered?: true;
  /** Absolute container path the OpenCode session is bound to. */
  directory: string;
  model: string;
  /** Last selected OpenCode variant; absent when the model has none. */
  variant?: string;
  title: string;
  opencodeSessionId?: string;
  phase: SessionPhase;
  pending: PendingPrompt[];
  /**
   * Ids of prompts already handed to the container, most recent last. Absent on
   * states written before deduplication covered delivered prompts.
   */
  deliveredPromptIds?: string[];
  attempt: number;
  lastError?: string;
  lastPromptAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The whole of a new session: what it is, and the prompt it starts with.
 *
 * This is the only write the create request makes, so it has to carry
 * everything the registry row and the Sandbox need — not just what dispatch
 * needs.
 */
export interface StartSessionInput {
  sessionId: string;
  instanceId: string;
  instanceName: string;
  provider: SessionProvider;
  /** Absent when the session was created without a repository. */
  repoKey?: string;
  /** The catalog entry to clone; absent alongside `repoKey`. */
  repo?: RepoDefinition;
  directory: string;
  model: string;
  variant?: string;
  title: string;
  createdAt: string;
  prompt: string;
  promptId?: string;
  attachments?: SessionAttachmentRef[];
}

export interface QueuePromptInput {
  prompt: string;
  /** Switches the session's model when present; otherwise the current one. */
  model?: string;
  /**
   * OpenCode variant (reasoning effort). When omitted, the session's last
   * variant is kept if the model still supports it; otherwise the model default.
   */
  variant?: string;
  /** Supplied by a client that may retry, so a resend is not a second prompt. */
  promptId?: string;
  attachments?: SessionAttachmentRef[];
}

/**
 * Raised when the conversation this session names is gone for good.
 *
 * It is not a dispatch failure: no number of retries reaches a session the
 * container cannot produce, so this ends the state machine at `lost` instead of
 * entering the retry ladder.
 */
class SessionStateLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStateLostError';
  }
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
  private registerInProgress: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.agentState = ctx;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<StoredSessionAgentState>(STATE_KEY);
      this.state = stored ? migrateState(stored) : undefined;
      if (this.state && this.state !== stored) {
        await ctx.storage.put(STATE_KEY, this.state);
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
   * Bring a session into existence and queue its opening prompt.
   *
   * One storage write, and everything else — the registry row, the Sandbox's
   * identity, the wake, the clone, the first dispatch — happens on the alarm.
   * That is deliberate: the create request cannot be cancelled halfway into a
   * half-made session, because there is no halfway. Either this write lands, in
   * which case the session is real and will run without anybody's browser
   * staying open, or it does not, and nothing was created at all.
   */
  async startSession(input: StartSessionInput): Promise<SessionAgentSnapshot> {
    await this.ready;
    if (this.state) {
      if (this.state.sessionId !== input.sessionId) {
        throw new Error('Session agent identity does not match the Hub record');
      }
      return this.snapshot();
    }
    // The catalog is dynamic and the caller has already resolved it, so what
    // matters here is that the checkout path is one this Hub could have made.
    if (
      input.directory !== WORKSPACE_ROOT &&
      !input.directory.startsWith(`${WORKSPACE_ROOT}/`)
    ) {
      throw new Error(`Invalid session directory: ${input.directory}`);
    }
    const catalog = await loadModelCatalog(this.env);
    if (!catalog.isModelRef(input.model)) {
      throw new Error(`Unknown model: ${input.model}`);
    }
    const variant = catalog.resolveVariant(input.model, input.variant);

    const now = new Date().toISOString();
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      sessionId: input.sessionId,
      instanceId: input.instanceId,
      instanceName: input.instanceName,
      provider: input.provider,
      ...(input.repoKey ? { repoKey: input.repoKey } : {}),
      ...(input.repo ? { repo: input.repo } : {}),
      directory: input.directory,
      model: input.model,
      ...(variant ? { variant } : {}),
      title: input.title,
      phase: 'queued',
      pending: [
        {
          id: input.promptId ?? crypto.randomUUID(),
          text: input.prompt,
          model: input.model,
          ...(variant ? { variant } : {}),
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          queuedAt: now
        }
      ],
      attempt: 0,
      createdAt: input.createdAt,
      updatedAt: now
    };
    await this.persist();
    await this.agentState.storage.setAlarm(Date.now());
    return this.snapshot();
  }

  /**
   * Put this session in the registry, if it is not there already.
   *
   * Normally the alarm does this on its way into the first dispatch. It is also
   * reachable from a route, because the session id is handed to the client
   * before the alarm has run: a page that opens the new session immediately
   * would otherwise read a 404 for as long as the alarm took to fire. Whoever
   * gets here first does the work; the other waits on the same promise.
   */
  async ensureRegistered(): Promise<boolean> {
    await this.ready;
    if (!this.state) {
      return false;
    }
    await this.registerOnce();
    return true;
  }

  /** `register`, with concurrent callers folded onto one attempt. */
  private async registerOnce(): Promise<void> {
    if (!this.registerInProgress) {
      this.registerInProgress = this.register().finally(() => {
        this.registerInProgress = undefined;
      });
    }
    await this.registerInProgress;
  }

  /**
   * The two writes that make a session findable from outside this object: the
   * registry row every id-addressed route reads, and the Sandbox's identity,
   * which is what tells the container which repository it runs.
   *
   * The row goes first because it is what this object's own state reports
   * mirror into — an update against a missing row is silently dropped. Both
   * calls are idempotent, so a partial failure is repaired by the next attempt
   * rather than compensated for here.
   */
  private async register(): Promise<void> {
    const state = this.requireState();
    if (state.registered) {
      return;
    }
    await insertSessionRow(this.env, newSessionFromState(state));
    await resolveInstanceSandbox(this.env, state.instanceId).initializeInstance(
      state.instanceId,
      state.repoKey,
      state.repo,
      state.provider
    );
    // Written straight to storage rather than through `update`: the mirror that
    // `update` performs is what this method exists to make possible, and the
    // caller is about to report the real phase anyway.
    this.state = { ...state, registered: true, updatedAt: new Date().toISOString() };
    await this.persist();
  }

  /**
   * Queue a follow-up prompt on an existing session.
   *
   * This takes the same path as the opening prompt: the queue is durable, the
   * alarm dispatches it, and prompts leave the queue one at a time, so several
   * messages sent in quick succession arrive in order and none is delivered
   * twice. Sending is also how a user retries after a failure — it is an
   * explicit intent to proceed, so it clears the recorded error rather than
   * requiring a separate retry first.
   */
  async queuePrompt(input: QueuePromptInput): Promise<SessionAgentSnapshot> {
    await this.ready;
    const state = this.requireState();
    if (state.phase === 'lost') {
      throw new SessionStateLostError(
        state.lastError ??
          'This session is lost: the container no longer holds its conversation.'
      );
    }
    const model = input.model ?? state.model;
    const catalog = await loadModelCatalog(this.env);
    if (!catalog.isModelRef(model)) {
      throw new Error(`Unknown model: ${model}`);
    }
    const variant = catalog.resolveVariant(
      model,
      input.variant !== undefined ? input.variant : state.variant
    );

    const id = input.promptId ?? crypto.randomUUID();
    if (
      state.pending.some((queued) => queued.id === id) ||
      (state.deliveredPromptIds ?? []).includes(id)
    ) {
      // A retried request carrying a known id is the same prompt, not a second
      // one — whether it is still queued or has already been delivered.
      return this.snapshot();
    }

    const now = new Date().toISOString();
    this.state = {
      ...state,
      model,
      ...(variant ? { variant } : {}),
      pending: [
        ...state.pending,
        {
          id,
          text: input.prompt,
          model,
          ...(variant ? { variant } : {}),
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          queuedAt: now
        }
      ],
      phase: 'queued',
      attempt: 0,
      updatedAt: now
    };
    if (!variant) {
      delete this.state.variant;
    }
    delete this.state.lastError;
    await this.persist();
    await this.reportToHub();
    // Sending can wake a sleeping container; the list must calibrate until
    // the runtime settles on idle or sleeping again.
    await markSessionStatusQuery(this.env, this.state.sessionId).catch(
      () => undefined
    );
    await this.agentState.storage.setAlarm(Date.now());
    return this.snapshot();
  }

  /** Clear a failure and dispatch the still-pending prompts again. */
  async retrySession(): Promise<SessionAgentSnapshot> {
    await this.ready;
    const state = this.requireState();
    if (state.phase === 'lost') {
      // Nothing to retry into. Leaving the phase alone is the whole point: a
      // retry that silently re-queued would put the session back on the ladder
      // that already established the conversation is gone.
      return this.snapshot();
    }
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
    await markSessionStatusQuery(this.env, this.state.sessionId).catch(
      () => undefined
    );
    if (needsDispatch(this.state)) {
      await this.agentState.storage.setAlarm(Date.now());
    }
    return this.snapshot();
  }

  async getSnapshot(): Promise<SessionAgentSnapshot | undefined> {
    await this.ready;
    return this.state ? this.snapshot() : undefined;
  }

  /**
   * Record that the conversation is gone, from outside the dispatch path.
   *
   * The session view is normally what notices first — it reads the container's
   * runtime status on every poll — and the agent has to agree, or its alarm
   * would go on dispatching into a session the container cannot produce.
   */
  async markLost(lastError: string): Promise<SessionAgentSnapshot | undefined> {
    await this.ready;
    if (!this.state) {
      return undefined;
    }
    if (this.state.phase !== 'lost') {
      await this.agentState.storage.deleteAlarm();
      await this.update({ phase: 'lost', attempt: 0, lastError });
    }
    return this.snapshot();
  }

  /** Drop persisted state when the owning instance is deleted. */
  async markDeleted(): Promise<void> {
    await this.ready;
    const state = this.state;
    this.state = undefined;
    await this.agentState.storage.deleteAll();
    if (state) {
      // The images of prompts this session never got to deliver. Their bytes
      // are reachable only through the queue that just went away, so this is
      // the last chance to reclaim them; the daily upload sweep is the backstop
      // if it fails.
      await this.deleteQueuedAttachments(state).catch((error) => {
        console.warn('Failed to sweep queued prompt attachments', {
          sessionId: state.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  private async deleteQueuedAttachments(
    state: StoredSessionAgentState
  ): Promise<void> {
    const keys = state.pending.flatMap((prompt) =>
      (prompt.attachments ?? []).map((attachment) => attachment.key)
    );
    if (keys.length > 0) {
      await this.env.SESSION_BUCKET.delete(keys);
    }
    // Sessions created before uploads were their own request staged images
    // under the session itself; their keys are not in the queue.
    const prefix = promptAttachmentPrefix(state.sessionId);
    let cursor: string | undefined;
    do {
      const page = await this.env.SESSION_BUCKET.list({
        prefix,
        ...(cursor ? { cursor } : {})
      });
      if (page.objects.length > 0) {
        await this.env.SESSION_BUCKET.delete(
          page.objects.map((object) => object.key)
        );
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
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

    try {
      // Before the first report, because a report against a session the
      // registry has never heard of goes nowhere.
      await this.registerOnce();
      await this.update({ phase: 'starting' });
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
      const exhausted = attempt > RETRY_BACKOFF_MS.length;
      // Two routes to the same verdict, and they are not equally certain. The
      // container reporting an unrestored workspace is a fact about storage:
      // act on it at once, before the retry ladder wastes three more wakes. A
      // 404 from OpenCode is only evidence — a session can also read as missing
      // while the checkout it belongs to is still being provisioned — so it
      // ends the ladder rather than skipping it, and only decides the verdict
      // once the retries have failed to disagree.
      if (
        error instanceof SessionStateLostError ||
        (exhausted && isMissingOpencodeSession(message))
      ) {
        // Terminal: no alarm, no further retries. The queued prompts stay on
        // the record so the user can see what never made it, and the Hub
        // renders the session as lost rather than as one more thing to retry.
        await this.update({ phase: 'lost', attempt: 0, lastError: message });
        console.warn('Session state lost', {
          sessionId: state.sessionId,
          error: message
        });
        return;
      }
      const backoff = RETRY_BACKOFF_MS[attempt - 1];
      await this.update({
        phase: exhausted ? 'failed' : 'queued',
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

    // The container reports an unrestored workspace as soon as it comes up, so
    // ask before spending a lease and a prompt on a conversation that cannot
    // exist any more.
    await this.assertSessionStateSurvived(sandbox);

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
        { directory: state.directory }
      );
      await this.update({ opencodeSessionId });
    }
    const opencodeSessionId = this.requireState().opencodeSessionId!;

    // Prompts leave the queue one at a time so a failure halfway through a
    // batch cannot replay an already-accepted prompt on the next attempt.
    const catalog = await loadModelCatalog(this.env);
    let delivered = false;
    while (this.state && this.state.pending.length > 0) {
      const prompt = this.state.pending[0];
      const model = catalog.parseModelRef(prompt.model);
      if (!model) {
        throw new Error(`Unknown model: ${prompt.model}`);
      }
      const directory = this.state.directory;
      await sandbox.promptOpencodeSessionAsync(wake.runtimeEpoch, {
        opencodeSessionId,
        directory,
        providerID: model.providerID,
        modelID: model.modelID,
        ...(prompt.variant ? { variant: prompt.variant } : {}),
        text: prompt.text,
        ...(prompt.attachments?.length
          ? { attachments: prompt.attachments }
          : {})
      });
      await this.update({
        model: prompt.model,
        variant: prompt.variant ?? null,
        pending: this.state.pending.filter((queued) => queued.id !== prompt.id),
        deliveredPromptIds: [
          ...(this.state.deliveredPromptIds ?? []),
          prompt.id
        ].slice(-MAX_DELIVERED_PROMPT_IDS),
        lastPromptAt: new Date().toISOString()
      });
      if (prompt.attachments?.length) {
        // Only after the dequeue is durable: a dispatch that throws must leave
        // the staged bytes in place for the retry ladder.
        await this.env.SESSION_BUCKET.delete(
          prompt.attachments.map((attachment) => attachment.key)
        ).catch((error) => {
          console.warn('Failed to delete staged prompt attachments', {
            sessionId: state.sessionId,
            promptId: prompt.id,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
      delivered = true;
      if (this.state && this.state.pending.length > 0) {
        await this.awaitPromptSettled(sandbox, wake.runtimeEpoch, {
          opencodeSessionId,
          directory
        });
      }
    }

    // Hand the session back to the activity probe as soon as the probe can
    // actually see the work, rather than letting the lease expire. Confirming
    // first is what makes this safe: `endWork` re-probes immediately, and a
    // probe fired before the task starts would read the session as idle.
    //
    // Nothing delivered means there is no handover to bridge, so the lease has
    // nothing left to protect either way. When the wait gives up the lease is
    // deliberately left to expire — the conservative reading of an
    // unobservable session is that it is working.
    const confirmed =
      !delivered ||
      (await this.awaitPromptSettled(sandbox, wake.runtimeEpoch, {
        opencodeSessionId,
        directory: this.state?.directory ?? state.directory
      }));
    if (confirmed) {
      await lifecycle.endWork(wake.runtimeEpoch, lease.leaseId);
    }
  }

  /**
   * Stop the dispatch when the container has lost this session's state.
   *
   * Only a session that already exists can be lost: before the first dispatch
   * has created one there is nothing in the container to miss, and an empty
   * workspace is simply the first wake.
   */
  private async assertSessionStateSurvived(
    sandbox: InstanceSandboxRpc
  ): Promise<void> {
    const opencodeSessionId = this.state?.opencodeSessionId;
    if (!opencodeSessionId) {
      return;
    }
    const runtime = await sandbox.getInstanceRuntimeStatus();
    if (runtime.workspaceLost?.opencodeSessionId !== opencodeSessionId) {
      return;
    }
    throw new SessionStateLostError(
      `The container restarted without a workspace checkpoint, so OpenCode session ${opencodeSessionId} no longer exists (lost at ${runtime.workspaceLost.at}).`
    );
  }

  /**
   * Wait until the session is observably running work. Returns whether that was
   * confirmed.
   *
   * Two callers, both wanting the same fact for different reasons. Between
   * prompts it enforces ordering, and the answer is ignored: sending the next
   * prompt slightly too early risks the wrong order, while refusing to send it
   * at all loses the message. After the batch it decides whether the dispatch
   * lease can be released, where a false answer means "keep the lease".
   *
   * The post-batch call is normally the cheap case — a multi-prompt batch has
   * already established busy, and a single prompt only has to become active
   * once — so this costs one probe, not the full wait.
   */
  private async awaitPromptSettled(
    sandbox: InstanceSandboxRpc,
    runtimeEpoch: string,
    target: OpencodeSessionActivityInput
  ): Promise<boolean> {
    for (let attempt = 0; attempt < PROMPT_SETTLE_POLL_ATTEMPTS; attempt += 1) {
      try {
        if (await sandbox.isOpencodeSessionActive(runtimeEpoch, target)) {
          return true;
        }
      } catch (error) {
        console.warn('Failed to observe session activity after dispatch', {
          sessionId: this.state?.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      }
      await scheduler.wait(PROMPT_SETTLE_POLL_INTERVAL_MS);
    }
    console.warn('Prompt did not become active before the settle wait expired', {
      sessionId: this.state?.sessionId
    });
    return false;
  }

  private async update(
    patch: Partial<
      Pick<
        StoredSessionAgentState,
        | 'phase'
        | 'model'
        | 'pending'
        | 'deliveredPromptIds'
        | 'attempt'
        | 'opencodeSessionId'
        | 'lastPromptAt'
        | 'lastError'
      >
    > & { variant?: string | null }
  ): Promise<void> {
    const state = this.state;
    if (!state) {
      // The session was deleted while a dispatch was in flight. Do not
      // resurrect its storage.
      return;
    }
    const { variant, ...rest } = patch;
    this.state = {
      ...state,
      ...rest,
      updatedAt: new Date().toISOString()
    };
    if (variant === null) {
      delete this.state.variant;
    } else if (variant !== undefined) {
      this.state.variant = variant;
    }
    if (patch.lastError === undefined && 'lastError' in patch) {
      delete this.state.lastError;
    }
    await this.persist();
    await this.reportToHub();
    if (patch.phase === 'failed' || patch.phase === 'lost') {
      // A terminal dispatch failure is a stop the user has to come look at,
      // and it never reaches the container's event stream — the run died
      // before or outside the container — so the unread marker is set here.
      await markSessionUnread(this.env, this.state.sessionId).catch(
        (error: unknown) => {
          console.warn('Failed to mark session unread', {
            sessionId: state.sessionId,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      );
    }
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
      model: state.model,
      variant: state.variant ?? null,
      pendingPromptCount: state.pending.length,
      lastError: state.lastError ?? null,
      ...(state.opencodeSessionId
        ? { opencodeSessionId: state.opencodeSessionId }
        : {}),
      ...(state.lastPromptAt ? { lastPromptAt: state.lastPromptAt } : {})
    };
    try {
      await updateSession(this.env, state.sessionId, update);
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

/**
 * Bring a stored state up to the current schema.
 *
 * Version 1 predates this object owning creation: its session was registered by
 * the create request, so it is registered by definition — and the fields that
 * registration needs were never stored, which is exactly why the flag matters
 * more than the fields. The instance name is the one thing that cannot be
 * recovered here; nothing reads it on an already-registered session.
 */
function migrateState(
  state: StoredSessionAgentState
): StoredSessionAgentState {
  if (state.schemaVersion === SCHEMA_VERSION) {
    return state;
  }
  if (state.schemaVersion !== 1) {
    throw new Error(
      `Unsupported session agent schema: ${String(state.schemaVersion)}`
    );
  }
  return {
    ...state,
    schemaVersion: SCHEMA_VERSION,
    instanceName: state.instanceName ?? state.instanceId,
    provider: state.provider ?? 'cloudflare',
    registered: true
  };
}

/**
 * The registry row this session should have, rebuilt from the agent's own
 * state.
 *
 * Phase and pending count come from the state as it is now rather than from
 * creation, because the row may be written after the first dispatch attempt has
 * already moved both.
 */
function newSessionFromState(state: StoredSessionAgentState): NewSession {
  const record: SessionRecord = {
    id: state.sessionId,
    instanceId: state.instanceId,
    ...(state.repoKey ? { repoKey: state.repoKey } : {}),
    directory: state.directory,
    provider: state.provider,
    model: state.model,
    ...(state.variant ? { variant: state.variant } : {}),
    title: state.title,
    phase: state.phase,
    pendingPromptCount: state.pending.length,
    statusQuery: true,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
  return {
    record,
    name: state.instanceName,
    ...(state.repo ? { repo: state.repo } : {})
  };
}

function needsDispatch(state: StoredSessionAgentState): boolean {
  return (
    state.pending.length > 0 &&
    state.phase !== 'failed' &&
    state.phase !== 'lost'
  );
}

/**
 * Whether the container is telling us the OpenCode session no longer exists.
 *
 * The Sandbox reports the loss up front once it has seen an empty workspace,
 * but a container can also lose its state in ways nothing observed — so the
 * 404 that comes back from a prompt is treated as the same fact rather than as
 * one more transient dispatch failure to retry.
 */
function isMissingOpencodeSession(message: string): boolean {
  return /session not found/i.test(message);
}
