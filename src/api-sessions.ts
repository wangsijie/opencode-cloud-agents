/**
 * Session API: the product-level unit of work.
 *
 * A session is one repository, one model and one prompt thread, mapped 1:1 onto
 * a container that sleeps independently. Creating one returns immediately; the
 * SessionAgent Durable Object performs the wake and the dispatch.
 */
import type { SessionProvider } from '../protocol/types.ts';
import { claimAttachmentUploads } from './api-uploads';
import { listSessionProviders } from './sandbox-providers';
import {
  HttpError,
  decodeRouteSegment,
  isSafeInstanceId,
  json,
  methodNotAllowed
} from './http';
import * as hubStore from './hub-store';
import {
  getInstanceView,
  resolveSandbox,
  unknownRuntimeStatus
} from './instance-access';
import { ensureLifecycleInitialized } from './instance-runtime';
import type { InstanceRecord, InstanceView } from './instances';
import { loadModelCatalog, type ModelCatalog } from './model-catalog';
import { isSafeRepoKey, workspaceDirectory } from './repos';
import { normalizeQuestionAction } from './question-requests';
import type { QueuePromptInput } from './session-agent';
import {
  closedSessionEventStream,
  forwardSessionEventStream,
  type SessionStateEvent
} from './session-events';
import { isSafeOpencodeSessionId } from './session-lineage';
import {
  CLEANED_SESSION_MESSAGE,
  deriveDisplayTitle,
  deriveLastActivityAt,
  deriveSessionStatus,
  deriveSessionTitle,
  isCleanedLifecycle,
  MAX_SESSION_TITLE_LENGTH,
  normalizeAttachmentKeys,
  normalizeSessionPrompt,
  type SessionAttachmentRef,
  type SessionMessage,
  type SessionRecord,
  type SessionTranscript,
  type SessionView
} from './sessions';
import { getTranscriptMirror } from './transcript-mirror';
import {
  workspaceDownloadBytes,
  workspaceDownloadDisposition
} from './workspace-files';

/**
 * Session API.
 *
 * The Hub creates a session, its instance, and its dispatch agent in one
 * request and returns immediately: waking the container, provisioning the
 * repository and starting the agent loop all happen in the SessionAgent alarm.
 */
export async function handleSessionApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/sessions') {
    if (request.method === 'GET') {
      const entries = await hubStore.listRegistry(env);
      return json(
        await Promise.all(
          entries.map(({ session, instance }) =>
            getSessionView(env, session, instance)
          )
        )
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
      const deleting = await hubStore.beginDelete(env, record.instanceId);
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

  // A subagent's session, addressed inside the session that started it. It is
  // only ever a read: the container reached the child through its own `task`
  // tool, and nothing outside that conversation may prompt it.
  const child = readChildSessionId(url);

  if (action === 'messages') {
    if (request.method === 'GET') {
      const transcript = await readSessionTranscript(env, record, child);
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
      if (child) {
        throw new HttpError(400, 'Subagent sessions are read-only');
      }
      return await sendSessionPrompt(request, env, record);
    }
    return methodNotAllowed('GET, POST');
  }

  if (action === 'changes') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    requireRepository(record, 'changes');
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
    return await streamSessionEvents(env, record, child);
  }

  if (action === 'agent-session') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await readAgentSession(env, record, child);
  }

  if (action === 'questions') {
    if (request.method === 'GET') {
      return await readPendingQuestions(env, record);
    }
    if (request.method === 'POST') {
      return await actOnQuestion(request, env, record);
    }
    return methodNotAllowed('GET, POST');
  }

  if (action === 'files') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return await readSessionFiles(url, env, record);
  }

  if (action === 'read') {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST');
    }
    return await acknowledgeSessionRead(request, env, record);
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
  if (record.phase === 'lost') {
    throw new HttpError(
      409,
      'This session was lost when its container restarted without a checkpoint. There is nothing left to retry into.'
    );
  }
  {
    const instance = await hubStore.getInstance(env, record.instanceId);
    if (instance && isCleanedLifecycle(instance.lifecycle)) {
      throw new HttpError(409, CLEANED_SESSION_MESSAGE);
    }
  }
  await resolveSessionAgent(env, record.id).retrySession();
  return json(await getSessionView(env, await requireSession(env, record.id)), 202);
}

