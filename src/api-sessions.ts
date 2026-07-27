/**
 * Session API: the product-level unit of work.
 *
 * A session is one repository, one model and one prompt thread, mapped 1:1 onto
 * a container that sleeps independently. Creating one returns immediately; the
 * SessionAgent Durable Object performs the wake and the dispatch.
 */
import {
  HttpError,
  decodeRouteSegment,
  isSafeInstanceId,
  isWebSocketUpgrade,
  json,
  methodNotAllowed,
  stripAccessCredentials
} from './http';
import {
  getHub,
  getInstanceView,
  resolveLifecycle,
  resolveSandbox,
  unknownRuntimeStatus
} from './instance-access';
import {
  ensureLifecycleInitialized,
  OPENCODE_PORT,
  RUNTIME_EPOCH_HEADER
} from './instance-runtime';
import type { InstanceRecord, InstanceView } from './instances';
import {
  DEFAULT_MODEL_REF,
  defaultVariantForModel,
  isModelRef,
  isValidVariant
} from './opencode-config';
import { isSafeRepoKey, repoWorkspaceDirectory } from './repos';
import type { QueuePromptInput } from './session-agent';
import {
  isSafeBranchName,
  MAX_COMMIT_MESSAGE_LENGTH,
  MAX_PULL_REQUEST_BODY_LENGTH,
  normalizeCommitMessage,
  type PublishSessionChangesInput
} from './session-changes';
import {
  closedSessionEventStream,
  forwardSessionEventStream,
  type SessionStateEvent
} from './session-events';
import {
  deriveDisplayTitle,
  deriveLastActivityAt,
  deriveSessionStatus,
  deriveSessionTitle,
  MAX_SESSION_TITLE_LENGTH,
  normalizeSessionPrompt,
  type SessionMessage,
  type SessionRecord,
  type SessionTranscript,
  type SessionView
} from './sessions';
import { getTranscriptMirror } from './transcript-mirror';

/**
 * Session API.
 *
 * The Hub creates a session, its instance, and its dispatch agent in one
 * request and returns immediately: waking the container, provisioning the
 * repository and starting the agent loop all happen in the SessionAgent alarm.
 */
