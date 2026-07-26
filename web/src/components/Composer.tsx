import { useEffect, useState, type FormEvent } from 'react';
import { createSession, type Catalog } from '../api';

/**
 * Start a session from a repository, a model and a prompt.
 *
 * Submitting returns as soon as the Hub has accepted the work — the container
 * wake, the repository clone and the first dispatch all happen afterwards — so
 * the form clears immediately and the new card tracks progress from the list.
 *
 * The catalog arrives from GitHub a moment after the page does, so the form
 * renders without it and the pickers say they are loading. Waiting would make
 * the whole composer pop in late, which reads as a broken page.
 */
export function Composer({
  catalog,
  onCreated,
  onRefreshRepos
}: {
  catalog?: Catalog;
  onCreated: () => Promise<void>;
  onRefreshRepos: () => Promise<void>;
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
    if (!text) {
      setError('Describe what you want done first');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await createSession({ repoKey, model, prompt: text });
      setPrompt('');
      await onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card composer" onSubmit={submit} aria-busy={busy || loading}>
      <textarea
        className="prompt"
        rows={3}
        placeholder="What should we do this time?"
        value={prompt}
        disabled={busy}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className="composer-controls">
        <select
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
          The stored list is only re-read from GitHub when the page finds it
          stale, so a repository created a minute ago needs a way to ask now.
        */}
        <button
          className="button"
          type="button"
          disabled={busy || loading || refreshing}
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
          {refreshing ? 'Refreshing…' : 'Refresh repos'}
        </button>
        <button
          className="button primary"
          type="submit"
          disabled={busy || loading}
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
