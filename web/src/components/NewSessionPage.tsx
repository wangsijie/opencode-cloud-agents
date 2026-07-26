import { useEffect, useState, type FormEvent } from 'react';
import { createSession, type Catalog } from '../api';
import { navigate, sessionPath } from '../router';
import { ArrowUpIcon, MenuIcon, RefreshIcon, SparkIcon } from './icons';

/**
 * Where a session starts: a repository, a model and a prompt.
 *
 * Creating returns as soon as the Hub has accepted the work — the container
 * wake, the repository clone and the first dispatch all happen afterwards — so
 * this hands over to the conversation immediately and lets that page show the
 * cold start as progress.
 *
 * The catalog arrives from GitHub a moment after the page does, so the form
 * renders without it and the pickers say they are loading. Waiting would make
 * the whole page pop in late, which reads as broken.
 */
export function NewSessionPage({
  catalog,
  catalogError,
  onRefreshRepos,
  onCreated,
  onMenu
}: {
  catalog?: Catalog;
  catalogError?: string;
  onRefreshRepos: () => Promise<void>;
  onCreated: () => void;
  onMenu: () => void;
}) {
  const [repoKey, setRepoKey] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const repos = catalog?.repos;

  // The catalog lands after the first paint, and a refresh can drop the
  // selected repository, so the defaults are applied here rather than in
  // useState. The Hub sorts by last use, so the first entry is the repository
  // the last session ran in.
  useEffect(() => {
    if (!repos || repos.length === 0) {
      return;
    }
    setRepoKey((current) =>
      repos.some((repo) => repo.repoKey === current) ? current : repos[0].repoKey
    );
  }, [repos]);

  useEffect(() => {
    const models = catalog?.models;
    if (!models || models.length === 0) {
      return;
    }
    setModel((current) =>
      models.some((option) => option.id === current) ? current : models[0].id
    );
  }, [catalog?.models]);

  const loading = !catalog;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) {
      setError(text ? undefined : 'Describe what you want done first');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const created = await createSession({ repoKey, model, prompt: text });
      setPrompt('');
      onCreated();
      navigate(sessionPath(created.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="session-view">
      {/* Nothing but the drawer button lives here, so it carries no rule: an
          empty bordered strip above an otherwise empty page reads as a bug. */}
      <header className="content-header bare">
        <button
          className="icon-button hamburger"
          type="button"
          onClick={onMenu}
          aria-label="Open sessions"
        >
          <MenuIcon />
        </button>
      </header>

      <div className="content-body">
        <div className="new-session">
          <h1 className="greeting">
            <SparkIcon />
            What should we build?
          </h1>

          {/*
            Only a failure that leaves nothing to pick from replaces the
            composer: with a list in hand — stored by the Hub from an earlier
            visit — a failed refresh changes nothing about what can be started.
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
            <form className="composer-box" onSubmit={submit} aria-busy={busy || loading}>
              <textarea
                className="prompt"
                rows={3}
                placeholder="What should we do this time?"
                value={prompt}
                disabled={busy}
                autoFocus={matchMedia('(min-width: 768px)').matches}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  // Enter starts the session, Shift+Enter breaks the line — but
                  // not while an input method is mid-composition, where Enter is
                  // how you accept the candidate you are typing.
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submit(event);
                  }
                }}
              />
              <div className="composer-row">
                <select
                  className="pill-select"
                  aria-label="Repository"
                  value={repoKey}
                  disabled={busy || loading}
                  onChange={(event) => setRepoKey(event.target.value)}
                >
                  {loading ? (
                    <option value="">Loading repositories…</option>
                  ) : (
                    catalog.repos.map((repo) => (
                      <option key={repo.repoKey} value={repo.repoKey}>
                        {repo.displayName}
                      </option>
                    ))
                  )}
                </select>
                <select
                  className="pill-select"
                  aria-label="Model"
                  value={model}
                  disabled={busy || loading}
                  onChange={(event) => setModel(event.target.value)}
                >
                  {loading ? (
                    <option value="">Loading models…</option>
                  ) : (
                    catalog.models.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.displayName}
                      </option>
                    ))
                  )}
                </select>
                {/*
                  The stored list is only re-read from GitHub when the page
                  finds it stale, so a repository created a minute ago needs a
                  way to ask now.
                */}
                <button
                  className="icon-button"
                  type="button"
                  disabled={busy || loading || refreshing}
                  aria-label="Refresh the repository list"
                  title="Re-read the repository list from GitHub"
                  onClick={async () => {
                    setRefreshing(true);
                    setError(undefined);
                    try {
                      await onRefreshRepos();
                    } catch (cause) {
                      setError(cause instanceof Error ? cause.message : String(cause));
                    } finally {
                      setRefreshing(false);
                    }
                  }}
                >
                  <RefreshIcon />
                </button>
                <span className="spacer" />
                <button
                  className="send-button"
                  type="submit"
                  disabled={busy || loading || !prompt.trim()}
                  aria-label="Start session"
                >
                  <ArrowUpIcon />
                </button>
              </div>
              {error ? <p className="form-error">{error}</p> : null}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
