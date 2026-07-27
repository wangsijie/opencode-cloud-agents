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
  | 'lost'
  | 'error'
  | 'deleting';

/** Mirrors `RuntimeLifecycle` in the Worker's `src/instances.ts`. */
export type RuntimeLifecycle =
  | 'sleeping'
  | 'waking'
  | 'busy'
  | 'idle'
  | 'quiescing'
  | 'checkpointing'
  | 'stopping'
  | 'error';

/** Mirrors `WakeTimings` in the Worker's `src/instances.ts`. */
export interface WakeTimings {
  restoreMs?: number;
  repoMs?: number;
  serverMs?: number;
  totalMs: number;
  at: string;
  cold: boolean;
}

export interface InstanceRuntime {
  container: string;
  lifecycle: RuntimeLifecycle;
  idleDeadlineAt?: string;
  lastWake?: WakeTimings;
}

export interface InstanceView {
  id: string;
  lifecycle: 'ready' | 'deleting' | 'delete_failed';
  runtime: InstanceRuntime;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  assistantMessages: number;
}

export interface SessionView {
  id: string;
  repoKey: string;
  /** The checkout inside the container; pinned on the record since M6. */
  directory?: string;
  model: string;
  /** OpenCode variant (reasoning effort) for `model`, when it has any. */
  variant?: string;
  /** The record's own title: the first line of the opening prompt. */
  title: string;
  /** What to show — OpenCode's own title once it has one. */
  displayTitle: string;
  archivedAt?: string;
  phase: 'queued' | 'starting' | 'working' | 'failed' | 'lost';
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

export interface ModelVariantOption {
  id: string;
  label: string;
}

export interface ModelOption {
  id: string;
  /** `provider · model`. The picker shows `modelName` alone. */
  displayName: string;
  modelName: string;
  /** Reasoning-effort knobs; empty means the effort picker is hidden. */
  variants?: readonly ModelVariantOption[];
}

export interface Catalog {
  /** Ordered by last use, so the first entry is the composer's default. */
  repos: RepoOption[];
  models: ModelOption[];
  /** When the Hub last read the repository list from GitHub. */
  reposFetchedAt?: string;
  /** The stored list is past its TTL: worth one refresh once the page is up. */
  reposStale?: boolean;
}

/**
 * Fired when the Hub answers 401 to anything.
 *
 * The session cookie can lapse under an open tab, and the polls would then turn
 * into a wall of failures on whatever page happens to be up. The app listens
 * for this and goes back to the sign-in form instead.
 */
export const UNAUTHORIZED_EVENT = 'hub:unauthorized';

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
    // A rejected password is this route's ordinary answer, not a lapsed
    // session: the form reports it, and nothing else should react.
    if (response.status === 401 && path !== '/api/auth') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const detail = (body as { error?: string } | null)?.error;
    throw new Error(detail ?? `Request failed (${response.status})`);
  }
  return body as T;
}

/** Whether this browser already holds a session. Answers 200 either way. */
export const fetchAuthState = () =>
  call<{ authenticated: boolean }>('/api/auth');

export const signIn = (password: string) =>
  call<{ authenticated: boolean }>('/api/auth', {
    method: 'POST',
    body: JSON.stringify({ password })
  });

export const signOut = () =>
  call<{ authenticated: boolean }>('/api/auth', { method: 'DELETE' });

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
  /**
   * `metadata` is the tool's own bag, and its contents differ per tool. The
   * `task` tool puts the subagent session it started in there, which is the
   * only link between a transcript and the conversation it spawned.
   */
  state?: {
    status?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
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

/** Mirrors `AgentSessionEntry` in the Worker's `src/session-lineage.ts`. */
export interface AgentSessionEntry {
  id: string;
  title: string;
  /** Which subagent ran here. Absent on the root session. */
  agent?: string;
  parentID?: string;
}

export interface AgentSessionLineage {
  /** Root first, the requested subagent last. */
  lineage: AgentSessionEntry[];
}

/** Summary of a session's mirrored history, as shown in the list. */
export interface TranscriptSummary {
  mirroredAt: string;
  messageCount: number;
  lastMessageAt?: string;
  usage?: SessionUsage;
  opencodeTitle?: string;
}

/** Mirrors `SessionChanges` in the Worker's `src/session-changes.ts`. */
export interface ChangedFile {
  path: string;
  status:
    | 'added'
    | 'modified'
    | 'deleted'
    | 'renamed'
    | 'untracked'
    | 'conflicted';
  renamedFrom?: string;
}

export interface SessionChanges {
  observedAt: string;
  repoKey: string;
  branch: string;
  defaultBranch: string;
  onDefaultBranch: boolean;
  head?: { sha: string; subject: string };
  files: ChangedFile[];
  diff: string;
  diffTruncated: boolean;
  unpushedCommits: number;
  publishBranch: string;
  remoteBranch?: string;
}

/** Mirrors `WorkspaceListing` in the Worker's `src/workspace-files.ts`. */
export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt?: string;
}

