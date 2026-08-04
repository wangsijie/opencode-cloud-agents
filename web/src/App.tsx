import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchAuthState,
  fetchCatalog,
  fetchSettingsStatus,
  signOut,
  UNAUTHORIZED_EVENT,
  type Catalog,
  type SessionView
} from './api';
import { enteredNewSessionPage, catalogForRoute } from './catalog-refresh';
import { AgentSessionPage } from './components/AgentSessionPage';
import { NewSessionPage } from './components/NewSessionPage';
import { SessionPage } from './components/SessionPage';
import { SettingsPage } from './components/SettingsPage';
import { SetupPasswordPage } from './components/SetupPasswordPage';
import { Sidebar } from './components/Sidebar';
import { SignInPage } from './components/SignInPage';
import { navigate, settingsPath, useRoute } from './router';
import { useSessions } from './useSessions';

/**
 * The password gate.
 *
 * It stands outside the app rather than inside it so that a signed-out browser
 * mounts none of the hooks below — no session poll, no catalog fetch, nothing
 * that would answer 401 in a loop. The first render asks the Hub which state
 * this browser is in and shows neither until it knows: flashing the sign-in
 * form at somebody who is already signed in reads as being logged out.
 *
 * First run comes before either: a deployment with no admin password shows
 * the setup page and nothing else, whatever the URL says — the gates are
 * ordered by render, not by route, so none of them can be navigated around.
 */
export function App() {
  const [auth, setAuth] = useState<{
    authenticated: boolean;
    passwordConfigured: boolean;
  }>();

  useEffect(() => {
    void fetchAuthState()
      .then(setAuth)
      .catch(() =>
        setAuth({ authenticated: false, passwordConfigured: true })
      );
  }, []);

  useEffect(() => {
    const signedOut = () =>
      setAuth((state) =>
        state ? { ...state, authenticated: false } : state
      );
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  }, []);

  const signedIn = () =>
    setAuth({ authenticated: true, passwordConfigured: true });

  if (auth === undefined) {
    return null;
  }
  if (!auth.passwordConfigured) {
    return <SetupPasswordPage onComplete={signedIn} />;
  }
  if (!auth.authenticated) {
    return <SignInPage onSignedIn={signedIn} />;
  }
  return (
    <SettingsGate
      onSignedOut={() =>
        setAuth({ authenticated: false, passwordConfigured: true })
      }
    />
  );
}

/**
 * The second gate: required settings.
 *
 * A signed-in Hub whose GitHub token, OpenCode config or SSH key is missing
 * cannot start or run sessions, so the settings page is forced — alone, with
 * no sidebar and no polling underneath — until the required list is empty.
 */