/**
 * Start a session: validate the request, then make exactly one durable write.
 *
 * Everything a session is made of — its registry row, its container's identity,
 * the wake, the clone, the first prompt — is the SessionAgent's work, performed
 * on an alarm this call only schedules. So the whole of the request the user is
 * waiting on is three config reads and one Durable Object write, and closing
 * the tab the moment after pressing Enter cannot leave a session half-made:
 * either the write landed and the session runs on its own, or it did not and
 * nothing was created.
 *
 * The response is synthesized from the same intent rather than read back, which
 * is what lets it come before the row exists. It reports a queued dispatch on a
 * container that has not been asked to do anything yet — true, and exactly what
 * the session page renders as a cold start.
 */
async function createSession(request: Request, env: Env): Promise<Response> {
  // The model catalog is stored config now, so it is read once per request
  // that validates against it, not on every poll.
  const catalog = await loadModelCatalog(env);
  // Which hosts this deployment can actually place a session on. Read per
  // create — the answer is two settings rows and creates are rare — so that
  // configuring the Docker agent takes effect without a redeploy.
  const providers = await listSessionProviders(env);
  const input = await readCreateSessionInput(request, env, catalog, providers);
  // Resolved against GitHub's catalog once, here, and then pinned onto the
  // records — so nothing this session does later needs the catalog again. A
  // request without a repository skips the catalog entirely: there is nothing
  // to clone and the session works in /workspace.
  const repo = input.repoKey
    ? await hubStore.findCatalogRepo(env, input.repoKey)
    : undefined;
  if (input.repoKey && !repo) {
    throw new HttpError(400, 'Unknown repository');
  }

  const session = hubStore.buildNewSession(
    {
      ...(repo ? { repo } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      title: deriveSessionTitle(input.prompt)
    },
    catalog
  );
  const { record } = session;
  await resolveSessionAgent(env, record.id).startSession({
    sessionId: record.id,
    instanceId: record.instanceId,
    instanceName: session.name,
    provider: record.provider,
    ...(record.repoKey ? { repoKey: record.repoKey } : {}),
    ...(repo ? { repo } : {}),
    directory: workspaceDirectory(repo?.repoKey),
    model: record.model,
    ...(record.variant ? { variant: record.variant } : {}),
    title: record.title,
    createdAt: record.createdAt,
    prompt: input.prompt,
    promptId: crypto.randomUUID(),
    ...(input.attachments.length > 0 ? { attachments: input.attachments } : {})
  });
  return json(provisionalSessionView(session), 202);
}

/**
 * The session view for a session whose container has not been created yet.
 *
 * Synthesized rather than read: this is the answer to the create request, and
 * reading it back would mean waiting for writes that deliberately happen after
 * it. The runtime reads as a sleeping container, which is what an instance that
 * has never been woken is — `unknownRuntimeStatus` is not usable here because
 * its lifecycle is `error`, and an unstarted session is not a broken one.
 */
function provisionalSessionView(session: hubStore.NewSession): SessionView {
  const { record } = session;
  return {
    ...record,
    instance: {
      id: record.instanceId,
      name: session.name,
      ...(record.repoKey ? { repoKey: record.repoKey } : {}),
      ...(session.repo ? { repo: session.repo } : {}),
      provider: record.provider,
      lifecycle: 'ready',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      runtime: {
        container: 'unknown',
        provider: record.provider,
        platformRunning: false,
        deleting: false,
        lifecycle: 'sleeping',
        persistence: { hasBackup: false, trackedBackupCount: 0 }
      }
    },
    status: 'queued',
    lastActivityAt: deriveLastActivityAt(record),
    displayTitle: deriveDisplayTitle(record)
  };
}

interface CreateSessionInput {
  /** Absent when the session is to work in `/workspace` with no checkout. */
  repoKey?: string;
  /** Which sandbox host should run the container; absent means preferred (providers[0]). */
  provider?: SessionProvider;
  model: string;
  variant?: string;
  prompt: string;
  /** Images already in R2, claimed from the uploads the composer made. */
  attachments: SessionAttachmentRef[];
}

/**
 * Resolve the `attachments` field of a request body: the keys of uploads the
 * composer already made. The bytes never travel through here, so a prompt with
 * four images is the same small request as one with none.
 */
async function readAttachmentsField(
  env: Env,
  value: object
): Promise<SessionAttachmentRef[]> {
  const keys = normalizeAttachmentKeys(
    (value as { attachments?: unknown }).attachments
  );
  if (keys === undefined) {
    throw new HttpError(400, 'Attachments must be up to 4 uploaded images');
  }
  return await claimAttachmentUploads(env, keys);
}

async function readCreateSessionInput(
  request: Request,
  env: Env,
  catalog: ModelCatalog,
  providers: SessionProvider[]
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

  const { repoKey, model, variant, prompt, provider } = value as {
    repoKey?: unknown;
    model?: unknown;
    variant?: unknown;
    prompt?: unknown;
    provider?: unknown;
  };
  // Only the shape is checked here; whether the key names a real repository is
  // the catalog's answer, and the catalog is asynchronous now. Omitting the
  // field — or sending an empty one, which is what the composer's "No
  // repository" choice submits — asks for a session with no checkout.
  const wantsRepo = repoKey !== undefined && repoKey !== null && repoKey !== '';
  if (wantsRepo && !isSafeRepoKey(repoKey)) {
    throw new HttpError(400, 'Unknown repository');
  }
  const modelRef = model === undefined ? catalog.defaultModelRef : model;
  if (!catalog.isModelRef(modelRef)) {
    throw new HttpError(400, 'Unknown model');
  }
  const resolvedVariant = resolveRequestVariant(catalog, modelRef, variant);
  const text = normalizeSessionPrompt(prompt);
  if (!text) {
    throw new HttpError(400, 'A prompt of up to 32000 characters is required');
  }
  // Omitting the field takes the preferred host — providers[0], which is
  // docker when configured and otherwise cloudflare. An explicit value that
  // is not on offer is refused here so the session is never created on a host
  // that cannot wake.
  const wantsProvider =
    provider === undefined || provider === null
      ? providers[0]
      : (provider as SessionProvider);
  if (wantsProvider === undefined || !providers.includes(wantsProvider)) {
    throw new HttpError(400, 'Unknown provider');
  }
  return {
    ...(wantsRepo ? { repoKey: repoKey as string } : {}),
    provider: wantsProvider,
    model: modelRef,
    ...(resolvedVariant ? { variant: resolvedVariant } : {}),
    prompt: text,
    attachments: await readAttachmentsField(env, value)
  };
}

/**
 * Where this session works inside its container.
 *
 * Pinned on the record since the catalog became dynamic, and derivable from the
 * key alone before that — which is what lets a session outlive the catalog
 * entry it was created from, and the catalog being unreachable entirely. A
 * session created without a repository has no checkout: it is the workspace
 * root.
 */
function sessionDirectory(record: SessionRecord): string {
  return record.directory ?? workspaceDirectory(record.repoKey);
}

/**
 * The subagent session a read is aimed at, if any.
 *
 * A query parameter rather than a path segment: the session routes allow one
 * action after the id, and a child is a narrowing of an existing read rather
 * than a new kind of one. `?child=` therefore reads the same on `messages`,
 * `events` and `agent-session` without any of them growing a second shape.
 */
function readChildSessionId(url: URL): string | undefined {
  const child = url.searchParams.get('child');
  if (child === null) {
    return undefined;
  }
  if (!isSafeOpencodeSessionId(child)) {
    throw new HttpError(400, 'Invalid subagent session id');
  }
  return child;
}

/**
 * Where a subagent session sits under the session that owns its container.
 *
 * This is the breadcrumb's source, and the check that the id belongs here at
 * all. Unlike the transcript it needs a running container — the lineage lives
 * in OpenCode's own session store and the Hub mirrors none of it — so a
 * sleeping session answers 409 the way the diff and the file browser do, and
 * the page falls back to a breadcrumb it can build without this.
 */
async function readAgentSession(
  env: Env,
  record: SessionRecord,
  child: string | undefined
): Promise<Response> {
  if (!child) {
    throw new HttpError(400, 'A subagent session id is required');
  }
  if (!record.opencodeSessionId) {
    throw new HttpError(404, 'This session has no conversation yet');
  }
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    'read a subagent from'
  );
  const lineage = await resolveSandbox(env, instance).getOpencodeSessionLineage(
    runtimeEpoch,
    {
      opencodeSessionId: child,
      rootOpencodeSessionId: record.opencodeSessionId,
      directory: sessionDirectory(record)
    }
  );
  if (!lineage) {
    throw new HttpError(404, 'Subagent session not found in this session');
  }
  return json(lineage);
}