export async function handleSessionApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hub = getHub(env);

  if (url.pathname === '/api/sessions') {
    if (request.method === 'GET') {
      // Archived sessions are excluded by default rather than deleted: the list
      // is a working set, and everything stays reachable behind `?archived=`.
      const archived = url.searchParams.get('archived');
      const records = (await hub.listSessions()).filter((record) =>
        archived === 'all'
          ? true
          : archived === '1'
            ? Boolean(record.archivedAt)
            : !record.archivedAt
      );
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
    if (request.method === 'PATCH') {
      return await patchSession(request, env, record);
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
    return methodNotAllowed('GET, PATCH, DELETE');
  }

  if (action === 'messages') {
    if (request.method === 'GET') {
      const transcript = await readSessionTranscript(env, record);
      return json(transcript, 200, {
        'X-OpenCode-Hub-Transcript-State': transcript.state,
        'X-OpenCode-Hub-Transcript-Source': transcript.source,
        'X-OpenCode-Hub-Transcript-At': transcript.observedAt,
        // How current the data is, which for a mirror is not the same as when
        // it was read.
        ...(transcript.mirroredAt
          ? { 'X-OpenCode-Hub-Transcript-Mirrored-At': transcript.mirroredAt }
          : {})
      });
    }
    if (request.method === 'POST') {
      return await sendSessionPrompt(request, env, record);
    }
    return methodNotAllowed('GET, POST');
  }

  if (action === 'changes') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    const { instance, runtimeEpoch } = await requireAwakeRuntime(
      env,
      record,
      'read changes from'
    );
    return json(await resolveSandbox(env, instance).readSessionChanges(runtimeEpoch));
  }

  if (action === 'events') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await streamSessionEvents(env, record);
  }

  if (action === 'files') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await readSessionFiles(url, env, record);
  }

  if (action === 'terminal') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await openSessionTerminal(request, url, env, record);
  }

  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (action === 'keepalive') {
    return await keepSessionAwake(env, record);
  }
  if (action === 'abort') {
    return await abortSession(env, record);
  }
  if (action === 'publish') {
    return await publishSession(request, env, record);
  }
  if (action !== 'retry') {
    throw new HttpError(404, 'Session action not found');
  }
  if (record.phase === 'lost') {
    throw new HttpError(
      409,
      'This session was lost when its container restarted without a checkpoint. There is nothing left to retry into.'
    );
  }
  await resolveSessionAgent(env, record.id).retrySession();
  return json(await getSessionView(env, await requireSession(env, record.id)), 202);
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const input = await readCreateSessionInput(request);
  // Resolved against GitHub's catalog once, here, and then pinned onto the
  // records — so nothing this session does later needs the catalog again.
  const repo = await getHub(env).findCatalogRepo(input.repoKey);
  if (!repo) {
    throw new HttpError(400, 'Unknown repository');
  }

  const record = await getHub(env).createSession({
    repo,
    model: input.model,
    ...(input.variant ? { variant: input.variant } : {}),
    title: deriveSessionTitle(input.prompt)
  });
  try {
    await resolveSessionAgent(env, record.id).startSession({
      sessionId: record.id,
      instanceId: record.instanceId,
      repoKey: record.repoKey,
      directory: repoWorkspaceDirectory(repo.repoKey),
      model: record.model,
      ...(record.variant ? { variant: record.variant } : {}),
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
  variant?: string;
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

  const { repoKey, model, variant, prompt } = value as {
    repoKey?: unknown;
    model?: unknown;
    variant?: unknown;
    prompt?: unknown;
  };
  // Only the shape is checked here; whether the key names a real repository is
  // the catalog's answer, and the catalog is asynchronous now.
  if (!isSafeRepoKey(repoKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  const modelRef = model === undefined ? DEFAULT_MODEL_REF : model;
  if (!isModelRef(modelRef)) {
    throw new HttpError(400, 'Unknown model');
  }
  const resolvedVariant = resolveRequestVariant(modelRef, variant);
  const text = normalizeSessionPrompt(prompt);
  if (!text) {
    throw new HttpError(400, 'A prompt of up to 32000 characters is required');
  }
  return {
    repoKey,
    model: modelRef,
    ...(resolvedVariant ? { variant: resolvedVariant } : {}),
    prompt: text
  };
}

/**
 * Where this session's checkout lives inside its container.
 *
 * Pinned on the record since the catalog became dynamic, and derivable from the
 * key alone before that — which is what lets a session outlive the catalog
 * entry it was created from, and the catalog being unreachable entirely.
 */
function sessionDirectory(record: SessionRecord): string {
  return record.directory ?? repoWorkspaceDirectory(record.repoKey);
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
  const view: InstanceView = instance
    ? await getInstanceView(env, instance)
    : {
        id: record.instanceId,
        name: record.instanceId,
        repoKey: record.repoKey,
        lifecycle: 'deleting',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        runtime: unknownRuntimeStatus(true)
      };
  // A loss the container has already reported outranks whatever the record
  // still says. Reading the list is often the first thing that happens after a
  // container came back empty, so this is where the session usually learns it —
  // ahead of the next dispatch, and without waiting for one.
  if (
    record.phase !== 'lost' &&
    record.opencodeSessionId &&
    view.runtime.workspaceLost?.opencodeSessionId === record.opencodeSessionId
  ) {
    record = await markSessionLost(env, record, view.runtime.workspaceLost.at);
  }
  // The summary rides along on the runtime status the list already reads, so
  // knowing how much history a session has costs no extra round trip and no
  // contact with the container.
  const transcript =
    view.runtime.transcript &&
    view.runtime.transcript.opencodeSessionId === record.opencodeSessionId
      ? view.runtime.transcript
      : undefined;
  return {
    ...record,
    instance: view,
    status: deriveSessionStatus(record.phase, view.runtime),
    lastActivityAt: deriveLastActivityAt(record),
    displayTitle: deriveDisplayTitle(record, transcript),
    ...(transcript ? { transcript } : {})
  };
}

/**
 * Write the loss onto the record, once.
 *
 * The agent is told as well as the registry: it owns the phase, and leaving it
 * on `queued` would let its alarm keep dispatching into a conversation that no
 * longer exists.
 */
async function markSessionLost(
  env: Env,
  record: SessionRecord,
  at: string
): Promise<SessionRecord> {
  const lastError = `The container restarted without a workspace checkpoint at ${at}, so this conversation no longer exists.`;
  await resolveSessionAgent(env, record.id)
    .markLost(lastError)
    .catch((error: unknown) => {
      console.warn('Failed to mark the session agent lost', {
        sessionId: record.id,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  const updated = await getHub(env)
    .updateSession(record.id, { phase: 'lost', lastError })
    .catch(() => undefined);
  return updated ?? { ...record, phase: 'lost', lastError };
}

/**
 * Continue an existing conversation, whether or not the container is running.
 *
 * The prompt goes onto the SessionAgent's durable queue, the same path the
 * opening prompt takes: prompts leave that queue one at a time, so messages
 * sent in quick succession arrive in order and a retried request carrying the
 * same `promptId` is not delivered twice.
 *
 * Sending to a sleeping session wakes it. That is not a new capability — the
 * agent has always woken the container on dispatch — but it is now the normal
 * path rather than a race: sending a message *is* the explicit intent the
 * lifecycle rules require, so this no longer refuses and asks the user to wake
 * the container first. Every other path into a session stays passive; reading
 * the transcript, reconnecting the event stream and polling the list still
 * never start a container.
 *
 * The response is 202 either way. The caller cannot be kept waiting for a cold
 * start, so the session view it gets back reports a queued dispatch and the
 * session page renders the wake as progress.
 */
async function sendSessionPrompt(
  request: Request,
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const input = await readSendPromptInput(request);
  if (record.phase === 'lost') {
    // The conversation this session names is gone from the container. A message
    // sent here would either 404 or open a different conversation under this
    // session's name; both are worse than saying so.
    throw new HttpError(
      409,
      'This session was lost when its container restarted without a checkpoint. Start a new session to continue.'
    );
  }
  const instance = await getHub(env).getInstance(record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    // A container being deleted is the one state no amount of waking fixes.
    throw new HttpError(409, 'This session is not ready to receive messages');
  }
  await resolveSessionAgent(env, record.id).queuePrompt(input);
  if (record.archivedAt) {
    // Archiving says "I am done with this"; sending a message says otherwise.
    // Making the user un-archive first would only be a step to click through.
    await getHub(env).setSessionArchived(record.id, false);
  }
  return json(await getSessionView(env, await requireSession(env, record.id)), 202);
}

/** Stop the agent mid-run, leaving the conversation intact. */
async function abortSession(env: Env, record: SessionRecord): Promise<Response> {
  if (!record.opencodeSessionId) {
    throw new HttpError(409, 'This session has not started working yet');
  }
  const directory = sessionDirectory(record);
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    'abort'
  );

  const aborted = await resolveSandbox(env, instance).abortOpencodeSession(
    runtimeEpoch,
    {
      opencodeSessionId: record.opencodeSessionId,
      directory
    }
  );
  return json({
    aborted,
    session: await getSessionView(env, await requireSession(env, record.id))
  });
}

/**
 * Rename or archive a session.
 *
 * Both are registry edits: neither touches the container, so they work whether
 * the session is awake, asleep, or has never started. That is the point of
 * archiving — it is the ending that keeps the work, next to deletion which
 * destroys the workspace with it.
 */
async function patchSession(
  request: Request,
  env: Env,
  record: SessionRecord
): Promise<Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const { title, archived } = value as { title?: unknown; archived?: unknown };
  if (title === undefined && archived === undefined) {
    throw new HttpError(400, 'Nothing to change');
  }

  const hub = getHub(env);
  if (title !== undefined) {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (!trimmed || trimmed.length > MAX_SESSION_TITLE_LENGTH) {
      throw new HttpError(
        400,
        `A title of up to ${MAX_SESSION_TITLE_LENGTH} characters is required`
      );
    }
    await hub.renameSession(record.id, trimmed);
  }
  if (archived !== undefined) {
    if (typeof archived !== 'boolean') {
      throw new HttpError(400, 'archived must be a boolean');
    }
    await hub.setSessionArchived(record.id, archived);
  }
  return json(await getSessionView(env, await requireSession(env, record.id)));
}

/**
 * Commit, push and optionally open a pull request for what the agent changed.
 *
 * Like aborting, this needs a container that is already running: the working
 * tree only exists inside one, and waking a session to publish would mean a cold
 * start between the button and the commit. The session page reads the changes
 * first, so by the time this is reachable the container is up.
 */
async function publishSession(
  request: Request,
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const input = await readPublishInput(request);
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    'publish changes from'
  );
  const result = await resolveSandbox(env, instance).publishSessionChanges(
    runtimeEpoch,
    input
  );
  return json(result);
}

async function readPublishInput(
  request: Request
): Promise<PublishSessionChangesInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const { message, branch, pullRequest } = value as {
    message?: unknown;
    branch?: unknown;
    pullRequest?: unknown;
  };
  const commitMessage = normalizeCommitMessage(message);
  if (!commitMessage) {
    throw new HttpError(
      400,
      `A commit message of up to ${MAX_COMMIT_MESSAGE_LENGTH} characters is required`
    );
  }
  if (branch !== undefined && !isSafeBranchName(branch)) {
    throw new HttpError(400, 'Invalid branch name');
  }
  return {
    message: commitMessage,
    ...(branch === undefined ? {} : { branch }),
    ...(pullRequest === undefined
      ? {}
      : { pullRequest: readPullRequestInput(pullRequest) })
  };
}

function readPullRequestInput(value: unknown): {
  title: string;
  body?: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'pullRequest must be a JSON object');
  }
  const { title, body } = value as { title?: unknown; body?: unknown };
  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed || trimmed.length > MAX_SESSION_TITLE_LENGTH * 4) {
    throw new HttpError(400, 'A pull request title is required');
  }
  if (
    body !== undefined &&
    (typeof body !== 'string' || body.length > MAX_PULL_REQUEST_BODY_LENGTH)
  ) {
    throw new HttpError(400, 'Invalid pull request body');
  }
  return {
    title: trimmed,
    ...(body === undefined ? {} : { body })
  };
}

/**
 * Browse the session's checkout: one directory, or one file's content.
 *
 * A passive read like the transcript — it needs a container that is already
 * running and never starts one — but unlike the transcript it has no mirror
 * behind it, so a sleeping session answers 409 and the panel says so.
 */
async function readSessionFiles(
  url: URL,
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    'browse files in'
  );
  const sandbox = resolveSandbox(env, instance);
  const path = url.searchParams.get('path') ?? '';
  try {
    return json(
      url.searchParams.get('read') === '1'
        ? await sandbox.readWorkspaceFile(runtimeEpoch, path)
        : await sandbox.listWorkspaceDirectory(runtimeEpoch, path)
    );
  } catch (error) {
    // A path that leaves the checkout is the caller's mistake, and so is asking
    // for a file that is not there. Neither is a container failure.
    const message = error instanceof Error ? error.message : String(error);
    if (/escapes the workspace|Invalid path|file path is required/i.test(message)) {
      throw new HttpError(400, message);
    }
    if (/not found|no such file|ENOENT/i.test(message)) {
      throw new HttpError(404, 'File not found');
    }
    throw error;
  }
}

