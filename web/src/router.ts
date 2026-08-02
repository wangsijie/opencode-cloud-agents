import { useEffect, useState } from 'react';

/**
 * Three routes do not need a routing library.
 *
 * The Worker serves the same shell for every navigable path, so the SPA reads
 * `location.pathname` and keeps the History API in sync.
 *
 * `section` is a settings tab. It is in the path because a tab worth linking
 * to needs an address — and because prebuilds, which used to be a page of its
 * own at `/prebuilds`, is one of those tabs now; that address still resolves,
 * so anything pointing at it keeps working.
 *
 * `agent` is a subagent session inside the session named by `id`. It hangs off
 * the session rather than standing on its own because that is what it is: the
 * Hub registers one session per container, and a subagent only exists inside
 * one. Nesting is not in the path — a subagent that started its own subagent
 * has the same two-part shape — because the depth is a fact about the
 * conversation, and the conversation is what knows it.
 */
export type Route =
  | { name: 'list' }
  | { name: 'settings'; section?: string }
  | { name: 'session'; id: string; agent?: string };

export function parseRoute(pathname: string): Route {
  const settings = /^\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  if (settings) {
    return {
      name: 'settings',
      ...(settings[1] ? { section: decodeURIComponent(settings[1]) } : {})
    };
  }
  if (/^\/prebuilds\/?$/.test(pathname)) {
    return { name: 'settings', section: 'prebuilds' };
  }
  const match = /^\/sessions\/([^/]+)(?:\/agent\/([^/]+))?\/?$/.exec(pathname);
  if (!match) {
    return { name: 'list' };
  }
  return {
    name: 'session',
    id: decodeURIComponent(match[1]),
    ...(match[2] ? { agent: decodeURIComponent(match[2]) } : {})
  };
}

/** Let a modifier-click or middle-click behave like the link it is. */
export function isPlainClick(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  button: number;
}): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0);
}

export function navigate(path: string): void {
  if (path !== location.pathname) {
    history.pushState(null, '', path);
    dispatchEvent(new PopStateEvent('popstate'));
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  return route;
}

export const settingsPath = (section?: string) =>
  section ? `/settings/${encodeURIComponent(section)}` : '/settings';

export const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;

export const agentPath = (id: string, agentSessionId: string) =>
  `${sessionPath(id)}/agent/${encodeURIComponent(agentSessionId)}`;