/**
 * Refuse the git-shaped reads and writes on a session that has no checkout.
 *
 * The container would refuse them too, but it would do it by running git in a
 * directory that is not a repository — so the answer arrives as git's message
 * and costs a wake. This is the same answer, before either.
 */
function requireRepository(record: SessionRecord, intent: string): void {
  if (!record.repoKey) {
    throw new HttpError(
      409,
      `This session was created without a repository, so it has no ${intent}`
    );
  }
}

/**
 * The session this route is about.
 *
 * A session becomes durable in its SessionAgent before it reaches the registry,
 * so between the create response and the agent's first alarm there is a moment
 * where the id the client holds names a session no row describes. Asking the
 * agent to register itself closes that window on first contact — the page that
 * navigated straight into the new session is normally what does it — instead of
 * answering 404 for a session that certainly exists.
 *
 * Only a session no agent has ever heard of is missing.
 */
async function requireSession(env: Env, id: string): Promise<SessionRecord> {
  if (!isSafeInstanceId(id)) {
    throw new HttpError(400, 'Invalid session id');
  }
  const record = await hubStore.getSession(env, id);
  if (record) {
    return record;
  }
  if (await resolveSessionAgent(env, id).ensureRegistered()) {
    const registered = await hubStore.getSession(env, id);
    if (registered) {
      return registered;
    }
  }
  throw new HttpError(404, 'Session not found');
}