/**
 * Attach a shell to the session's container over a WebSocket.
 *
 * The stock IDE's terminal was the last thing only it could do. This is the
 * same PTY the Sandbox SDK exposes, reached through the Hub's own origin so the
 * container gateway does not have to be public for it.
 *
 * Like the other container-bound routes it refuses a sleeping session rather
 * than waking one: a terminal is only useful attached, and a cold start behind
 * a socket that is already open reads as a hang.
 */
async function openSessionTerminal(
  request: Request,
  url: URL,
  env: Env,
  record: SessionRecord
): Promise<Response> {
  if (!isWebSocketUpgrade(request)) {
    throw new HttpError(400, 'The terminal endpoint requires a WebSocket upgrade');
  }
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    'open a terminal in'
  );
  const headers = stripAccessCredentials(new Headers(request.headers));
  headers.set(RUNTIME_EPOCH_HEADER, runtimeEpoch);
  return await resolveSandbox(env, instance).terminal(
    new Request(request, { headers }),
    {
      cols: readTerminalDimension(url.searchParams.get('cols'), 80),
      rows: readTerminalDimension(url.searchParams.get('rows'), 24)
    }
  );
}

function readTerminalDimension(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 500
    ? parsed
    : fallback;
}

/**
 * Hold the container open while a terminal is attached.
 *
 * The idle probe only sees OpenCode's execution state, so a shell running a
 * test suite looks exactly like an empty container. A work lease is how the
 * lifecycle is told otherwise; the terminal panel renews one on a timer, and
 * the lease is deliberately left to expire rather than being ended, so a closed
 * laptop lid releases the container on its own.
 */
