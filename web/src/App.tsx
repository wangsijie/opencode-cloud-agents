import { useEffect, useState } from 'react';
import { fetchCatalog, type Catalog } from './api';
import { Composer } from './components/Composer';
import { SessionCard } from './components/SessionCard';
import { useSessions } from './useSessions';

/**
 * The Hub home page: what is running, and how to start something new.
 *
 * The catalog is fetched once — repositories and models come from static
 * configuration — while the session list polls, because its state changes
 * underneath the page as containers wake, work and sleep.
 */
export function App() {
  const { sessions, error: listError, refresh } = useSessions();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogError, setCatalogError] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    fetchCatalog()
      .then(setCatalog)
      .catch((cause: unknown) =>
        setCatalogError(cause instanceof Error ? cause.message : String(cause))
      );
  }, []);

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

      {catalogError ? (
        <section className="card error">
          <h2>无法读取仓库与模型目录</h2>
          <p className="muted">{catalogError}</p>
        </section>
      ) : catalog ? (
        <Composer catalog={catalog} onCreated={refresh} />
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
          <strong>还没有会话</strong>
          <p className="muted">在上面写下任务并选择仓库与模型即可开工。</p>
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
