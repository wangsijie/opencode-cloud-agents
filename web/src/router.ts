import { useEffect, useState } from 'react';

/**
 * Two routes do not need a routing library.
 *
 * The Worker serves the same shell for every navigable path, so the SPA reads
 * `location.pathname` and keeps the History API in sync.
 */
export type Route = { name: 'list' } | { name: 'session'; id: string };

export function parseRoute(pathname: string): Route {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(pathname);
  return match ? { name: 'session', id: decodeURIComponent(match[1]) } : { name: 'list' };
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

export const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