function SettingsGate({ onSignedOut }: { onSignedOut: () => void }) {
  const [missing, setMissing] = useState<string[]>();
  // Once the gate has shown the forced page it stays until the operator says
  // to continue: filling the last required setting must not yank the page
  // away mid-flow — generating the SSH key was ejecting people before they
  // could copy the public key it had just shown.
  const wasForced = useRef(false);
  const [entered, setEntered] = useState(false);

  const check = useCallback(async () => {
    try {
      setMissing((await fetchSettingsStatus()).missing);
    } catch {
      // Reachability problems surface on the pages themselves; the gate only
      // acts on a positive "something is missing".
      setMissing([]);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (missing === undefined) {
    return null;
  }
  if (missing.length > 0) {
    wasForced.current = true;
  }
  if (missing.length > 0 || (wasForced.current && !entered)) {
    return (
      <SettingsPage
        forced
        onSettingsChanged={() => void check()}
        onContinue={missing.length === 0 ? () => setEntered(true) : undefined}
      />
    );
  }
  return <Hub onSignedOut={onSignedOut} />;
}

// Whether the session list is folded away, remembered the way the panel widths
// are: it says how this person likes their window, which is true of every
// session they open and belongs to the browser rather than to the Hub.
const COLLAPSED_KEY = 'hub.sidebarCollapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The shell: past sessions on the left, one conversation on the right.
 *
 * Both live here rather than in the pages because the history is navigation —
 * it stays put while the conversation beside it changes, so it must not be
 * re-fetched by whatever is currently on screen.
 *
 * The catalog is fetched on arrival and when the new-session page is entered;
 * the session list polls, because its state changes underneath the page as
 * containers wake, work and sleep.
 */
function Hub({ onSignedOut }: { onSignedOut: () => void }) {
  const route = useRoute();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readCollapsed);
  const refreshedStale = useRef(false);
  const catalogRef = useRef<Catalog | undefined>(undefined);
  const previousRoute = useRef(route.name);

  const { sessions, error: listError, refresh } = useSessions();

  const loadCatalog = useCallback(async (refreshRepos = false) => {
    try {
      const next = await fetchCatalog(refreshRepos);
      catalogRef.current = next;
      setCatalog(next);
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

  // Hiding happens during this render, not in the refresh effect below: the
  // effect runs after the composer has already mounted and applied defaults
  // from whatever catalog was in state — last visit's order — and a default
  // that is still a valid option then survives the fresh read forever. So the
  // new-session page sees no catalog until the reordered one lands.
  const shownCatalog = catalogForRoute(route.name, previousRoute.current, catalog);

  useEffect(() => {
    const enteringNewSession = enteredNewSessionPage(
      previousRoute.current,
      route.name
    );
    previousRoute.current = route.name;
    if (!enteringNewSession) {
      return;
    }

    // A normal catalog read keeps GitHub's stored list but reorders it from
    // current session use. Hide the old order while it loads so the composer
    // does not preserve yesterday's valid selection over the new first repo.
    const previousCatalog = catalogRef.current;
    setCatalog(undefined);
    void loadCatalog().catch(() => {
      if (previousCatalog) {
        catalogRef.current = previousCatalog;
        setCatalog(previousCatalog);
      }
    });
  }, [loadCatalog, route.name]);

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

  const collapseSidebar = useCallback((next: boolean) => {
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {
      // A browser that refuses storage still folds the panel; it just forgets.
    }
  }, []);

  // One control on the pages, two surfaces: on a phone it opens the drawer, on
  // a desktop it brings a folded sidebar back. Neither state harms the other —
  // the drawer classes only mean anything below 768px, the fold only above.
  const openSidebar = useCallback(() => {
    setSidebarOpen(true);
    collapseSidebar(false);
  }, [collapseSidebar]);

  const sessionsChanged = useCallback(() => void refresh(true), [refresh]);

  // The create response, kept until the polled list has caught up. A new
  // session's row is written by its own agent a beat after the response, so the
  // first poll can still miss it; showing the response's view bridges that gap
  // the same way the optimistic bubble bridges a send.
  const [justCreated, setJustCreated] = useState<SessionView>();
  const sidebarSessions = useMemo(() => {
    if (!justCreated) {
      return sessions;
    }
    if (sessions?.some((session) => session.id === justCreated.id)) {
      return sessions;
    }
    return [justCreated, ...(sessions ?? [])];
  }, [sessions, justCreated]);
  useEffect(() => {
    if (justCreated && sessions?.some((session) => session.id === justCreated.id)) {
      setJustCreated(undefined);
    }
  }, [sessions, justCreated]);

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar
        sessions={sidebarSessions}
        listError={listError}
        activeId={route.name === 'session' ? route.id : undefined}
        refresh={refresh}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onCollapse={() => collapseSidebar(true)}
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
        {route.name === 'settings' ? (
          <SettingsPage
            forced={false}
            section={route.section}
            onSelectSection={(id) => navigate(settingsPath(id))}
            onMenu={openSidebar}
            onSettingsChanged={() => undefined}
          />
        ) : route.name === 'session' && route.agent ? (
          // Keyed to the subagent as well as the session, so stepping between
          // levels of a nest never shows one conversation under another's name.
          <AgentSessionPage
            key={`${route.id}/${route.agent}`}
            sessionId={route.id}
            agentSessionId={route.agent}
            onMenu={openSidebar}
          />
        ) : route.name === 'session' ? (
          // Keyed to the session: switching straight from one conversation to
          // another must not carry over the previous one's transcript, draft or
          // model.
          <SessionPage
            key={route.id}
            sessionId={route.id}
            catalog={catalog}
            onMenu={openSidebar}
            onSessionsChanged={sessionsChanged}
          />
        ) : (
          <NewSessionPage
            catalog={shownCatalog}
            catalogError={catalogError}
            onRefreshRepos={() => loadCatalog(true)}
            onCreated={(created) => {
              setJustCreated(created);
              sessionsChanged();
            }}
            onMenu={openSidebar}
          />
        )}
      </div>
    </div>
  );
}
