import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCatalog, type Catalog } from './api';
import { Composer } from './components/Composer';
import { SessionCard } from './components/SessionCard';
import { SessionPage } from './components/SessionPage';
import { useRoute } from './router';
import { useCompletionNotice, useNotificationOptIn } from './useCompletionNotice';
import { useSessions } from './useSessions';

/**
 * The Hub home page: what is running, and how to start something new.
 *
 * The catalog is fetched once, and the session list polls, because its state
 * changes underneath the page as containers wake, work and sleep.
 */
export function App() {
  const route = useRoute();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const refreshedStale = useRef(false);

  const loadCatalog = useCallback(async (refresh = false) => {
    try {
      setCatalog(await fetchCatalog(refresh));
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

  return route.name === 'session' ? (
    <SessionPage sessionId={route.id} catalog={catalog} />
  ) : (
    <SessionList
      catalog={catalog}
      catalogError={catalogError}
      onRefreshRepos={() => loadCatalog(true)}
    />
  );
}

function SessionList({
  catalog,
  catalogError,
  onRefreshRepos
}: {
  catalog?: Catalog;
  catalogError?: string;
  onRefreshRepos: () => Promise<void>;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { sessions, error: listError, refresh } = useSessions(
    showArchived ? '1' : undefined
  );
  const [actionError, setActionError] = useState<string>();
  const { permission, request } = useNotificationOptIn();
  useCompletionNotice(sessions);

  const runningCount = sessions?.filter((session) =>
    ['working', 'idle'].includes(session.status)
  ).length;

  return (
    <main className="page">
      <header className="masthead">
        <h1>OpenCode Hub</h1>
        {sessions ? (
          <span className="muted">
            {sessions.length} sessions · {runningCount} awake
          </span>
        ) : null}
      </header>

      <div className="list-controls">
        <button
          className="link-button"
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? '← Back to active' : 'View archived'}
        </button>
        {/*
          Asking for notification permission has to come from a click, so it is
          a button rather than something the page does on load.
        */}
        {permission === 'default' ? (
          <button className="link-button" onClick={() => void request()}>
            Notify me when a task finishes
          </button>
        ) : permission === 'denied' ? (
          <span className="muted">Notifications blocked by the browser</span>
        ) : null}
      </div>

      {/*
        Only a failure that leaves nothing to pick from replaces the composer:
        with a list in hand — stored by the Hub from an earlier visit — a failed
        refresh changes nothing about what can be started, and the composer
        reports the ones the user asked for itself.
      */}
      {catalogError && !catalog ? (
        <section className="card error">
          <h2>Could not load the repository list</h2>
          <p className="muted">{catalogError}</p>
          <div className="actions">
            <button
              className="button"
              onClick={() => void onRefreshRepos().catch(() => undefined)}
            >
              Retry
            </button>
          </div>
        </section>
      ) : (
        <Composer
          catalog={catalog}
          onCreated={refresh}
          onRefreshRepos={onRefreshRepos}
        />
      )}

      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      {listError ? (
        <section className="card error">
          <h2>Could not load the session list</h2>
          <p className="muted">{listError}</p>
        </section>
      ) : !sessions ? (
        <p className="muted">Loading…</p>
      ) : sessions.length === 0 ? (
        <section className="card empty">
          <strong>{showArchived ? 'No archived sessions' : 'No sessions yet'}</strong>
          <p className="muted">
            {showArchived
              ? 'Archived sessions show up here, with their history and containers intact.'
              : 'Describe a task above, pick a repo and a model, and get going.'}
          </p>
        </section>
      ) : (
        <section className="session-list">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onChanged={() => refresh(true)}
              onError={setActionError}
            />
          ))}
        </section>
      )}
    </main>
  );
}