async function getSessionView(
  env: Env,
  record: SessionRecord,
  // The list route reads sessions and instances as pairs from one query; every
  // other caller lets the instance be looked up here.
  instance?: InstanceRecord
): Promise<SessionView> {
  instance ??= await hubStore.getInstance(env, record.instanceId);
  const view: InstanceView = instance
    ? await getInstanceView(env, instance)
    : {
        id: record.instanceId,
        name: record.instanceId,
        ...(record.repoKey ? { repoKey: record.repoKey } : {}),
        provider: record.provider,
        lifecycle: 'deleting',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        runtime: unknownRuntimeStatus(true, record.provider)
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
    status: deriveSessionStatus(record.phase, view.runtime, view.lifecycle),
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
  const updated = await hubStore
    .updateSession(env, record.id, { phase: 'lost', lastError })
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
  const input = await readSendPromptInput(
    request,
    env,
    await loadModelCatalog(env)
  );
  if (record.phase === 'lost') {
    // The conversation this session names is gone from the container. A message
    // sent here would either 404 or open a different conversation under this
    // session's name; both are worse than saying so.
    throw new HttpError(
      409,
      'This session was lost when its container restarted without a checkpoint. Start a new session to continue.'
    );
  }
  const instance = await hubStore.getInstance(env, record.instanceId);
  if (instance && isCleanedLifecycle(instance.lifecycle)) {
    throw new HttpError(409, CLEANED_SESSION_MESSAGE);
  }
  if (!instance || instance.lifecycle !== 'ready') {
    // A container being deleted is the one state no amount of waking fixes.
    throw new HttpError(409, 'This session is not ready to receive messages');
  }
  const { attachments, ...prompt } = input;
  // A client that retries must not queue a second prompt, so the id is fixed
  // here when it did not supply one.
  const promptId = prompt.promptId ?? crypto.randomUUID();
  await resolveSessionAgent(env, record.id).queuePrompt({
    ...prompt,
    promptId,
    ...(attachments.length > 0 ? { attachments } : {})
  });
  // Sending a message is proof the user has seen where the conversation stands.
  await hubStore.clearSessionUnread(env, record.id).catch(() => undefined);
  return json(await getSessionView(env, await requireSession(env, record.id)), 202);
}

/**
 * Acknowledge that the user has looked at this session.
 *
 * The body names the `unreadAt` value the client saw, and only that marker is
 * cleared: an agent stop that lands between the client's read and this write
 * keeps the session unread, which is the truth.
 */
async function acknowledgeSessionRead(
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
  const seenAt = (value as { seenAt?: unknown } | null)?.seenAt;
  if (typeof seenAt !== 'string' || seenAt.length === 0) {
    throw new HttpError(400, 'Expected { seenAt }: the unreadAt value being acknowledged');
  }
  await hubStore.markSessionRead(env, record.id, seenAt);
  return json({ ok: true });
}

/**
 * The question requests currently waiting for a human in this session.
 *
 * A passive probe the UI attaches to every `question` tool part it shows as
 * `running`, so it must never wake a container and must not turn history
 * browsing into error banners: a session that is asleep — where no request can
 * be pending, because requests live in the OpenCode server's memory — answers
 * `sleeping` with an empty list rather than 409. The caller matches a request
 * to its tool part by `tool.callID`.
 */
async function readPendingQuestions(
  env: Env,
  record: SessionRecord
): Promise<Response> {
  const asleep = json({ state: 'sleeping', questions: [] });
  const instance = await hubStore.getInstance(env, record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return asleep;
  }
  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record);
  if (!runtimeEpoch) {
    return asleep;
  }
  try {
    const questions = await resolveSandbox(env, instance).listOpencodeQuestions(
      runtimeEpoch,
      { directory: sessionDirectory(record) }
    );
    return json({ state: 'live', questions });
  } catch (error) {
    // The runtime can stop between the epoch read and the list read; that race
    // is a sleeping session, not a failure worth a banner.
    if (await isRuntimeGoneError(env, record, runtimeEpoch)) {
      return asleep;
    }
    throw error;
  }
}

