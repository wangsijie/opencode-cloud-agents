import { useEffect, useState } from 'react';
import { fetchCatalog, listSessions, type Catalog, type SessionSummary } from './api';

/**
 * Scaffolding shell for the Hub SPA.
 *
 * S4 exists to prove the delivery pipeline end to end — build, static asset
 * hosting, same-origin API access — so this page reads the two endpoints the
 * real UI is built on and reports what it found. The session list and composer
 * replace it in S5, and the session view arrives in S6.
 */
export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSessions(), fetchCatalog()])
      .then(([loadedSessions, loadedCatalog]) => {
        if (cancelled) {
          return;
        }
        setSessions(loadedSessions);
        setCatalog(loadedCatalog);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="page">
      <header className="masthead">
        <h1>OpenCode Hub</h1>
        <span className="muted">M3 · S4 脚手架</span>
      </header>

      {error ? (
        <section className="card error">
          <h2>无法读取 Hub API</h2>
          <p className="muted">{error}</p>
        </section>
      ) : !sessions || !catalog ? (
        <section className="card">
          <p className="muted">正在读取…</p>
        </section>
      ) : (
        <>
          <section className="stat-row">
            <div className="stat">
              <b>{sessions.length}</b>
              <span className="muted">会话</span>
            </div>
            <div className="stat">
              <b>{catalog.repos.length}</b>
              <span className="muted">仓库</span>
            </div>
            <div className="stat">
              <b>{catalog.models.length}</b>
              <span className="muted">模型</span>
            </div>
          </section>

          <section className="card">
            <h2>接下来</h2>
            <p className="muted">
              S5 把会话列表与 composer 迁进来，S6 加会话详情页与消息渲染器。
              在那之前，完整的 Hub 仍在 <code>/</code>。
            </p>
          </section>
        </>
      )}
    </main>
  );
}
