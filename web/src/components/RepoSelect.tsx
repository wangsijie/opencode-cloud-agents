import { useMemo, useState } from 'react';
import type { RepoOption } from '../api';
import { RefreshIcon } from './icons';
import { PillSelect } from './PillSelect';

/**
 * The repository picker: a searchable menu, with the list's own refresh inside
 * it.
 *
 * Refreshing sits in the panel rather than beside the pill because it is an
 * action on this list, and it is only worth reaching for while looking at the
 * list and failing to find something.
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
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();

  const options = useMemo(
    () =>
      repos?.map((repo) => ({
        value: repo.repoKey,
        label: repo.displayName,
        // The pill shows the display name, but people type the owner to narrow
        // to a fork.
        keywords: repo.repoKey
      })),
    [repos]
  );

  return (
    <PillSelect
      options={options}
      value={value}
      ariaLabel="Repository"
      placeholder="Repository"
      loadingLabel="Loading repositories…"
      disabled={disabled}
      loading={loading}
      search
      searchPlaceholder="Search repositories"
      emptyLabel={refreshing ? 'Reading GitHub…' : 'No repository matches'}
      onChange={onChange}
      action={
        /*
          The stored list is only re-read from GitHub when the page finds it
          stale, so a repository created a minute ago needs a way to ask now.
        */
        <button
          className="icon-button"
          type="button"
          disabled={refreshing}
          aria-label="Refresh the repository list"
          title="Re-read the repository list from GitHub"
          onClick={async () => {
            setRefreshing(true);
            setError(undefined);
            try {
              await onRefresh();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setRefreshing(false);
            }
          }}
        >
          <RefreshIcon />
        </button>
      }
      footer={error ? <p className="form-error">{error}</p> : null}
    />
  );
}
