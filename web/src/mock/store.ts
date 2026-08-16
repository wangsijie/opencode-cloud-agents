/**
 * The in-memory backend behind the mock router.
 *
 * Holds every fixture session plus the little state machines that make the app
 * feel alive: a forever-streaming reply loop on `ses_working`, a scripted boot
 * for queued/new sessions, a wake for prompts sent to sleeping ones, and an
 * idle countdown that really puts containers to sleep. Everything resets on
 * reload — that is the point.
 */
import type {
  MessageAttachment,
  MessagePart,
  SessionMessage,
  SessionProvider,
  SessionUsage,
  SessionView,
  Transcript
} from '../api';
import { emitOpencode } from './events';
import { buildCatalog } from './fixtures/catalog';
import { buildFixtureSessions } from './fixtures/sessions';
import { buildSettings } from './fixtures/settings';
import { minutesAgo } from './fixtures/util';
import type { MockSessionState } from './types';

export const store = {
  authenticated: true,
  sessions: new Map<string, MockSessionState>(),
  settings: buildSettings(),
  catalog: buildCatalog(),
  /**
   * Uploaded images by key, standing in for R2: the composer uploads when a
   * file is picked and a prompt later names the keys.
   */
  uploads: new Map<string, MockUpload>(),
  /** The opencode.config save warning is shown once, then considered read. */
  configWarningPending: true
};

export interface MockUpload {
  mime: string;
  filename?: string;
  /** What the transcript renders, in place of a real R2 read. */
  dataUrl: string;
  size: number;
}

for (const session of buildFixtureSessions()) {
  store.sessions.set(session.view.id, session);
}

/** Runtime states in which the container serves the conversation live. */
export function attached(view: SessionView): boolean {
  const lifecycle = view.instance.runtime.lifecycle;
  return lifecycle === 'busy' || lifecycle === 'idle';
}

export function transcriptFor(
  session: MockSessionState,
  child: string | undefined
): Transcript | undefined {
  if (child) {
    const messages = session.childTranscripts[child];
    if (!messages) {
      return undefined;
    }
    // Subagent history has no mirror behind it: awake serves it live, asleep
    // has nothing to say — which is what drives the wake banner.
    return attached(session.view)
      ? { state: 'live', source: 'container', messages }
      : { state: 'sleeping', source: 'none', messages: [] };
  }
  if (attached(session.view)) {
    return { state: 'live', source: 'container', messages: session.transcript };
  }
  if (session.transcript.length > 0) {
    return {
      state: 'sleeping',
      source: 'mirror',
      mirroredAt: session.mirroredAt ?? session.view.lastActivityAt,
      messages: session.transcript
    };
  }
  return { state: 'pending', source: 'none', messages: [] };
}

// ---------------------------------------------------------------------------
// Scripted lifecycle machinery

let messageSeq = 5000;
let partSeq = 5000;
let sessionSeq = 0;