export interface WorkspaceListing {
  path: string;
  parent?: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  content?: string;
  binary: boolean;
  truncated: boolean;
}

/** `archived`: the default list hides archived sessions. */
export const listSessions = (archived?: '1' | 'all') =>
  call<SessionView[]>(
    archived ? `/api/sessions?archived=${archived}` : '/api/sessions'
  );

/** Rename or archive a session. Neither touches the container. */
export const patchSession = (
  id: string,
  input: { title?: string; archived?: boolean }
) =>
  call<SessionView>(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });

export const getSession = (id: string) =>
  call<SessionView>(`/api/sessions/${encodeURIComponent(id)}`);

/**
 * A session's messages, or a subagent's when `agentSessionId` is given.
 *
 * The subagent read has no mirror behind it, so a sleeping container answers
 * `sleeping` with no messages rather than the parent's history.
 */
export const fetchTranscript = (id: string, agentSessionId?: string) =>
  call<Transcript>(
    `/api/sessions/${encodeURIComponent(id)}/messages${childQuery(agentSessionId)}`
  );

const childQuery = (agentSessionId?: string) =>
  agentSessionId ? `?child=${encodeURIComponent(agentSessionId)}` : '';

/**
 * Where a subagent sits under the session that started it.
 *
 * Root first, the subagent last, with every level in between — which is what
 * the breadcrumb needs, and what proves the id belongs to this session at all.
 * Needs a running container, so a sleeping one answers 409.
 */
export const fetchAgentSession = (id: string, agentSessionId: string) =>
  call<AgentSessionLineage>(
    `/api/sessions/${encodeURIComponent(id)}/agent-session${childQuery(agentSessionId)}`
  );

export const sendMessage = (
  id: string,
  input: { prompt: string; model?: string; variant?: string; promptId?: string }
) =>
  call<SessionView>(`/api/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify(input)
  });

export const abortSession = (id: string) =>
  call<{ aborted: boolean }>(`/api/sessions/${encodeURIComponent(id)}/abort`, {
    method: 'POST'
  });
/**
 * What the agent changed in the checkout.
 *
 * Unlike every other read here this one needs a running container — the working
 * tree only exists inside one — so it is requested on demand rather than polled.
 */
export const fetchChanges = (id: string) =>
  call<SessionChanges>(`/api/sessions/${encodeURIComponent(id)}/changes`);

/**
 * Browse the checkout inside a running container.
 *
 * Like the diff, these need the container up: there is no mirror of a working
 * tree, so a sleeping session answers 409 and the panel says to send a message.
 */
export const listWorkspaceFiles = (id: string, path = '') =>
  call<WorkspaceListing>(
    `/api/sessions/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`
  );

export const readWorkspaceFile = (id: string, path: string) =>
  call<WorkspaceFile>(
    `/api/sessions/${encodeURIComponent(id)}/files?read=1&path=${encodeURIComponent(path)}`
  );

/**
 * Repository and model choices.
 *
 * The repository list is GitHub's, stored by the Hub, so this normally costs
 * nothing and never waits on GitHub. `refresh` re-reads GitHub — what the page
 * does once when the stored list is past its TTL, and what the composer's
 * button does for a repository created a minute ago.
 */
export const fetchCatalog = (refresh = false) =>
  call<Catalog>(refresh ? '/api/catalog?refresh=1' : '/api/catalog');

export const createSession = (input: {
  repoKey: string;
  model: string;
  variant?: string;
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