async function keepSessionAwake(
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const { runtimeEpoch } = await requireAwakeRuntime(env, record, 'keep awake');
  const lease = await resolveLifecycle(env, record.instanceId).beginWork(
    runtimeEpoch
  );
  if (!lease.admitted) {
    throw new HttpError(409, 'This session is no longer running');
  }
  return json({ heldUntil: lease.expiresAt });
}

/**
 * Resolve the running container behind a session, or refuse.
 *
 * Aborting needs a container that is already up, and must not wake one: there
 * is nothing to interrupt in a sleeping session, so starting a container in
 * order to stop work in it would be the opposite of the request.
 */
async function requireAwakeRuntime(
  env: Env,
  record: SessionRecord,
  intent: string
): Promise<{ instance: InstanceRecord; runtimeEpoch: string }> {
  const instance = await getHub(env).getInstance(record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    throw new HttpError(409, `This session is not ready to ${intent}`);
  }
  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record.instanceId);
  if (!runtimeEpoch) {
    throw new HttpError(
      409,
      `This session is sleeping; wake it before trying to ${intent} it`
    );
  }
  return { instance, runtimeEpoch };
}

async function readSendPromptInput(request: Request): Promise<QueuePromptInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }

  const { prompt, model, variant, promptId } = value as {
    prompt?: unknown;
    model?: unknown;
    variant?: unknown;
    promptId?: unknown;
  };
  const text = normalizeSessionPrompt(prompt);
  if (!text) {
    throw new HttpError(400, 'A prompt of up to 32000 characters is required');
  }
  if (model !== undefined && !isModelRef(model)) {
    throw new HttpError(400, 'Unknown model');
  }
  // Variant is validated against the model that will actually run this prompt.
  // When the client omits model, the agent keeps the session's model, so a
  // bare variant cannot be checked here without reading the record — the agent
  // re-resolves it. An explicit pair is checked now so a bad UI choice 400s.
  if (model !== undefined && variant !== undefined && variant !== null && variant !== '') {
    if (!isValidVariant(model, variant)) {
      throw new HttpError(400, 'Unknown model variant');
    }
  } else if (
    model === undefined &&
    variant !== undefined &&
    variant !== null &&
    variant !== '' &&
    typeof variant !== 'string'
  ) {
    throw new HttpError(400, 'Unknown model variant');
  }
  if (promptId !== undefined && !isSafePromptId(promptId)) {
    throw new HttpError(400, 'Invalid prompt id');
  }
  return {
    prompt: text,
    ...(model === undefined ? {} : { model }),
    ...(typeof variant === 'string' && variant ? { variant } : {}),
    ...(promptId === undefined ? {} : { promptId })
  };
}

