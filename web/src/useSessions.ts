import { useCallback, useEffect, useRef, useState } from 'react';
import { listSessions, type SessionView } from './api';

const POLL_INTERVAL_MS = 5_000;

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
 * Refresh failures while a list is already on screen are kept quiet — a dropped
 * poll is usually a sleeping laptop, and blanking the page for it would be
 * worse than showing data that is a few seconds stale.
 */
export function useSessions() {
  const [sessions, setSessions] = useState<SessionView[]>();
  const [error, setError] = useState<string>();
  const loaded = useRef(false);

  const refresh = useCallback(async (silent = false) => {
    try {
      const next = await listSessions();
      setSessions(next);
      loaded.current = true;
      setError(undefined);
    } catch (cause) {
      if (!silent || !loaded.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

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

  return { sessions, error, refresh };
}
