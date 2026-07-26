import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCatalog, type Catalog } from './api';
import { NewSessionPage } from './components/NewSessionPage';
import { SessionPage } from './components/SessionPage';
import { Sidebar } from './components/Sidebar';
import { useRoute } from './router';
import { useCompletionNotice } from './useCompletionNotice';
import { useSessions } from './useSessions';

/**
 * The shell: past sessions on the left, one conversation on the right.
 *
 * Both live here rather than in the pages because the history is navigation —
 * it stays put while the conversation beside it changes, so it must not be
 * re-fetched by whatever is currently on screen.
 *
 * The catalog is fetched once; the session list polls, because its state
 * changes underneath the page as containers wake, work and sleep.
 */
export function App() {
  const route = useRoute();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const refreshedStale = useRef(false);

  const { sessions, error: listError, refresh } = useSessions(
    showArchived ? '1' : undefined
  );
  // One notice for the whole app: the list polls on every route now, so an open
  // conversation is covered by the same hook that covers the ones that are not.
  useCompletionNotice(sessions);

  const loadCatalog = useCallback(async (refreshRepos = false) => {
    try {
      setCatalog(await fetchCatalog(refreshRepos));
      setCatalogError(undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setCatalogError(message);
      throw cause;
    }
  }, []);

  useEffect(() => {
    void loadCatalog().catch(() => undefined);
  }, [loadCatalog]);

  /*
    The Hub keeps GitHub's answer for good and hands it over without asking
    GitHub again, so somebody has to notice it has gone stale — that is the
    page, once, after it has rendered with the stored list. Failing is fine:
    the stored list is still what the composer is showing, and the next visit
    tries again.
  */
  useEffect(() => {
    if (!catalog?.reposStale || refreshedStale.current) {
      return;
    }
    refreshedStale.current = true;
    void loadCatalog(true).catch(() => undefined);
  }, [catalog?.reposStale, loadCatalog]);

  // Going somewhere is the end of the drawer's usefulness, and this covers the
  // browser's own back and forward too.
  useEffect(() => {
    setSidebarOpen(false);
  }, [route]);

  const sessionsChanged = useCallback(() => void refresh(true), [refresh]);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        listError={listError}
        activeId={route.name === 'session' ? route.id : undefined}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((value) => !value)}
        refresh={refresh}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen ? (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close sessions"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <div className="content">
        {route.name === 'session' ? (
          // Keyed to the session: switching straight from one conversation to
          // another must not carry over the previous one's transcript, draft or
          // model.
          <SessionPage
            key={route.id}
            sessionId={route.id}
            catalog={catalog}
            onMenu={() => setSidebarOpen(true)}
            onSessionsChanged={sessionsChanged}
          />
        ) : (
          <NewSessionPage
            catalog={catalog}
            catalogError={catalogError}
            onRefreshRepos={() => loadCatalog(true)}
            onCreated={sessionsChanged}
            onMenu={() => setSidebarOpen(true)}
          />
        )}
      </div>
    </div>
  );
}
