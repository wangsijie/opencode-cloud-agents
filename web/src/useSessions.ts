import { useCallback, useEffect, useRef, useState } from 'react';
import { listSessions, type SessionView } from './api';

const POLL_INTERVAL_MS = 5_000;

/** How many sessions the sidebar shows at first, and grows by. */
export const SESSION_PAGE_SIZE = 20;

/**
 * The session list, kept fresh by polling.
 *
 * The Hub serves idle and sleeping rows from a D1 runtime cache, so a page
 * left open does not fan out to every container. Only sessions still marked
 * for status query (busy, waking, unfinished dispatch, …) are calibrated
 * against their Durable Objects and host — and that path never wakes them.
 * Polling pauses on a hidden tab to avoid pointless requests from a
 * backgrounded phone.
 *
 * It is also paged, because that calibration is per row and every poll pays it
 * again: an account with hundreds of sessions was loading — and rechecking,
 * every five seconds — a whole history to fill one screen of sidebar. The page
 * only ever grows, and it grows for the polls too, so scrolling back never
 * un-loads itself on the next tick.
 *
 * One row more than the page is asked for and then dropped: it is how the
 * sidebar knows whether a "show more" button is worth drawing, at no extra
 * request. The Hub orders the list the same way the sidebar renders it, so a
 * page is a prefix and growing one can only append.
 *
 * Refresh failures while a list is already on screen are kept quiet — a dropped
 * poll is usually a sleeping laptop, and blanking the page for it would be
 * worse than showing data that is a few seconds stale.
 */
export function useSessions() {
  const [sessions, setSessions] = useState<SessionView[]>();
  const [error, setError] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const loaded = useRef(false);
  // Read by the poll, so growing the page does not restart the timer, and the
  // interval never captures a stale size.
  const pageSize = useRef(SESSION_PAGE_SIZE);

  const refresh = useCallback(async (silent = false) => {
    const size = pageSize.current;
    try {
      const next = await listSessions(size + 1);
      setSessions(next.slice(0, size));
      setHasMore(next.length > size);
      loaded.current = true;
      setError(undefined);
    } catch (cause) {
      if (!silent || !loaded.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  const showMore = useCallback(async () => {
    pageSize.current += SESSION_PAGE_SIZE;
    await refresh(true);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh(true);
      }
    }, POLL_INTERVAL_MS);
    // Coming back to a backgrounded tab should not show a stale list for up to
    // a whole interval — containers wake and sleep while nobody is looking.
    const onVisible = () => {
      if (!document.hidden) {
        void refresh(true);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { sessions, error, refresh, hasMore, showMore };
}