/**
 * Accept an explicit variant, or fall back to the model default when the model
 * has variants. Rejects a key the model does not list.
 */
function resolveRequestVariant(
  modelRef: string,
  variant: unknown
): string | undefined {
  if (variant === undefined || variant === null || variant === '') {
    return defaultVariantForModel(modelRef);
  }
  if (!isValidVariant(modelRef, variant)) {
    throw new HttpError(400, 'Unknown model variant');
  }
  return variant;
}

/**
 * Prompt ids come from the client, so they are bounded and constrained before
 * being persisted in the agent's queue.
 */
function isSafePromptId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Attach to a session's live event stream, without ever starting a container.
 *
 * The container publishes one server-wide stream, so the Worker reads it and
 * forwards only this session's frames. When there is nothing to attach to the
 * response is still a valid stream: it reports the state and closes, and the
 * browser's own reconnect is what eventually notices a wake.
 */
async function streamSessionEvents(
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const state: SessionStateEvent = {
    state: 'live',
    sessionId: record.id,
    ...(record.opencodeSessionId
      ? { opencodeSessionId: record.opencodeSessionId }
      : {}),
    at: new Date().toISOString()
  };

  if (!record.opencodeSessionId) {
    return closedSessionEventStream({ ...state, state: 'pending' });
  }
  const directory = sessionDirectory(record);
  const instance = await getHub(env).getInstance(record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return closedSessionEventStream({ ...state, state: 'sleeping' });
  }
  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record.instanceId);
  if (!runtimeEpoch) {
    return closedSessionEventStream({ ...state, state: 'sleeping' });
  }

  const target = new URL(`http://localhost:${OPENCODE_PORT}/event`);
  target.searchParams.set('directory', directory);
  const upstream = await resolveSandbox(env, instance).containerFetch(
    new Request(target.toString(), {
      headers: {
        accept: 'text/event-stream',
        [RUNTIME_EPOCH_HEADER]: runtimeEpoch
      }
    }),
    OPENCODE_PORT
  );

  if (!upstream.ok || !upstream.body) {
    // A runtime that stopped between the epoch read and this request answers
    // with the sleeping gate, which is a state and not a failure.
    await upstream.body?.cancel().catch(() => undefined);
    const gone = await isRuntimeGoneError(env, record.instanceId, runtimeEpoch);
    return closedSessionEventStream({
      ...state,
      state: gone ? 'sleeping' : 'error',
      ...(gone ? {} : { error: `Event stream unavailable (${upstream.status})` })
    });
  }

  return forwardSessionEventStream(upstream.body, state);
}

