/**
 * The mock `/api` dispatcher: a fetch-compatible function returning real
 * `Response` objects, so `call()` in api.ts behaves identically to production.
 *
 * Reads answer after a short randomized delay so spinners are visible; writes
 * take a little longer. Container-only endpoints answer 409 while a session is
 * asleep, exactly like the Worker.
 */
import type { MessageAttachment, WorkspaceEntry, WorkspaceListing } from '../api';
import { MOCK_SSH_PUBLIC_KEY } from './fixtures/settings';
import { minutesAgo } from './fixtures/util';
import {
  abortSessionRun,
  appendUserMessage,
  attached,
  bootAndRespond,
  createSessionState,
  deleteSessionState,
  respondWhileAttached,
  retryBoot,
  stopInstance,
  store,
  transcriptFor,
  wakeAndRespond
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
  if (key === 'github.token') {
    delete setting.value;
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

  // --- catalog ------------------------------------------------------------
  if (p === '/api/catalog' && method === 'GET') {
    if (url.searchParams.get('refresh') === '1') {
      store.catalog.reposFetchedAt = new Date().toISOString();
      store.catalog.reposStale = false;
    }
    return json(store.catalog);
  }

  // --- session collection -------------------------------------------------
  if (p === '/api/sessions' && method === 'GET') {
    return json([...store.sessions.values()].map((entry) => entry.view));
  }
  if (p === '/api/sessions' && method === 'POST') {
    const body = parseBody(init);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    if (!prompt.trim()) {
      return json({ error: 'A prompt is required' }, 400);
    }
    const session = createSessionState({
      // Absent means the composer's "No repository": the session works in
      // /workspace and has no changes to show.
      ...(typeof body.repoKey === 'string' && body.repoKey
        ? { repoKey: body.repoKey }
        : {}),
      model: typeof body.model === 'string' ? body.model : 'anthropic/claude-opus-4-5',
      ...(typeof body.variant === 'string' ? { variant: body.variant } : {}),
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
      if (view.status === 'deleting' || view.instance.lifecycle !== 'ready') {
        return json({ error: 'This session is being deleted' }, 409);
      }
      const userId = appendUserMessage(
        session,
        prompt,
        body.attachments as MessageAttachment[] | undefined
      );
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
          unpushedCommits: 0,
          publishBranch: 'main'
        }
      );
    }
    if (sub === 'files' && method === 'GET') {
      if (!attached(view)) {
        return asleep('browse the files of');
      }
      const workspace = session.workspace;
      if (!workspace) {
        return notFound('No workspace fixture for this session');
      }
      const filePath = url.searchParams.get('path') ?? '';
      if (url.searchParams.get('download') === '1') {
        return downloadFile(workspace, filePath);
      }
      return url.searchParams.get('read') === '1'
        ? readFile(workspace, filePath)
        : listDirectory(workspace, filePath);
    }
    if (sub === 'agent-session' && method === 'GET') {
      if (!attached(view)) {
        return asleep('inspect the subagents of');
      }
      const child = url.searchParams.get('child') ?? '';
      const lineage = session.lineages[child];
      return lineage ? json({ lineage }) : notFound('No such subagent session');
    }
    if (sub === 'abort' && method === 'POST') {
      abortSessionRun(session);
      return json({ aborted: true });
    }
    if (sub === 'retry' && method === 'POST') {
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
