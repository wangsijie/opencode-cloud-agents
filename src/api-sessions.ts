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
  json,
  methodNotAllowed
} from './http';
import {
  getHub,
  getInstanceView,
  resolveSandbox,
  unknownRuntimeStatus
} from './instance-access';
import {
  ensureLifecycleInitialized,
  OPENCODE_PORT,
  RUNTIME_EPOCH_HEADER
} from './instance-runtime';
import type { InstanceRecord, InstanceView } from './instances';
import { DEFAULT_MODEL_REF, isModelRef } from './opencode-config';
import { findRepo, isRepoKey, repoWorkspaceDirectory } from './repos';
import type { QueuePromptInput } from './session-agent';
import {
  closedSessionEventStream,
  forwardSessionEventStream,
  type SessionStateEvent
} from './session-events';
import {
  deriveLastActivityAt,
  deriveSessionStatus,
  deriveSessionTitle,
  normalizeSessionPrompt,
  type SessionMessage,
  type SessionRecord,
  type SessionTranscript,
  type SessionView
} from './sessions';

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

  if (action === 'messages') {
    if (request.method === 'GET') {
      const transcript = await readSessionTranscript(env, record);
      return json(transcript, 200, {
        'X-OpenCode-Hub-Transcript-State': transcript.state,
        'X-OpenCode-Hub-Transcript-Source': transcript.source,
        'X-OpenCode-Hub-Transcript-At': transcript.observedAt
      });
    }
    if (request.method === 'POST') {
      return await sendSessionPrompt(request, env, record);
    }
    return methodNotAllowed('GET, POST');
  }

  if (action === 'events') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await streamSessionEvents(env, record);
  }

  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  if (action === 'abort') {
    return await abortSession(env, record);
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
  return {
    ...record,
    instance: view,
    status: deriveSessionStatus(record.phase, view.runtime),
    lastActivityAt: deriveLastActivityAt(record)
  };
}

/**
 * Continue an existing conversation.
 *
 * The prompt goes onto the SessionAgent's durable queue, the same path the
 * opening prompt takes: prompts leave that queue one at a time, so messages
 * sent in quick succession arrive in order and a retried request carrying the
 * same `promptId` is not delivered twice.
 *
 * M3 requires the container to already be awake. The queue would happily wake
 * it — that is exactly what the agent does on dispatch — but sending to a
 * sleeping session means a wake the user waits on, and the progress UI for that
 * is M5. Until then this reports the state instead of starting a silent
 * minute-long wake behind an unchanged page.
 *
 * The check is therefore a product decision, not a guarantee: a container that
 * stops in the gap between it and the dispatch is still woken by the agent.
 * That race is harmless, and M5 makes it the normal path.
 */
async function sendSessionPrompt(
  request: Request,
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const input = await readSendPromptInput(request);
  await requireAwakeRuntime(env, record, 'send a message to');
  await resolveSessionAgent(env, record.id).queuePrompt(input);
  return json(await getSessionView(env, await requireSession(env, record.id)), 202);
}

/** Stop the agent mid-run, leaving the conversation intact. */
async function abortSession(env: Env, record: SessionRecord): Promise<Response> {
  if (!record.opencodeSessionId) {
    throw new HttpError(409, 'This session has not started working yet');
  }
  const repo = findRepo(record.repoKey);
  if (!repo) {
    throw new HttpError(400, `Unknown repository ${record.repoKey}`);
  }
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    'abort'
  );

  const aborted = await resolveSandbox(env, instance).abortOpencodeSession(
    runtimeEpoch,
    {
      opencodeSessionId: record.opencodeSessionId,
      directory: repoWorkspaceDirectory(repo)
    }
  );
  return json({
    aborted,
    session: await getSessionView(env, await requireSession(env, record.id))
  });
}

/**
 * Resolve the running container behind a session, or refuse.
 *
 * Both writing paths need a container that is already up: neither may wake one,
 * because a wake takes long enough that the caller has to be told about it, and
 * that conversation belongs to M5.
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

  const { prompt, model, promptId } = value as {
    prompt?: unknown;
    model?: unknown;
    promptId?: unknown;
  };
  const text = normalizeSessionPrompt(prompt);
  if (!text) {
    throw new HttpError(400, 'A prompt of up to 32000 characters is required');
  }
  if (model !== undefined && !isModelRef(model)) {
    throw new HttpError(400, 'Unknown model');
  }
  if (promptId !== undefined && !isSafePromptId(promptId)) {
    throw new HttpError(400, 'Invalid prompt id');
  }
  return {
    prompt: text,
    ...(model === undefined ? {} : { model }),
    ...(promptId === undefined ? {} : { promptId })
  };
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
  const repo = findRepo(record.repoKey);
  if (!repo) {
    return closedSessionEventStream({
      ...state,
      state: 'error',
      error: `Unknown repository ${record.repoKey}`
    });
  }

  const instance = await getHub(env).getInstance(record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return closedSessionEventStream({ ...state, state: 'sleeping' });
  }
  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record.instanceId);
  if (!runtimeEpoch) {
    return closedSessionEventStream({ ...state, state: 'sleeping' });
  }

  const target = new URL(`http://localhost:${OPENCODE_PORT}/event`);
  target.searchParams.set('directory', repoWorkspaceDirectory(repo));
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
 * in [lifecycle.ts](lifecycle.ts)): a stopped runtime reports `sleeping` and an
 * empty transcript rather than waking. Reading a sleeping session's history
 * lands in M4, when the quiesce pipeline mirrors transcripts to R2.
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
    // read anywhere — not even a mirror once M4 exists.
    return { ...base, state: 'pending', source: 'none' };
  }

  const repo = findRepo(record.repoKey);
  if (!repo) {
    return {
      ...base,
      state: 'error',
      source: 'none',
      error: `Unknown repository ${record.repoKey}`
    };
  }

  const instance = await getHub(env).getInstance(record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return { ...base, state: 'sleeping', source: 'none' };
  }

  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record.instanceId);
  if (!runtimeEpoch) {
    return { ...base, state: 'sleeping', source: 'none' };
  }

  try {
    const messages = await resolveSandbox(env, instance).listOpencodeSessionMessages(
      runtimeEpoch,
      {
        opencodeSessionId: record.opencodeSessionId,
        directory: repoWorkspaceDirectory(repo)
      }
    );
    return { ...base, state: 'live', source: 'container', messages };
  } catch (error) {
    // The runtime can stop between the epoch read and the message read. That
    // race is a sleeping session, not a failure worth showing the user.
    const message = error instanceof Error ? error.message : String(error);
    if (await isRuntimeGoneError(env, record.instanceId, runtimeEpoch)) {
      return { ...base, state: 'sleeping', source: 'none' };
    }
    console.warn(`Failed to read session ${record.id} messages`, error);
    return { ...base, state: 'error', source: 'none', error: message };
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