/**
 * Read a session's messages without ever starting a container.
 *
 * The session page and its polling are passive paths (see the lifecycle rules
 * in [lifecycle.ts](lifecycle.ts)): a stopped runtime is never woken to answer a
 * read. A running container is read live; a sleeping one is served from the R2
 * mirror the Sandbox exported on its way down (see
 * [transcript-mirror.ts](transcript-mirror.ts)), which is what makes a sleeping
 * session's history readable at all.
 */
async function readSessionTranscript(
  env: Env,
  record: SessionRecord
): Promise<SessionTranscript> {
  const observedAt = new Date().toISOString();
  const base = {
    sessionId: record.id,
    ...(record.opencodeSessionId
      ? { opencodeSessionId: record.opencodeSessionId }
      : {}),
    observedAt,
    messages: [] as SessionMessage[]
  };

  if (!record.opencodeSessionId) {
    // Dispatch has not reached `session.create` yet, so there is nothing to
    // read anywhere — not in a container and not in a mirror.
    return { ...base, state: 'pending', source: 'none' };
  }

  const directory = sessionDirectory(record);
  const instance = await getHub(env).getInstance(record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return sleepingTranscript(env, record, base);
  }

  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record.instanceId);
  if (!runtimeEpoch) {
    return sleepingTranscript(env, record, base);
  }

  try {
    const messages = await resolveSandbox(env, instance).listOpencodeSessionMessages(
      runtimeEpoch,
      {
        opencodeSessionId: record.opencodeSessionId,
        directory
      }
    );
    return { ...base, state: 'live', source: 'container', messages };
  } catch (error) {
    // The runtime can stop between the epoch read and the message read. That
    // race is a sleeping session, not a failure worth showing the user.
    const message = error instanceof Error ? error.message : String(error);
    if (await isRuntimeGoneError(env, record.instanceId, runtimeEpoch)) {
      return sleepingTranscript(env, record, base);
    }
    console.warn(`Failed to read session ${record.id} messages`, error);
    // A container that is up but unreadable still has a mirror behind it.
    // Showing the older history alongside the error beats showing nothing.
    const mirrored = await readTranscriptMirrorFor(env, record);
    return {
      ...base,
      ...(mirrored ?? { source: 'none' as const }),
      state: 'error',
      error: message
    };
  }
}

