import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAuthState,
  fetchCatalog,
  signOut,
  UNAUTHORIZED_EVENT,
  type Catalog
} from './api';
import { AgentSessionPage } from './components/AgentSessionPage';
import { NewSessionPage } from './components/NewSessionPage';
import { SessionPage } from './components/SessionPage';
import { Sidebar } from './components/Sidebar';
import { SignInPage } from './components/SignInPage';
import { useRoute } from './router';
import { useSessions } from './useSessions';

/**
 * The password gate.
 *
 * It stands outside the app rather than inside it so that a signed-out browser
 * mounts none of the hooks below — no session poll, no catalog fetch, nothing
 * that would answer 401 in a loop. The first render asks the Hub which state
 * this browser is in and shows neither until it knows: flashing the sign-in
 * form at somebody who is already signed in reads as being logged out.
 */
export function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();

  useEffect(() => {
    void fetchAuthState()
      .then((state) => setAuthenticated(state.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  useEffect(() => {
    const signedOut = () => setAuthenticated(false);
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  }, []);

  if (authenticated === undefined) {
    return null;
  }
  if (!authenticated) {
    return <SignInPage onSignedIn={() => setAuthenticated(true)} />;
  }
  return <Hub onSignedOut={() => setAuthenticated(false)} />;
}

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
function Hub({ onSignedOut }: { onSignedOut: () => void }) {
  const route = useRoute();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const refreshedStale = useRef(false);

  const { sessions, error: listError, refresh } = useSessions(
    showArchived ? '1' : undefined
  );

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
        onSignOut={async () => {
          await signOut();
          onSignedOut();
        }}
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
        {route.name === 'session' && route.agent ? (
          // Keyed to the subagent as well as the session, so stepping between
          // levels of a nest never shows one conversation under another's name.
          <AgentSessionPage
            key={`${route.id}/${route.agent}`}
            sessionId={route.id}
            agentSessionId={route.agent}
            onMenu={() => setSidebarOpen(true)}
          />
        ) : route.name === 'session' ? (
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
