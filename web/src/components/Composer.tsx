import { useState, type FormEvent } from 'react';
import { createSession, type Catalog } from '../api';

/**
 * Start a session from a repository, a model and a prompt.
 *
 * Submitting returns as soon as the Hub has accepted the work — the container
 * wake, the repository clone and the first dispatch all happen afterwards — so
 * the form clears immediately and the new card tracks progress from the list.
 */
export function Composer({
  catalog,
  onCreated,
  onRefreshRepos
}: {
  catalog: Catalog;
  onCreated: () => Promise<void>;
  onRefreshRepos: () => Promise<void>;
}) {
  const [repoKey, setRepoKey] = useState(catalog.repos[0]?.repoKey ?? '');
  const [model, setModel] = useState(catalog.models[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

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
    <form className="card composer" onSubmit={submit} aria-busy={busy}>
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
          disabled={busy}
          onChange={(event) => setRepoKey(event.target.value)}
        >
          {catalog.repos.map((repo) => (
            <option key={repo.repoKey} value={repo.repoKey}>
              {repo.displayName}
            </option>
          ))}
        </select>
        <select
          aria-label="Model"
          value={model}
          disabled={busy}
          onChange={(event) => setModel(event.target.value)}
        >
          {catalog.models.map((option) => (
            <option key={option.id} value={option.id}>
              {option.displayName}
            </option>
          ))}
        </select>
        {/*
          The repository list is GitHub's, cached for ten minutes, so a
          repository created just now would otherwise be missing for a while.
        */}
        <button
          className="button"
          type="button"
          disabled={busy || refreshing}
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
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </form>
  );
}