const nextMessageId = () => `msg_${++messageSeq}`;
const nextPartId = () => `prt_${++partSeq}`;
export const nextSessionId = () => `ses_new_${++sessionSeq}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface RunToken {
  cancelled: boolean;
}

/** One active script per session; starting a new one cancels the old. */
const runTokens = new Map<string, RunToken>();

function newRun(id: string): RunToken {
  const previous = runTokens.get(id);
  if (previous) {
    previous.cancelled = true;
  }
  const token = { cancelled: false };
  runTokens.set(id, token);
  return token;
}

export function cancelRun(id: string): void {
  const token = runTokens.get(id);
  if (token) {
    token.cancelled = true;
  }
}

function touch(session: MockSessionState): void {
  session.view.lastActivityAt = new Date().toISOString();
}

function emitInfo(session: MockSessionState, info: SessionMessage['info']): void {
  emitOpencode(session.view.id, undefined, {
    type: 'message.updated',
    properties: { info: { ...info, time: info.time ? { ...info.time } : undefined } }
  });
}

function upsertPart(
  session: MockSessionState,
  messageId: string,
  part: MessagePart
): void {
  const message = session.transcript.find((entry) => entry.info.id === messageId);
  if (message) {
    const index = message.parts.findIndex((entry) => entry.id === part.id);
    if (index === -1) {
      message.parts.push(part);
    } else {
      message.parts[index] = part;
    }
  }
  emitOpencode(session.view.id, undefined, {
    type: 'message.part.updated',
    properties: { part: { ...part } }
  });
}

function bumpUsage(session: MockSessionState, delta: Partial<SessionUsage>): void {
  const current: SessionUsage = session.view.transcript?.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    assistantMessages: 0
  };
  const usage: SessionUsage = {
    inputTokens: current.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: current.outputTokens + (delta.outputTokens ?? 0),
    reasoningTokens: current.reasoningTokens + (delta.reasoningTokens ?? 0),
    cacheReadTokens: current.cacheReadTokens + (delta.cacheReadTokens ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (delta.cacheWriteTokens ?? 0),
    cost: Math.round((current.cost + (delta.cost ?? 0)) * 10_000) / 10_000,
    assistantMessages: current.assistantMessages + (delta.assistantMessages ?? 0)
  };
  session.view.transcript = {
    mirroredAt: session.view.transcript?.mirroredAt ?? new Date().toISOString(),
    messageCount: session.transcript.length,
    lastMessageAt: new Date().toISOString(),
    usage,
    ...(session.view.transcript?.opencodeTitle
      ? { opencodeTitle: session.view.transcript.opencodeTitle }
      : {})
  };
}

function setRuntime(
  session: MockSessionState,
  patch: Partial<SessionView['instance']['runtime']> & {
    phase?: SessionView['phase'];
    status?: SessionView['status'];
  }
): void {
  const { phase, status, ...runtime } = patch;
  const view = session.view;
  if (phase) {
    view.phase = phase;
  }
  if (status) {
    view.status = status;
  }
  view.instance.runtime = { ...view.instance.runtime, ...runtime };
}

/** A cold wake with slightly varied, believable stage timings. */
function coldWake(): SessionView['instance']['runtime']['lastWake'] {
  const restoreMs = 5_000 + Math.round(Math.random() * 4_000);
  const repoMs = 2_500 + Math.round(Math.random() * 3_000);
  const serverMs = 2_000 + Math.round(Math.random() * 1_500);
  return {
    restoreMs,
    repoMs,
    serverMs,
    totalMs: restoreMs + repoMs + serverMs + 300,
    at: new Date().toISOString(),
    cold: true
  };
}

const CLOUDFLARE_IDLE_TIMEOUT_MS = 10 * 60_000;
const DOCKER_IDLE_TIMEOUT_MS = 30 * 60_000;

function finishToIdle(session: MockSessionState): void {
  const timeoutMs =
    session.view.provider === 'docker'
      ? DOCKER_IDLE_TIMEOUT_MS
      : CLOUDFLARE_IDLE_TIMEOUT_MS;
  const deadline = new Date(Date.now() + timeoutMs).toISOString();
  // A run just stopped — the Worker's event classifier marks unread here. The
  // open session page acknowledges it within a poll; other sessions keep the dot.
  session.view.unreadAt = session.view.unreadAt ?? new Date().toISOString();
  setRuntime(session, {
    phase: 'working',
    status: 'idle',
    lifecycle: 'idle',
    container: 'running',
    idleDeadlineAt: deadline
  });
  scheduleIdleSleep(session.view.id, deadline);
}

/** When the countdown runs out the container genuinely goes to sleep. */
export function scheduleIdleSleep(id: string, deadline: string): void {
  const wait = new Date(deadline).getTime() - Date.now();
  setTimeout(() => {
    const session = store.sessions.get(id);
    if (
      !session ||
      session.view.instance.runtime.lifecycle !== 'idle' ||
      session.view.instance.runtime.idleDeadlineAt !== deadline
    ) {
      return;
    }
    session.mirroredAt = new Date().toISOString();
    setRuntime(session, {
      status: 'sleeping',
      lifecycle: 'sleeping',
      container: 'stopped',
      idleDeadlineAt: undefined
    });
  }, Math.max(0, wait));
}

// ---------------------------------------------------------------------------
// Canned streamed replies

interface ReplyScript {
  reasoning: string;
  tool: { tool: string; title: string };
  text: string;
}

const REPLY_ROTATION: ReplyScript[] = [
  {
    reasoning:
      'The toggle needs three states, not two — "system" must stay distinct from an explicit choice, or clearing the override becomes impossible. I will model it as an optional override on top of the media query.',
    tool: { tool: 'grep', title: 'prefers-color-scheme' },
    text: 'The theme hook is in. `useTheme` keeps the override in `localStorage`, falls back to `prefers-color-scheme`, and stamps `data-theme` on the root element so the CSS variables switch without a re-render of the tree. Next I will wire the three-state control into the settings page.'
  },
  {
    reasoning:
      'The settings page renders sections from a static list, so the cleanest insertion point is a new Appearance section at the top. The pill control we already use for effort selection fits the three states nicely.',
    tool: { tool: 'edit', title: 'web/src/components/SettingsPage.tsx' },
    text: 'Appearance section added with a **System / Light / Dark** pill control. Choosing a value applies instantly and persists; System clears the stored override.\n\n```tsx\n<PillSelect options={THEME_OPTIONS} value={theme} onChange={setTheme} />\n```\n\nRunning the test suite next to make sure nothing else reads the old class-based theme flag.'
  },
  {
    reasoning:
      'Tests passed except one snapshot that still expects the `dark` class on body. The component now uses data-theme, so the snapshot needs regenerating rather than the code changing.',
    tool: { tool: 'bash', title: 'pnpm test --update-snapshots' },
    text: 'All green — 42 tests, one snapshot regenerated. The toggle respects the OS default until an explicit choice is made, and the override survives a reload. Anything else you want on this, or should I open the pull request?'
  }
];

let replyCursor = 0;

/**
 * Stream one assistant reply into the session's transcript, emitting the same
 * event sequence the real container produces: message.updated, cumulative
 * part snapshots, a throwaway part removal, an unknown event type, and the
 * closing message.updated with `time.completed`.
 */
async function streamReply(
  session: MockSessionState,
  token: RunToken,
  parentId: string | undefined,
  script: ReplyScript
): Promise<void> {
  const id = session.view.id;
  const messageId = nextMessageId();
  const info: SessionMessage['info'] = {
    id: messageId,
    role: 'assistant',
    modelID: session.view.model,
    ...(parentId ? { parentID: parentId } : {}),
    time: { created: Date.now() }
  };
  session.transcript.push({ info, parts: [] });
  emitInfo(session, info);

  // Reasoning grows sentence by sentence.
  const reasoning: MessagePart = {
    id: nextPartId(),
    messageID: messageId,
    type: 'reasoning',
    text: ''
  };
  for (const sentence of script.reasoning.split(/(?<=\.)\s+/)) {
    if (token.cancelled) {
      return abortMessage(session, info);
    }
    reasoning.text = reasoning.text ? `${reasoning.text} ${sentence}` : sentence;
    upsertPart(session, messageId, reasoning);
    await sleep(350);
  }

  // A tool call: pending → running → completed.
  const tool: MessagePart = {
    id: nextPartId(),
    messageID: messageId,
    type: 'tool',
    tool: script.tool.tool,
    state: { status: 'pending' }
  };
  upsertPart(session, messageId, tool);
  await sleep(500);
  if (token.cancelled) {
    return abortMessage(session, info);
  }
  tool.state = { status: 'running', title: script.tool.title };
  upsertPart(session, messageId, tool);
  await sleep(1_100);
  if (token.cancelled) {
    return abortMessage(session, info);
  }
  tool.state = { status: 'completed', title: script.tool.title };
  upsertPart(session, messageId, tool);

  // The answer streams word by word, as cumulative part snapshots.
  const text: MessagePart = {
    id: nextPartId(),
    messageID: messageId,
    type: 'text',
    text: ''
  };
  const words = script.text.split(' ');
  for (let index = 0; index < words.length; index += 3) {
    if (token.cancelled) {
      return abortMessage(session, info);
    }
    text.text = words.slice(0, index + 3).join(' ');
    upsertPart(session, messageId, text);
    await sleep(140);
  }

  // A part that appears and is withdrawn — exercises message.part.removed.
  const throwaway: MessagePart = {
    id: nextPartId(),
    messageID: messageId,
    type: 'text',
    text: '…'
  };
  upsertPart(session, messageId, throwaway);
  await sleep(400);
  const message = session.transcript.find((entry) => entry.info.id === messageId);
  if (message) {
    message.parts = message.parts.filter((part) => part.id !== throwaway.id);
  }
  emitOpencode(id, undefined, {
    type: 'message.part.removed',
    properties: { messageID: messageId, partID: throwaway.id }
  });

  // An event type the client does not know — lands in its default branch.
  emitOpencode(id, undefined, {
    type: 'session.updated',
    properties: { sessionID: id }
  });

  info.time = { ...info.time, completed: Date.now() };
  emitInfo(session, info);
  bumpUsage(session, {
    inputTokens: 9_000 + Math.round(Math.random() * 6_000),
    outputTokens: 700 + Math.round(Math.random() * 600),
    reasoningTokens: 350,
    cacheReadTokens: 42_000,
    cacheWriteTokens: 2_500,
    cost: 0.14 + Math.random() * 0.2,
    assistantMessages: 1
  });
  touch(session);
}

function abortMessage(
  session: MockSessionState,
  info: SessionMessage['info']
): void {
  info.error = { name: 'MessageAbortedError', data: { message: 'Aborted by user' } };
  emitInfo(session, info);
  touch(session);
}

function lastUserMessageId(session: MockSessionState): string | undefined {
  for (let index = session.transcript.length - 1; index >= 0; index--) {
    if (session.transcript[index].info.role === 'user') {
      return session.transcript[index].info.id;
    }
  }
  return undefined;
}

/** ses_working streams replies forever, until aborted or stopped. */
export function startWorkingLoop(id: string): void {
  const token = newRun(id);
  void (async () => {
    while (!token.cancelled) {
      const session = store.sessions.get(id);
      if (!session || session.view.instance.runtime.lifecycle !== 'busy') {
        return;
      }
      const script = REPLY_ROTATION[replyCursor++ % REPLY_ROTATION.length];
      await streamReply(session, token, lastUserMessageId(session), script);
      await sleep(6_000 + Math.random() * 4_000);
    }
  })();
}

/** Append the user's message to the transcript and announce it on the stream. */
export function appendUserMessage(
  session: MockSessionState,
  prompt: string,
  attachments?: MessageAttachment[]
): string {
  const messageId = nextMessageId();
  const info: SessionMessage['info'] = {
    id: messageId,
    role: 'user',
    time: { created: Date.now() }
  };
  const parts: MessagePart[] = [
    { id: nextPartId(), messageID: messageId, type: 'text', text: prompt }
  ];
  for (const attachment of attachments ?? []) {
    // The key names an earlier upload, exactly as the Worker resolves it from
    // R2. Delivery consumes the upload, like the dispatch path deleting the
    // staged object.
    const upload = store.uploads.get(attachment.key);
    if (!upload) {
      continue;
    }
    store.uploads.delete(attachment.key);
    parts.push({
      id: nextPartId(),
      messageID: messageId,
      type: 'file',
      mime: upload.mime,
      ...(upload.filename ? { filename: upload.filename } : {}),
      url: upload.dataUrl
    });
  }
  session.transcript.push({ info, parts });
  emitInfo(session, info);
  for (const part of parts) {
    upsertPart(session, messageId, part);
  }
  touch(session);
  return messageId;
}

/**
 * Answer a prompt sent to an attached session: one streamed reply, then back
 * to idle — unless this is the forever-working session, whose loop is already
 * running and will fold the new prompt into its next cycle.
 */
export function respondWhileAttached(session: MockSessionState, userId: string): void {
  if (session.view.id === 'ses_working') {
    return;
  }
  const token = newRun(session.view.id);
  setRuntime(session, {
    status: 'working',
    lifecycle: 'busy',
    container: 'healthy',
    idleDeadlineAt: undefined
  });
  void (async () => {
    const script = REPLY_ROTATION[replyCursor++ % REPLY_ROTATION.length];
    await streamReply(session, token, userId, script);
    if (!token.cancelled) {
      finishToIdle(session);
    }
  })();
}

/** A prompt to a sleeping session: queued → starting → cold wake → reply. */
export function wakeAndRespond(session: MockSessionState, userId: string): void {
  const token = newRun(session.view.id);
  setRuntime(session, { phase: 'queued', status: 'queued' });
  void (async () => {
    await sleep(900);
    if (token.cancelled) {
      return;
    }
    setRuntime(session, {
      phase: 'starting',
      status: 'starting',
      lifecycle: 'waking',
      container: 'provisioning'
    });
    await sleep(2_800);
    if (token.cancelled) {
      return;
    }
    setRuntime(session, {
      phase: 'working',
      status: 'working',
      lifecycle: 'busy',
      container: 'healthy',
      lastWake: coldWake()
    });
    const script = REPLY_ROTATION[replyCursor++ % REPLY_ROTATION.length];
    await streamReply(session, token, userId, script);
    if (!token.cancelled) {
      finishToIdle(session);
    }
  })();
}

/**
 * A wake with no prompt: the Changes tab's "Wake container".
 *
 * It ends at idle rather than at a reply, because nothing was said — the
 * container comes up and the countdown starts again.
 */
export function wakeOnly(session: MockSessionState): void {
  const token = newRun(session.view.id);
  void (async () => {
    setRuntime(session, {
      status: 'starting',
      lifecycle: 'waking',
      container: 'provisioning'
    });
    await sleep(2_800);
    if (token.cancelled) {
      return;
    }
    // Deliberately not `finishToIdle`: nothing ran, so there is nothing new to
    // read and the session must not gain an unread dot for having been woken.
    const timeoutMs =
      session.view.provider === 'docker'
        ? DOCKER_IDLE_TIMEOUT_MS
        : CLOUDFLARE_IDLE_TIMEOUT_MS;
    const deadline = new Date(Date.now() + timeoutMs).toISOString();
    setRuntime(session, {
      status: 'idle',
      lifecycle: 'idle',
      container: 'running',
      idleDeadlineAt: deadline,
      lastWake: coldWake()
    });
    scheduleIdleSleep(session.view.id, deadline);
  })();
}

/** Cold boot for a brand-new (or fixture-queued) session with a first prompt. */
export function bootAndRespond(
  session: MockSessionState,
  prompt: string,
  attachments?: MessageAttachment[],
  initialDelayMs = 2_000
): void {
  const token = newRun(session.view.id);
  void (async () => {
    await sleep(initialDelayMs);
    if (token.cancelled) {
      return;
    }
    setRuntime(session, {
      phase: 'starting',
      status: 'starting',
      lifecycle: 'waking',
      container: 'provisioning'
    });
    await sleep(3_000);
    if (token.cancelled) {
      return;
    }
    setRuntime(session, {
      phase: 'working',
      status: 'working',
      lifecycle: 'busy',
      container: 'healthy',
      lastWake: coldWake()
    });
    const userId = appendUserMessage(session, prompt, attachments);
    const script = REPLY_ROTATION[replyCursor++ % REPLY_ROTATION.length];
    await streamReply(session, token, userId, script);
    if (!token.cancelled) {
      finishToIdle(session);
    }
  })();
}

/** The failed fixture's Retry: queued → starting → idle, no reply needed. */
export function retryBoot(session: MockSessionState): void {
  const token = newRun(session.view.id);
  session.view.lastError = undefined;
  setRuntime(session, { phase: 'queued', status: 'queued' });
  void (async () => {
    await sleep(1_500);
    if (token.cancelled) {
      return;
    }
    setRuntime(session, {
      phase: 'starting',
      status: 'starting',
      lifecycle: 'waking',
      container: 'provisioning'
    });
    await sleep(2_500);
    if (token.cancelled) {
      return;
    }
    setRuntime(session, { lastWake: coldWake() });
    finishToIdle(session);
  })();
}

/** The message and part a pending question request is parked on, if present. */
function findQuestionPart(
  session: MockSessionState,
  requestID: string
): { request: NonNullable<MockSessionState['pendingQuestions']>[number]; messageId: string; part: MessagePart } | undefined {
  const request = session.pendingQuestions?.find((entry) => entry.id === requestID);
  if (!request?.tool) {
    return undefined;
  }
  const message = session.transcript.find(
    (entry) => entry.info.id === request.tool!.messageID
  );
  const part = message?.parts.find(
    (entry) => entry.callID === request.tool!.callID
  );
  return part ? { request, messageId: message!.info.id, part } : undefined;
}

/** After the ask settles, the agent picks the work back up and goes idle. */
function continueAfterQuestion(session: MockSessionState): void {
  const token = newRun(session.view.id);
  void (async () => {
    await sleep(800);
    if (token.cancelled) {
      return;
    }
    const script = REPLY_ROTATION[replyCursor++ % REPLY_ROTATION.length];
    await streamReply(session, token, lastUserMessageId(session), script);
    if (!token.cancelled) {
      finishToIdle(session);
    }
  })();
}

/** Answer one pending question: the parked tool call completes with the answers. */
export function answerQuestionRequest(
  session: MockSessionState,
  requestID: string,
  answers: string[][]
): boolean {
  const found = findQuestionPart(session, requestID);
  if (!found) {
    return false;
  }
  session.pendingQuestions = session.pendingQuestions?.filter(
    (entry) => entry.id !== requestID
  );
  const count = found.request.questions.length;
  found.part.state = {
    ...found.part.state,
    status: 'completed',
    title: `Asked ${count} question${count === 1 ? '' : 's'}`,
    metadata: { ...found.part.state?.metadata, answers }
  };
  upsertPart(session, found.messageId, found.part);
  touch(session);
  continueAfterQuestion(session);
  return true;
}

/** Dismiss one pending question: the parked tool call ends in error. */
export function rejectQuestionRequest(
  session: MockSessionState,
  requestID: string
): boolean {
  const found = findQuestionPart(session, requestID);
  if (!found) {
    return false;
  }
  session.pendingQuestions = session.pendingQuestions?.filter(
    (entry) => entry.id !== requestID
  );
  found.part.state = { ...found.part.state, status: 'error' };
  upsertPart(session, found.messageId, found.part);
  touch(session);
  continueAfterQuestion(session);
  return true;
}

/** Abort whatever is streaming; the composer's Stop button. */
export function abortSessionRun(session: MockSessionState): void {
  cancelRun(session.view.id);
  // The cancelled streamReply stamps the error on its own message; here the
  // lifecycle settles back to an idle container with a fresh countdown.
  finishToIdle(session);
}

/** The sidebar's "Stop container". */
export function stopInstance(session: MockSessionState): void {
  cancelRun(session.view.id);
  session.mirroredAt = new Date().toISOString();
  setRuntime(session, {
    status: 'sleeping',
    lifecycle: 'sleeping',
    container: 'stopped',
    idleDeadlineAt: undefined
  });
}

export function deleteSessionState(id: string): void {
  cancelRun(id);
  store.sessions.delete(id);
}

/** Kick off the ambient scripts once the mock is installed. */
export function startAmbientScripts(): void {
  startWorkingLoop('ses_working');
  const queued = store.sessions.get('ses_queued');
  if (queued) {
    // The fixture-queued session boots on its own a few seconds after load,
    // so the whole cold-start narrative plays out in front of you.
    bootAndRespond(
      queued,
      'Investigate the memory leak in the SSE fan-out.',
      undefined,
      8_000
    );
  }
  for (const session of store.sessions.values()) {
    const deadline = session.view.instance.runtime.idleDeadlineAt;
    if (deadline && session.view.instance.runtime.lifecycle === 'idle') {
      scheduleIdleSleep(session.view.id, deadline);
    }
  }
}

/** Fresh `SessionView` for a just-created session. */
export function createSessionState(input: {
  /** Absent for a session started without one; it works in /workspace. */
  repoKey?: string;
  model: string;
  variant?: string;
  prompt: string;
  /** The sandbox host the composer picked; the Hub defaults it the same way. */
  provider?: SessionProvider;
}): MockSessionState {
  const id = nextSessionId();
  const title = input.prompt.split('\n')[0].slice(0, 120);
  return {
    view: {
      id,
      ...(input.repoKey ? { repoKey: input.repoKey } : {}),
      provider: input.provider ?? 'cloudflare',
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      title,
      displayTitle: title,
      phase: 'queued',
      status: 'queued',
      lastActivityAt: minutesAgo(0),
      instance: {
        id,
        lifecycle: 'ready',
        runtime: { container: 'none', lifecycle: 'sleeping' }
      }
    },
    transcript: [],
    childTranscripts: {},
    lineages: {}
  };
}
