import { useCallback, useEffect, useState } from 'react';
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
 * The catalog is fetched once — repositories and models come from static
 * configuration — while the session list polls, because its state changes
 * underneath the page as containers wake, work and sleep.
 */
export function App() {
  const route = useRoute();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState<string>();

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
            {sessions.length} 个会话 · {runningCount} 个醒着
          </span>
        ) : null}
      </header>

      <div className="list-controls">
        <button
          className="link-button"
          onClick={() => setShowArchived((value) => !value)}
        >
          {showArchived ? '← 回到进行中' : '查看已归档'}
        </button>
        {/*
          Asking for notification permission has to come from a click, so it is
          a button rather than something the page does on load.
        */}
        {permission === 'default' ? (
          <button className="link-button" onClick={() => void request()}>
            任务完成时通知我
          </button>
        ) : permission === 'denied' ? (
          <span className="muted">通知已被浏览器拒绝</span>
        ) : null}
      </div>

      {/*
        The repository list has no local fallback: GitHub is the only source, so
        a failure here means no session can be started, and saying so plainly
        beats an empty picker that reads as "you have no repositories".
      */}
      {catalogError ? (
        <section className="card error">
          <h2>无法读取仓库列表</h2>
          <p className="muted">{catalogError}</p>
          <div className="actions">
            <button
              className="button"
              onClick={() => void onRefreshRepos().catch(() => undefined)}
            >
              重试
            </button>
          </div>
        </section>
      ) : catalog ? (
        <Composer
          catalog={catalog}
          onCreated={refresh}
          onRefreshRepos={onRefreshRepos}
        />
      ) : null}

      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      {listError ? (
        <section className="card error">
          <h2>无法读取会话列表</h2>
          <p className="muted">{listError}</p>
        </section>
      ) : !sessions ? (
        <p className="muted">正在读取…</p>
      ) : sessions.length === 0 ? (
        <section className="card empty">
          <strong>{showArchived ? '没有已归档的会话' : '还没有会话'}</strong>
          <p className="muted">
            {showArchived
              ? '归档过的会话会出现在这里，历史与容器都还在。'
              : '在上面写下任务并选择仓库与模型即可开工。'}
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
