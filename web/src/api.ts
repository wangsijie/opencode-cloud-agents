/**
 * The Hub API, as seen from the browser.
 *
 * Per decision D6 the UI only ever talks to `/api/sessions*` on its own origin.
 * Whether a session is awake (proxied live) or asleep (served from a mirror,
 * once M4 lands) is the Worker's problem, not this layer's.
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

export interface SessionSummary {
  id: string;
  repoKey: string;
  model: string;
  title: string;
  status: SessionStatus;
  lastActivityAt: string;
  lastError?: string;
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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    // The Worker reports failures as `{ error }`, but an unauthenticated
    // request can be intercepted by Access and answer with HTML instead.
    const detail = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(detail ?? `${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export const listSessions = () => getJson<SessionSummary[]>('/api/sessions');
export const fetchCatalog = () => getJson<Catalog>('/api/catalog');