/**
 * Answer or dismiss one pending question request.
 *
 * Unlike the list this is an explicit act on a running conversation, so a
 * sleeping session refuses with the usual 409 — there is nothing pending in a
 * stopped container, and waking one would not bring the request back.
 */
async function actOnQuestion(
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
  const input = normalizeQuestionAction(value);
  if (!input) {
    throw new HttpError(
      400,
      'Expected { requestID, answers } to answer or { requestID, reject: true } to dismiss'
    );
  }
  const { instance, runtimeEpoch } = await requireAwakeRuntime(
    env,
    record,
    input.kind === 'reject' ? 'dismiss a question in' : 'answer a question in'
  );
  const sandbox = resolveSandbox(env, instance);
  const directory = sessionDirectory(record);
  try {
    if (input.kind === 'reject') {
      await sandbox.rejectOpencodeQuestion(runtimeEpoch, {
        requestId: input.requestId,
        directory
      });
    } else {
      await sandbox.replyOpencodeQuestion(runtimeEpoch, {
        requestId: input.requestId,
        directory,
        answers: input.answers
      });
    }
  } catch (error) {
    // A request somebody else already answered — or one that died with its
    // container — reports as not-found from OpenCode. That is a state, and the
    // UI reacts by re-reading the transcript, not an internal failure.
    const message = error instanceof Error ? error.message : String(error);
    if (/QuestionNotFound/i.test(message)) {
      throw new HttpError(409, 'This question is no longer pending');
    }
    throw error;
  }
  // Answering or dismissing a question is proof the user has seen it.
  await hubStore.clearSessionUnread(env, record.id).catch(() => undefined);
  return json({ ok: true });
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
 * Rename a session.
 *
 * A registry edit: it does not touch the container, so it works whether the
 * session is awake, asleep, or has never started.
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
  const { title } = value as { title?: unknown };
  if (title === undefined) {
    throw new HttpError(400, 'Nothing to change');
  }

  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed || trimmed.length > MAX_SESSION_TITLE_LENGTH) {
    throw new HttpError(
      400,
      `A title of up to ${MAX_SESSION_TITLE_LENGTH} characters is required`
    );
  }
  await hubStore.renameSession(env, record.id, trimmed);
  return json(await getSessionView(env, await requireSession(env, record.id)));
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
    if (url.searchParams.get('download') === '1') {
      const download = await sandbox.downloadWorkspaceFile(runtimeEpoch, path);
      // Always an opaque attachment: serving repository content as a renderable
      // type from the Hub's own origin would hand it the admin cookie's scope.
      return new Response(workspaceDownloadBytes(download), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': workspaceDownloadDisposition(download.path),
          'x-content-type-options': 'nosniff'
        }
      });
    }
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
  const instance = await hubStore.getInstance(env, record.instanceId);
  if (instance && isCleanedLifecycle(instance.lifecycle)) {
    throw new HttpError(409, CLEANED_SESSION_MESSAGE);
  }
  if (!instance || instance.lifecycle !== 'ready') {
    throw new HttpError(409, `This session is not ready to ${intent}`);
  }
  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record);
  if (!runtimeEpoch) {
    throw new HttpError(
      409,
      `This session is sleeping; wake it before trying to ${intent} it`
    );
  }
  return { instance, runtimeEpoch };
}