type TranscriptBase = Pick<
  SessionTranscript,
  'sessionId' | 'opencodeSessionId' | 'observedAt' | 'messages'
>;

/** A sleeping session answers from its mirror, or with nothing at all. */
async function sleepingTranscript(
  env: Env,
  record: SessionRecord,
  base: TranscriptBase
): Promise<SessionTranscript> {
  const mirrored = await readTranscriptMirrorFor(env, record);
  return { ...base, ...(mirrored ?? { source: 'none' }), state: 'sleeping' };
}

/**
 * The mirrored history for a session, if one exists for its current
 * conversation.
 *
 * The stored conversation id is compared with the record's: a mirror left over
 * from an earlier OpenCode session in the same instance is not this session's
 * history, and showing it would be worse than showing none.
 */
async function readTranscriptMirrorFor(
  env: Env,
  record: SessionRecord
): Promise<
  | { source: 'mirror'; mirroredAt: string; messages: SessionMessage[] }
  | undefined
> {
  try {
    const mirror = await getTranscriptMirror(env.BACKUP_BUCKET, record.id);
    if (!mirror || mirror.opencodeSessionId !== record.opencodeSessionId) {
      return undefined;
    }
    return {
      source: 'mirror',
      mirroredAt: mirror.mirroredAt,
      messages: mirror.messages
    };
  } catch (error) {
    console.warn(`Failed to read session ${record.id} transcript mirror`, error);
    return undefined;
  }
}

/**
 * The current runtime generation of an already-running container, or undefined.
 *
 * This never wakes anything: it only initializes the coordinator record (which
 * always starts `sleeping`) and reads its phase.
 */
async function resolveRunningRuntimeEpoch(
  env: Env,
  instanceId: string
): Promise<string | undefined> {
  try {
    const status = await ensureLifecycleInitialized(env, instanceId);
    return status.phase.startsWith('running_') ? status.runtimeEpoch : undefined;
  } catch (error) {
    console.warn(`Failed to read instance ${instanceId} lifecycle`, error);
    return undefined;
  }
}

/** Whether the runtime generation a failed read targeted is no longer current. */
async function isRuntimeGoneError(
  env: Env,
  instanceId: string,
  runtimeEpoch: string
): Promise<boolean> {
  return (await resolveRunningRuntimeEpoch(env, instanceId)) !== runtimeEpoch;
}

function resolveSessionAgent(env: Env, sessionId: string) {
  return env.SessionAgent.getByName(sessionId);
}
