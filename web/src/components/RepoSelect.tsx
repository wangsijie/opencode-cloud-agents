import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepoOption } from '../api';
import { CheckIcon, ChevronDownIcon, RefreshIcon, SearchIcon } from './icons';

/**
 * The repository picker in the composer.
 *
 * A native `<select>` stopped being enough once an account has more
 * repositories than fit a glance: the list needs a filter, and the only way to
 * put a text field inside a menu is to draw the menu. Closed, it is the same
 * pill as the model picker beside it.
 *
 * Refreshing the list belongs here rather than beside the pill: it is an action
 * on this list, and it is only worth reaching for while looking at the list and
 * failing to find something. So it lives in the open panel, next to the search
 * field, and the composer row is one control shorter.
 */
export function RepoSelect({
  repos,
  value,
  disabled,
  loading,
  onChange,
  onRefresh
}: {
  repos?: RepoOption[];
  value: string;
  disabled?: boolean;
  loading?: boolean;
  onChange: (repoKey: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = repos?.find((repo) => repo.repoKey === value);
  const label = loading ? 'Loading repositories…' : (selected?.displayName ?? 'Repository');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!repos) {
      return [];
    }
    if (!needle) {
      return repos;
    }
    // Both halves of `owner/name` are worth matching: the pill shows the
    // display name, but people type the owner to narrow to a fork.
    return repos.filter(
      (repo) =>
        repo.displayName.toLowerCase().includes(needle) ||
        repo.repoKey.toLowerCase().includes(needle)
    );
  }, [repos, query]);

  // Opening starts on the current repository, and every keystroke re-anchors on
  // the best remaining match, so Enter always picks what the list shows first.
  useEffect(() => {
    if (!open) {
      return;
    }
    const index = matches.findIndex((repo) => repo.repoKey === value);
    setActive(query ? 0 : Math.max(index, 0));
  }, [open, query]);

  useEffect(() => {
    if (!open) {
      return;
    }
    searchRef.current?.focus();
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    if (open) {
      listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
    }
  }, [open, active]);

  function choose(repo: RepoOption) {
    onChange(repo.repoKey);
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      setQuery('');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) {
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => (current + step + matches.length) % matches.length);
      return;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const repo = matches[active];
      if (repo) {
        choose(repo);
      }
    }
  }

  return (
    <div className="repo-select" ref={rootRef}>
      <button
        className="pill-select repo-select-button"
        type="button"
        disabled={disabled || loading}
        aria-label="Repository"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="repo-select-label">{label}</span>
        <ChevronDownIcon />
      </button>

      {open ? (
        <div className="repo-select-panel" onKeyDown={onKeyDown}>
          <div className="repo-select-search">
            <SearchIcon />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="Search repositories"
              aria-label="Search repositories"
              onChange={(event) => setQuery(event.target.value)}
            />
            {/*
              The stored list is only re-read from GitHub when the page finds it
              stale, so a repository created a minute ago needs a way to ask now.
            */}
            <button
              className="icon-button"
              type="button"
              disabled={refreshing}
              aria-label="Refresh the repository list"
              title="Re-read the repository list from GitHub"
              onClick={async () => {
                setRefreshing(true);
                setRefreshError(undefined);
                try {
                  await onRefresh();
                } catch (cause) {
                  setRefreshError(
                    cause instanceof Error ? cause.message : String(cause)
                  );
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshIcon />
            </button>
          </div>

          <div className="repo-select-list" role="listbox" ref={listRef}>
            {matches.map((repo, index) => (
              <button
                key={repo.repoKey}
                className={`repo-select-option${index === active ? ' active' : ''}`}
                type="button"
                role="option"
                aria-selected={repo.repoKey === value}
                onPointerEnter={() => setActive(index)}
                onClick={() => choose(repo)}
              >
                <span className="repo-select-option-name">{repo.displayName}</span>
                {repo.repoKey === value ? <CheckIcon /> : null}
              </button>
            ))}
            {matches.length === 0 ? (
              <p className="repo-select-empty muted">
                {refreshing ? 'Reading GitHub…' : 'No repository matches'}
              </p>
            ) : null}
          </div>

          {refreshError ? <p className="form-error">{refreshError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