/** A send-message body: the queue input plus the images already uploaded. */
interface SendPromptRequest extends Omit<QueuePromptInput, 'attachments'> {
  attachments: SessionAttachmentRef[];
}

async function readSendPromptInput(
  request: Request,
  env: Env,
  catalog: ModelCatalog
): Promise<SendPromptRequest> {
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
  if (model !== undefined && !catalog.isModelRef(model)) {
    throw new HttpError(400, 'Unknown model');
  }
  // Variant is validated against the model that will actually run this prompt.
  // When the client omits model, the agent keeps the session's model, so a
  // bare variant cannot be checked here without reading the record — the agent
  // re-resolves it. An explicit pair is checked now so a bad UI choice 400s.
  if (model !== undefined && variant !== undefined && variant !== null && variant !== '') {
    if (!catalog.isValidVariant(model, variant)) {
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
    ...(promptId === undefined ? {} : { promptId }),
    attachments: await readAttachmentsField(env, value)
  };
}

/**
 * Accept an explicit variant, or fall back to the model default when the model
 * has variants. Rejects a key the model does not list.
 */
function resolveRequestVariant(
  catalog: ModelCatalog,
  modelRef: string,
  variant: unknown
): string | undefined {
  if (variant === undefined || variant === null || variant === '') {
    return catalog.defaultVariantForModel(modelRef);
  }
  if (!catalog.isValidVariant(modelRef, variant)) {
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
 *
 * `child` narrows the same stream to a subagent's session instead. The filter
 * is an equality test on the frame's own session id, so watching a child is
 * the same code with a different id — and the parent's own frames, including
 * the `task` tool part that reports the subagent's progress, keep flowing to
 * whoever is watching the parent.
 */
async function streamSessionEvents(
  env: Env,
  record: SessionRecord,
  child?: string
): Promise<Response> {
  const watched = child ?? record.opencodeSessionId;
  const state: SessionStateEvent = {
    state: 'live',
    sessionId: record.id,
    ...(watched ? { opencodeSessionId: watched } : {}),
    at: new Date().toISOString()
  };

  if (!watched) {
    return closedSessionEventStream({ ...state, state: 'pending' });
  }
  const directory = sessionDirectory(record);
  const instance = await hubStore.getInstance(env, record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return closedSessionEventStream({ ...state, state: 'sleeping' });
  }
  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record);
  if (!runtimeEpoch) {
    return closedSessionEventStream({ ...state, state: 'sleeping' });
  }

  const upstream = await resolveSandbox(env, instance).streamOpencodeEvents(
    runtimeEpoch,
    directory
  );

  if (!upstream.ok || !upstream.body) {
    // A runtime that stopped between the epoch read and this request answers
    // with the sleeping gate, which is a state and not a failure.
    await upstream.body?.cancel().catch(() => undefined);
    const gone = await isRuntimeGoneError(env, record, runtimeEpoch);
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
 *
 * A subagent's transcript (`child`) is the same read against a different
 * OpenCode session id, with one difference: the mirror holds only the root
 * conversation, so a sleeping container has no subagent history to fall back
 * on. Serving the root's mirror under a child's name would be the wrong
 * conversation entirely, so those reads answer `sleeping` with nothing, and
 * the page says so.
 */
async function readSessionTranscript(
  env: Env,
  record: SessionRecord,
  child?: string
): Promise<SessionTranscript> {
  const observedAt = new Date().toISOString();
  const target = child ?? record.opencodeSessionId;
  const base = {
    sessionId: record.id,
    ...(target ? { opencodeSessionId: target } : {}),
    observedAt,
    messages: [] as SessionMessage[]
  };
  // Only the root conversation is mirrored; a subagent read has no history
  // behind it and says `none` rather than borrowing the parent's.
  const asleep = (): Promise<SessionTranscript> | SessionTranscript =>
    child
      ? { ...base, state: 'sleeping', source: 'none' }
      : sleepingTranscript(env, record, base);

  if (!target) {
    // Dispatch has not reached `session.create` yet, so there is nothing to
    // read anywhere — not in a container and not in a mirror.
    return { ...base, state: 'pending', source: 'none' };
  }

  const directory = sessionDirectory(record);
  const instance = await hubStore.getInstance(env, record.instanceId);
  if (!instance || instance.lifecycle !== 'ready') {
    return await asleep();
  }

  const runtimeEpoch = await resolveRunningRuntimeEpoch(env, record);
  if (!runtimeEpoch) {
    return await asleep();
  }

  try {
    const messages = await resolveSandbox(env, instance).listOpencodeSessionMessages(
      runtimeEpoch,
      {
        opencodeSessionId: target,
        directory
      }
    );
    return { ...base, state: 'live', source: 'container', messages };
  } catch (error) {
    // The runtime can stop between the epoch read and the message read. That
    // race is a sleeping session, not a failure worth showing the user.
    const message = error instanceof Error ? error.message : String(error);
    if (await isRuntimeGoneError(env, record, runtimeEpoch)) {
      return await asleep();
    }
    console.warn(`Failed to read session ${record.id} messages`, error);
    // A container that is up but unreadable still has a mirror behind it.
    // Showing the older history alongside the error beats showing nothing.
    const mirrored = child ? undefined : await readTranscriptMirrorFor(env, record);
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
    const mirror = await getTranscriptMirror(env.SESSION_BUCKET, record.id);
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
  record: SessionRecord
): Promise<string | undefined> {
  try {
    const status = await ensureLifecycleInitialized(
      env,
      record.instanceId,
      undefined,
      record.provider
    );
    return status.phase.startsWith('running_') ? status.runtimeEpoch : undefined;
  } catch (error) {
    console.warn(`Failed to read instance ${record.instanceId} lifecycle`, error);
    return undefined;
  }
}

/** Whether the runtime generation a failed read targeted is no longer current. */
async function isRuntimeGoneError(
  env: Env,
  record: SessionRecord,
  runtimeEpoch: string
): Promise<boolean> {
  return (await resolveRunningRuntimeEpoch(env, record)) !== runtimeEpoch;
}

function resolveSessionAgent(env: Env, sessionId: string) {
  return env.SessionAgent.getByName(sessionId);
}
