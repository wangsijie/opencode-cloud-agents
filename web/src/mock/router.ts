/**
 * The mock `/api` dispatcher: a fetch-compatible function returning real
 * `Response` objects, so `call()` in api.ts behaves identically to production.
 *
 * Reads answer after a short randomized delay so spinners are visible; writes
 * take a little longer. Container-only endpoints answer 409 while a session is
 * asleep, exactly like the Worker.
 */
import {
  prebuildKey,
  type MessageAttachment,
  type SessionProvider,
  type WorkspaceEntry,
  type WorkspaceListing
} from '../api';
import { prebuildState, startMockRun } from './fixtures/prebuilds';
import { MOCK_SSH_PUBLIC_KEY } from './fixtures/settings';
import { minutesAgo } from './fixtures/util';
import {
  abortSessionRun,
  answerQuestionRequest,
  appendUserMessage,
  attached,
  bootAndRespond,
  createSessionState,
  deleteSessionState,
  rejectQuestionRequest,
  respondWhileAttached,
  retryBoot,
  stopInstance,
  store,
  transcriptFor,
  wakeAndRespond,
  wakeOnly
} from './store';
import type { MockSessionState, MockWorkspaceDir, MockWorkspaceNode } from './types';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const notFound = (what = 'Not found'): Response => json({ error: what }, 404);

const asleep = (intent: string): Response =>
  json(
    { error: `This session is sleeping; wake it before trying to ${intent} it` },
    409
  );

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') {
    return {};
  }
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requireSession(id: string): MockSessionState | undefined {
  return store.sessions.get(decodeURIComponent(id));
}

// ---------------------------------------------------------------------------
// Workspace resolution

function resolveNode(
  root: MockWorkspaceDir,
  path: string
): MockWorkspaceNode | undefined {
  if (!path) {
    return root;
  }
  let node: MockWorkspaceNode = root;
  for (const segment of path.split('/')) {
    if (node.type !== 'dir') {
      return undefined;
    }
    const next: MockWorkspaceNode | undefined = node.entries[segment];
    if (!next) {
      return undefined;
    }
    node = next;
  }
  return node;
}

function listDirectory(root: MockWorkspaceDir, path: string): Response {
  const node = resolveNode(root, path);
  if (!node || node.type !== 'dir') {
    return notFound('No such directory');
  }
  const entries: WorkspaceEntry[] = Object.entries(node.entries)
    .map(([name, child]): WorkspaceEntry => {
      const childPath = path ? `${path}/${name}` : name;
      if (child.type === 'dir') {
        return { name, path: childPath, type: 'directory', size: 0 };
      }
      return {
        name,
        path: childPath,
        type: child.type,
        size: child.size ?? child.content?.length ?? 0,
        modifiedAt: minutesAgo(90)
      };
    })
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === 'directory'
          ? -1
          : 1
    );
  const listing: WorkspaceListing = {
    path,
    ...(path ? { parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' } : {}),
    entries,
    truncated: node.truncated ?? false
  };
  return json(listing);
}

function readFile(root: MockWorkspaceDir, path: string): Response {
  const node = resolveNode(root, path);
  if (!node || node.type === 'dir') {
    return notFound('No such file');
  }
  return json({
    path,
    size: node.size ?? node.content?.length ?? 0,
    ...(node.binary ? {} : { content: node.content ?? '' }),
    binary: node.binary ?? false,
    truncated: node.truncated ?? false
  });
}

/** The upload path, as the client percent-encodes it into a header. */
function decodeHeaderPath(init?: RequestInit): string {
  const headers = new Headers(init?.headers);
  const header = headers.get('x-file-path') ?? '';
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/** The directory a path's parents name, created as it is walked. */
function ensureParents(
  root: MockWorkspaceDir,
  segments: readonly string[]
): MockWorkspaceDir | undefined {
  let node: MockWorkspaceDir = root;
  for (const segment of segments) {
    const next: MockWorkspaceNode = (node.entries[segment] ??= {
      type: 'dir',
      entries: {}
    });
    if (next.type !== 'dir') {
      return undefined;
    }
    node = next;
  }
  return node;
}

async function writeArtifact(
  root: MockWorkspaceDir,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) {
    return json({ error: 'An x-file-path header is required' }, 400);
  }
  const parent = ensureParents(root, segments);
  if (!parent) {
    return json({ error: 'Path escapes the workspace' }, 400);
  }
  const body = init?.body;
  const bytes = new Uint8Array(
    body instanceof Blob
      ? await body.arrayBuffer()
      : new TextEncoder().encode(typeof body === 'string' ? body : '')
  );
  // Text is kept so the viewer can show it back; anything else is described by
  // size alone, which is all the real read does for binary too.
  const text = new TextDecoder('utf-8', { fatal: true });
  let content: string | undefined;
  try {
    content = text.decode(bytes);
  } catch {
    content = undefined;
  }
  parent.entries[name] = {
    type: 'file',
    size: bytes.byteLength,
    ...(content === undefined ? { binary: true } : { content })
  };
  return json({ path }, 201);
}

function deleteArtifact(root: MockWorkspaceDir, path: string): Response {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) {
    return json({ error: 'A file path is required' }, 400);
  }
  const parent = resolveNode(root, segments.join('/'));
  if (!parent || parent.type !== 'dir' || !parent.entries[name]) {
    return notFound('File not found');
  }
  delete parent.entries[name];
  return json({ path });
}

