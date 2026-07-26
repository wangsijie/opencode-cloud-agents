/**
 * The Hub API, as seen from the browser.
 *
 * Per decision D6 the UI only ever talks to its own origin. Whether a session is
 * awake (proxied live) or asleep (served from the R2 mirror) is the Worker's
 * problem, not this layer's — the shape of a transcript is the same either way.
 */

/** Mirrors `SessionStatus` in the Worker's `src/sessions.ts`. */
export type SessionStatus =
  | 'queued'
  | 'starting'
  | 'working'
  | 'idle'
  | 'sleeping'
  | 'failed'
  | 'error'
  | 'deleting';

export interface InstanceRuntime {
  container: string;
  lifecycle: string;
  idleDeadlineAt?: string;
}

export interface InstanceView {
  id: string;
  lifecycle: 'ready' | 'deleting' | 'delete_failed';
  runtime: InstanceRuntime;
}

export interface SessionView {
  id: string;
  repoKey: string;
  model: string;
  title: string;
  phase: 'queued' | 'starting' | 'working' | 'failed';
  status: SessionStatus;
  lastActivityAt: string;
  lastError?: string;
  instance: InstanceView;
  transcript?: TranscriptSummary;
}

export interface RepoOption {
  repoKey: string;
  displayName: string;
}

export interface ModelOption {
  id: string;
  displayName: string;
}

export interface Catalog {
  repos: RepoOption[];
  models: ModelOption[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers
    }
  });
  const body: unknown =
    response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (body as { error?: string } | null)?.error;
    throw new Error(detail ?? `请求失败 (${response.status})`);
  }
  return body as T;
}

/**
 * One message and its parts, forwarded from OpenCode unchanged.
 *
 * Only the fields the renderer reads are named; parts carry many more, and a
 * type this layer does not know about is shown as a placeholder rather than
 * being dropped.
 */
export interface MessagePart {
  id: string;
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; title?: string };
  [key: string]: unknown;
}

export interface MessageInfo {
  id: string;
  role: 'user' | 'assistant';
  modelID?: string;
  time?: { created?: number; completed?: number };
  error?: { name?: string; data?: { message?: string } };
}

export interface SessionMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

export type TranscriptState = 'live' | 'sleeping' | 'pending' | 'error';

export interface Transcript {
  state: TranscriptState;
  source: 'container' | 'mirror' | 'none';
  /** Set when `source` is `mirror`: nothing after this moment is included. */
  mirroredAt?: string;
  messages: SessionMessage[];
  error?: string;
}

/** Summary of a session's mirrored history, as shown in the list. */
export interface TranscriptSummary {
  mirroredAt: string;
  messageCount: number;
  lastMessageAt?: string;
}

export const listSessions = () => call<SessionView[]>('/api/sessions');

export const getSession = (id: string) =>
  call<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);

export const fetchTranscript = (id: string) =>
  call<Transcript>(`/api/sessions/${encodeURIComponent(id)}/messages`);

export const sendMessage = (
  id: string,
  input: { prompt: string; model?: string; promptId?: string }
) =>
  call<SessionView>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify(input)
  });

export const abortSession = (id: string) =>
  call<{ aborted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/abort`, {
    method: 'POST'
  });
export const fetchCatalog = () => call<Catalog>('/api/catalog');

export const createSession = (input: {
  repoKey: string;
  model: string;
  prompt: string;
}) => call<SessionView>('/api/sessions', { method: 'POST', body: JSON.stringify(input) });

export const deleteSession = (id: string) =>
  call<unknown>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const retrySession = (id: string) =>
  call<SessionView>(`/api/sessions/${encodeURIComponent(id)}/retry`, {
    method: 'POST'
  });

export const stopInstance = (id: string) =>
  call<unknown>(`/api/instances/${encodeURIComponent(id)}/stop`, { method: 'POST' });

/**
 * Wake a container and return where the stock UI can be entered.
 *
 * This is the one place the UI deliberately triggers a wake: opening the full
 * IDE is an explicit request for a running container.
 */
export const wakeInstance = (id: string) =>
  call<{ launchUrl?: string }>(`/api/instances/${encodeURIComponent(id)}/wake`, {
    method: 'POST'
  });
