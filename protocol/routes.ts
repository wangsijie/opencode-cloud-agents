/**
 * Sandbox Host protocol — route table.
 *
 * Builders return path + query strings relative to the host base URL. Both
 * host implementations and the site-side client route through these so the
 * two never drift; the agent (plain .mjs) mirrors them per PROTOCOL.md.
 */

import { REPO_KEY_PATTERN, SESSION_ID_PATTERN } from './types.ts';

export const HEALTHZ_ROUTE = '/healthz';

export function assertRepoKey(repoKey: string): string {
  if (!REPO_KEY_PATTERN.test(repoKey)) {
    throw new Error(`Invalid repo key: ${JSON.stringify(repoKey)}`);
  }
  return repoKey;
}

export function assertSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

function sessionBase(sessionId: string): string {
  return `/sessions/${assertSessionId(sessionId)}`;
}

export const sessionRoutes = {
  /** GET */
  state: (id: string) => sessionBase(id),
  /** POST */
  ensure: (id: string) => `${sessionBase(id)}/ensure`,
  /** POST */
  stop: (id: string) => `${sessionBase(id)}/stop`,
  /** DELETE */
  remove: (id: string) => sessionBase(id),
  /** POST */
  exec: (id: string) => `${sessionBase(id)}/exec`,
  /** POST */
  writeBatch: (id: string) => `${sessionBase(id)}/files/write-batch`,
  /** POST */
  readFile: (id: string) => `${sessionBase(id)}/files/read`,
  /** POST */
  exists: (id: string) => `${sessionBase(id)}/files/exists`,
  /** POST */
  listFiles: (id: string) => `${sessionBase(id)}/files/list`,
  /** POST */
  opencodeStart: (id: string) => `${sessionBase(id)}/opencode/start`,
  /** ANY — append the in-container path and query verbatim. */
  proxy: (id: string, pathAndQuery: string) =>
    `${sessionBase(id)}/proxy${pathAndQuery.startsWith('/') ? '' : '/'}${pathAndQuery}`,
  /** POST — snapshot-capable hosts only. */
  snapshot: (id: string) => `${sessionBase(id)}/snapshot`,
  /** POST — snapshot-capable hosts only. */
  snapshotRestore: (id: string) => `${sessionBase(id)}/snapshot/restore`,
  /** POST — prebuild-capable hosts only. */
  prebuildPromote: (id: string) => `${sessionBase(id)}/prebuild/promote`
} as const;

/** Host-level prebuild inventory, beside the per-session routes. */
export const prebuildRoutes = {
  /** GET */
  list: () => '/prebuilds',
  /** DELETE */
  remove: (repoKey: string) => `/prebuilds/${assertRepoKey(repoKey)}`
} as const;

export interface PrebuildRouteMatch {
  route: 'list' | 'remove';
  repoKey?: string;
}

export function matchPrebuildRoute(
  method: string,
  pathname: string
): PrebuildRouteMatch | null {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'prebuilds') return null;
  if (parts.length === 1) {
    return method === 'GET' ? { route: 'list' } : null;
  }
  if (parts.length === 2 && method === 'DELETE') {
    const repoKey = parts[1]!;
    if (!REPO_KEY_PATTERN.test(repoKey)) return null;
    return { route: 'remove', repoKey };
  }
  return null;
}

/**
 * Parse an incoming request path into a route match. Host implementations
 * (worker and agent) share this dispatch shape; the agent re-implements it in
 * plain JS following PROTOCOL.md.
 */
export interface RouteMatch {
  sessionId: string;
  route:
    | 'state'
    | 'ensure'
    | 'stop'
    | 'remove'
    | 'exec'
    | 'write-batch'
    | 'read'
    | 'exists'
    | 'list'
    | 'opencode-start'
    | 'proxy'
    | 'snapshot'
    | 'snapshot-restore'
    | 'prebuild-promote';
  /** For proxy routes: the in-container path (leading slash), no query. */
  proxyPath?: string;
}

export function matchSessionRoute(
  method: string,
  pathname: string
): RouteMatch | null {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'sessions' || parts.length < 2) return null;
  const sessionId = parts[1]!;
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const rest = parts.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') return { sessionId, route: 'state' };
    if (method === 'DELETE') return { sessionId, route: 'remove' };
    return null;
  }
  if (rest[0] === 'proxy') {
    return { sessionId, route: 'proxy', proxyPath: `/${rest.slice(1).join('/')}` };
  }
  if (method !== 'POST') return null;
  const tail = rest.join('/');
  switch (tail) {
    case 'ensure':
      return { sessionId, route: 'ensure' };
    case 'stop':
      return { sessionId, route: 'stop' };
    case 'exec':
      return { sessionId, route: 'exec' };
    case 'files/write-batch':
      return { sessionId, route: 'write-batch' };
    case 'files/read':
      return { sessionId, route: 'read' };
    case 'files/exists':
      return { sessionId, route: 'exists' };
    case 'files/list':
      return { sessionId, route: 'list' };
    case 'opencode/start':
      return { sessionId, route: 'opencode-start' };
    case 'snapshot':
      return { sessionId, route: 'snapshot' };
    case 'snapshot/restore':
      return { sessionId, route: 'snapshot-restore' };
    case 'prebuild/promote':
      return { sessionId, route: 'prebuild-promote' };
    default:
      return null;
  }
}