/** Binary fixtures carry no bytes, so downloads answer with placeholder text. */
function downloadFile(root: MockWorkspaceDir, path: string): Response {
  const node = resolveNode(root, path);
  if (!node || node.type === 'dir') {
    return notFound('No such file');
  }
  const name = path.split('/').pop() ?? 'file';
  return new Response(node.content ?? `mock bytes of ${path}\n`, {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`
    }
  });
}

// ---------------------------------------------------------------------------
// Settings

/** A `docker.hosts` entry as the mock store keeps it: no token, ever. */
interface MockDockerHost {
  id: string;
  label?: string;
  baseUrl: string;
  image?: string;
  idleTimeoutMinutes?: number;
  tokenConfigured?: boolean;
}

/**
 * The hosts the mock considers configured. Derived from the stored setting the
 * same way the Worker derives it, so removing one in the settings section takes
 * it out of the composer's picker and the prebuilds page on the next read.
 */
function dockerHosts(): MockDockerHost[] {
  const setting = store.settings.find((entry) => entry.key === 'docker.hosts');
  return setting?.configured && Array.isArray(setting.value)
    ? (setting.value as MockDockerHost[])
    : [];
}

function putSetting(key: string, body: Record<string, unknown>): Response {
  const setting = store.settings.find((entry) => entry.key === key);
  if (!setting) {
    return notFound('Unknown setting');
  }
  const value = body.value;
  if (value === null) {
    setting.configured = false;
    delete setting.value;
    setting.updatedAt = new Date().toISOString();
    return json({ ok: true });
  }
  setting.configured = true;
  setting.updatedAt = new Date().toISOString();
  // Mirror the Worker's exposure rules: secrets store nothing readable,
  // partial settings store the public half only.
  if (key === 'github.token' || key === 'opencode.mcp-auth') {
    delete setting.value;
  } else if (key === 'docker.hosts') {
    // Partial like the Worker's: the list reads back without its tokens, and
    // a blank one keeps whatever was stored under the same id.
    const stored = new Map(
      (Array.isArray(setting.value) ? (setting.value as MockDockerHost[]) : []).map(
        (host) => [host.id, host.tokenConfigured === true]
      )
    );
    setting.value = (value as (MockDockerHost & { token?: string })[]).map(
      ({ token, ...host }) => ({
        ...host,
        tokenConfigured:
          (typeof token === 'string' && token.length > 0) ||
          stored.get(host.id) === true
      })
    );
  } else if (key === 'container.ssh-key') {
    setting.value = {
      publicKey:
        (value as { publicKey?: string }).publicKey ?? MOCK_SSH_PUBLIC_KEY
    };
  } else if (key === 'container.env') {
    setting.value = Array.isArray(value)
      ? (value as { name: string }[]).map((entry) => ({ name: entry.name }))
      : [];
  } else {
    setting.value = value;
  }
  if (key === 'opencode.config' && store.configWarningPending) {
    store.configWarningPending = false;
    return json({
      ok: true,
      warnings: [
        'provider "anthropic" lists models no session is pinned to yet; they only take effect on the next container start (mock warning)'
      ]
    });
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// The dispatcher

async function route(path: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const url = new URL(path, location.origin);
  const p = url.pathname;

  // --- auth & setup -------------------------------------------------------
  if (p === '/api/auth') {
    if (method === 'GET') {
      return json({ authenticated: store.authenticated, passwordConfigured: true });
    }
    if (method === 'POST') {
      const { password } = parseBody(init);
      if (typeof password !== 'string' || password.length === 0) {
        return json({ error: 'Wrong password' }, 401);
      }
      store.authenticated = true;
      return json({ authenticated: true });
    }
    if (method === 'DELETE') {
      store.authenticated = false;
      return json({ authenticated: false });
    }
  }
  if (p === '/api/setup' && method === 'POST') {
    store.authenticated = true;
    return json({ authenticated: true });
  }

  // --- settings -----------------------------------------------------------
  if (p === '/api/settings' && method === 'GET') {
    return json({ settings: store.settings });
  }
  if (p === '/api/settings/status' && method === 'GET') {
    return json({
      missing: store.settings
        .filter((entry) => entry.required && !entry.configured)
        .map((entry) => entry.key)
    });
  }
  if (p === '/api/settings/ssh-key/generate' && method === 'POST') {
    const setting = store.settings.find((entry) => entry.key === 'container.ssh-key');
    if (setting) {
      setting.configured = true;
      setting.updatedAt = new Date().toISOString();
      setting.value = { publicKey: MOCK_SSH_PUBLIC_KEY };
    }
    return json({ publicKey: MOCK_SSH_PUBLIC_KEY });
  }
  if (p === '/api/settings/password' && method === 'POST') {
    const { currentPassword, newPassword } = parseBody(init);
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return json({ error: 'Current password is wrong' }, 403);
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return json({ error: 'New password must be at least 8 characters' }, 400);
    }
    return json({ ok: true });
  }
  {
    const match = /^\/api\/settings\/([^/]+)$/.exec(p);
    if (match && method === 'PUT') {
      return putSetting(decodeURIComponent(match[1]), parseBody(init));
    }
  }

  // --- prebuilds ----------------------------------------------------------
  if (p === '/api/prebuilds' && method === 'GET') {
    return json({
      prebuilds: [...prebuildState.prebuilds.values()],
      runs: Object.fromEntries(prebuildState.runs),
      // The buildable hosts, from the same settings the catalog reads: remove
      // one in the section above and its group goes read-only here.
      hosts: dockerHosts().map((host) => ({
        provider: `docker:${host.id}` as SessionProvider,
        label: host.label ?? host.id
      }))
    });
  }
  if (p === '/api/prebuilds' && method === 'POST') {
    const { repoKey, provider } = parseBody(init);
    if (typeof repoKey !== 'string' || repoKey.length === 0) {
      return json({ error: 'Unknown repository' }, 400);
    }
    const host = (typeof provider === 'string'
      ? provider
      : `docker:${dockerHosts()[0]?.id}`) as SessionProvider;
    if (!dockerHosts().some((entry) => `docker:${entry.id}` === host)) {
      return json({ error: `Docker sandbox host "${host}" is not configured` }, 409);
    }
    if (prebuildState.runs.get(prebuildKey(host, repoKey))?.status === 'running') {
      return json(
        {
          error:
            'A prebuild run is already underway for this repository on this host'
        },
        409
      );
    }
    return json({ runId: startMockRun(repoKey, host) }, 202);
  }
  {
    const match = /^\/api\/prebuilds\/(.+)$/.exec(p);
    if (match && method === 'DELETE') {
      const repoKey = decodeURIComponent(match[1]);
      const provider = url.searchParams.get('provider');
      if (provider === null) {
        return json(
          { error: 'Name the host to delete from with ?provider=' },
          400
        );
      }
      const key = prebuildKey(provider as SessionProvider, repoKey);
      if (prebuildState.runs.get(key)?.status === 'running') {
        return json(
          { error: 'A prebuild run is underway; wait for it to finish' },
          409
        );
      }
      prebuildState.prebuilds.delete(key);
      // As the Hub does: the run goes too, or a failed one keeps the repo on
      // the list with nothing left to delete.
      prebuildState.runs.delete(key);
      return json({ removed: true });
    }
  }

  // --- catalog ------------------------------------------------------------
  if (p === '/api/catalog' && method === 'GET') {
    if (url.searchParams.get('refresh') === '1') {
      store.catalog.reposFetchedAt = new Date().toISOString();
      store.catalog.reposStale = false;
    }
    // Derived rather than fixed, like the Hub's: removing a host in the
    // section above takes it out of the composer's picker on the next read,
    // which is the state worth being able to walk into.
    store.catalog.providers = [
      ...dockerHosts().map((host) => ({
        provider: `docker:${host.id}` as SessionProvider,
        label: host.label ?? host.id
      })),
      { provider: 'cloudflare' as SessionProvider, label: 'Cloudflare' }
    ];
    return json(store.catalog);
  }

  // --- uploads -------------------------------------------------------------
  // The composer uploads each image as it is picked; prompts carry only keys.
  if (p === '/api/uploads' && method === 'POST') {
    const body = init?.body;
    if (!(body instanceof Blob)) {
      return json({ error: 'An image body is required' }, 400);
    }
    const mime = body.type || 'application/octet-stream';
    const filenameHeader = new Headers(init?.headers).get('x-upload-filename');
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(body);
    });
    const key = `uploads/${crypto.randomUUID()}`;
    store.uploads.set(key, {
      mime,
      ...(filenameHeader ? { filename: filenameHeader } : {}),
      dataUrl,
      size: body.size
    });
    return json(
      {
        key,
        mime,
        ...(filenameHeader ? { filename: filenameHeader } : {}),
        size: body.size
      },
      201
    );
  }
  const uploadMatch = /^\/api\/uploads\/([^/]+)$/.exec(p);
  if (uploadMatch && method === 'DELETE') {
    store.uploads.delete(`uploads/${uploadMatch[1]}`);
    return json({ deleted: true });
  }

  // --- session collection -------------------------------------------------
  if (p === '/api/sessions' && method === 'GET') {
    // Paged in the Hub's order — pinned first, then most recently touched —
    // because the sidebar's "show more" is only a prefix if the order the
    // limit cuts is the order it renders.
    const views = [...store.sessions.values()]
      .map((entry) => entry.view)
      .sort(
        (a, b) =>
          Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) ||
          b.lastActivityAt.localeCompare(a.lastActivityAt)
      );
    const limit = Number(url.searchParams.get('limit'));
    return json(
      Number.isInteger(limit) && limit > 0 ? views.slice(0, limit) : views
    );
  }
  if (p === '/api/sessions' && method === 'POST') {
    const body = parseBody(init);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      return json({ error: 'A prompt is required' }, 400);
    }
    // The Hub validates the provider against the same list it put in the
    // catalog, so a session on an unconfigured host is a 400 rather than a
    // session that can never wake.
    const provider = (body.provider ??
      store.catalog.providers[0]?.provider ??
      'cloudflare') as SessionProvider;
    if (!store.catalog.providers.some((option) => option.provider === provider)) {
      return json({ error: 'Unknown provider' }, 400);
    }
    const session = createSessionState({
      // Absent means the composer's "No repository": the session works in
      // /workspace and has no changes to show.
      ...(typeof body.repoKey === 'string' && body.repoKey
        ? { repoKey: body.repoKey }
        : {}),
      model: typeof body.model === 'string' ? body.model : 'anthropic/claude-opus-4-5',
      ...(typeof body.variant === 'string' ? { variant: body.variant } : {}),
      provider,
      prompt
    });
    store.sessions.set(session.view.id, session);
    bootAndRespond(
      session,
      prompt,
      body.attachments as MessageAttachment[] | undefined
    );
    return json(session.view);
  }

  // --- one session --------------------------------------------------------
  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
  if (sessionMatch) {
    const session = requireSession(sessionMatch[1]);
    if (!session) {
      return notFound('No such session');
    }
    const view = session.view;
    const sub = sessionMatch[2];

    if (!sub) {
      if (method === 'GET') {
        return json(view);
      }
      if (method === 'PATCH') {
        const body = parseBody(init);
        if (typeof body.title === 'string' && body.title.trim()) {
          view.title = body.title.trim();
          view.displayTitle = body.title.trim();
        }
        if (typeof body.pinned === 'boolean') {
          if (body.pinned) {
            view.pinnedAt = view.pinnedAt ?? new Date().toISOString();
          } else {
            delete view.pinnedAt;
          }
        }
        return json(view);
      }
      if (method === 'DELETE') {
        deleteSessionState(view.id);
        return json({ deleted: true });
      }
    }

    if (sub === 'messages' && method === 'GET') {
      const transcript = transcriptFor(
        session,
        url.searchParams.get('child') ?? undefined
      );
      return transcript ? json(transcript) : notFound('No such subagent session');
    }
    if (sub === 'messages' && method === 'POST') {
      const body = parseBody(init);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) {
        return json({ error: 'A prompt is required' }, 400);
      }
      if (view.phase === 'lost') {
        return json({ error: 'This session was lost and cannot be continued' }, 409);
      }
      if (view.status === 'cleaned') {
        return json(
          {
            error:
              'This session was cleaned up after 3 days of inactivity and is read-only'
          },
          409
        );
      }
      if (view.status === 'deleting' || view.instance.lifecycle !== 'ready') {
        return json({ error: 'This session is being deleted' }, 409);
      }
      const userId = appendUserMessage(
        session,
        prompt,
        body.attachments as MessageAttachment[] | undefined
      );
      // Sending a message is proof the user has seen the session.
      delete view.unreadAt;
      if (attached(view)) {
        respondWhileAttached(session, userId);
      } else {
        wakeAndRespond(session, userId);
      }
      return json(view);
    }
    if (sub === 'changes' && method === 'GET') {
      if (!view.repoKey) {
        return json(
          {
            error:
              'This session was created without a repository, so it has no changes'
          },
          409
        );
      }
      if (!attached(view)) {
        return asleep('read the changes of');
      }
      return json(
        session.changes ?? {
          observedAt: new Date().toISOString(),
          repoKey: view.repoKey,
          branch: 'main',
          defaultBranch: 'main',
          onDefaultBranch: true,
          files: [],
          diff: '',
          diffTruncated: false,
          unpushedCommits: 0
        }
      );
    }
    if (sub === 'files') {
      const artifacts = url.searchParams.get('root') === 'artifacts';
      if (!attached(view)) {
        return asleep(
          artifacts ? 'use the files of' : 'browse the files of'
        );
      }
      const filePath = url.searchParams.get('path') ?? '';
      if (artifacts) {
        // Only the artifacts root is writable, exactly as the Worker has it.
        const root = (session.artifacts ??= { type: 'dir', entries: {} });
        if (method === 'POST') {
          return await writeArtifact(root, decodeHeaderPath(init), init);
        }
        if (method === 'DELETE') {
          return deleteArtifact(root, filePath);
        }
      }
      if (method !== 'GET') {
        return json({ error: 'Method not allowed' }, 405);
      }
      const tree = artifacts ? session.artifacts : session.workspace;
      if (!tree) {
        return notFound('No workspace fixture for this session');
      }
      if (url.searchParams.get('download') === '1') {
        return downloadFile(tree, filePath);
      }
      return url.searchParams.get('read') === '1'
        ? readFile(tree, filePath)
        : listDirectory(tree, filePath);
    }
    if (sub === 'agent-session' && method === 'GET') {
      if (!attached(view)) {
        return asleep('inspect the subagents of');
      }
      const child = url.searchParams.get('child') ?? '';
      const lineage = session.lineages[child];
      return lineage ? json({ lineage }) : notFound('No such subagent session');
    }
    if (sub === 'questions' && method === 'GET') {
      return attached(view)
        ? json({ state: 'live', questions: session.pendingQuestions ?? [] })
        : json({ state: 'sleeping', questions: [] });
    }
    if (sub === 'questions' && method === 'POST') {
      if (!attached(view)) {
        return asleep('answer a question in');
      }
      const body = parseBody(init);
      const requestID = typeof body.requestID === 'string' ? body.requestID : '';
      const done =
        body.reject === true
          ? rejectQuestionRequest(session, requestID)
          : Array.isArray(body.answers) &&
            answerQuestionRequest(session, requestID, body.answers as string[][]);
      if (done) {
        // Answering or dismissing a question is proof the user has seen it.
        delete view.unreadAt;
        return json({ ok: true });
      }
      return json({ error: 'This question is no longer pending' }, 409);
    }
    if (sub === 'read' && method === 'POST') {
      const seenAt = parseBody(init).seenAt;
      if (typeof seenAt !== 'string' || seenAt.length === 0) {
        return json({ error: 'Expected { seenAt }' }, 400);
      }
      // Compare-and-clear, like the Worker: only the marker the client saw goes.
      if (view.unreadAt === seenAt) {
        delete view.unreadAt;
      }
      return json({ ok: true });
    }
    if (sub === 'abort' && method === 'POST') {
      abortSessionRun(session);
      return json({ aborted: true });
    }
    if (sub === 'wake' && method === 'POST') {
      if (view.phase === 'lost') {
        return json({ error: 'This session was lost and cannot be woken' }, 409);
      }
      if (view.status === 'cleaned') {
        return json(
          {
            error:
              'This session was cleaned up after 3 days of inactivity and is read-only'
          },
          409
        );
      }
      if (!attached(view)) {
        wakeOnly(session);
      }
      return json(view);
    }
    if (sub === 'retry' && method === 'POST') {
      if (view.status === 'cleaned') {
        return json(
          {
            error:
              'This session was cleaned up after 3 days of inactivity and is read-only'
          },
          409
        );
      }
      retryBoot(session);
      return json(view);
    }
  }

  // --- instances ----------------------------------------------------------
  const instanceMatch = /^\/api\/instances\/([^/]+)\/stop$/.exec(p);
  if (instanceMatch && method === 'POST') {
    const instanceId = decodeURIComponent(instanceMatch[1]);
    for (const session of store.sessions.values()) {
      if (session.view.instance.id === instanceId) {
        stopInstance(session);
        return json({ stopped: true });
      }
    }
    return notFound('No such instance');
  }

  return notFound();
}

/** The fetch replacement handed to `setApiFetch`. */
export async function handleMockFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  if (!path.startsWith('/api/')) {
    return fetch(path, init);
  }
  const method = (init?.method ?? 'GET').toUpperCase();
  // Visible-but-brisk latency: enough for spinners, not enough to annoy.
  await sleep(
    method === 'GET' ? 120 + Math.random() * 200 : 300 + Math.random() * 300
  );
  return route(path, init);
}
