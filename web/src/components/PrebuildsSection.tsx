import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deletePrebuild,
  fetchCatalog,
  fetchPrebuilds,
  startPrebuild,
  type Catalog,
  type PrebuildRunView,
  type PrebuildsView
} from '../api';
import { formatBytes, formatDuration, formatRelative } from '../format';
import { RepoSelect } from './RepoSelect';

/**
 * The prebuilds settings section: one row per *prebuilt* repository, plus a
 * picker that adds one.
 *
 * A prebuild is a warm workspace copy new sessions of the same repo are
 * seeded from (docs/prebuild-design.md); this section exists to build one by
 * hand and to watch where its minutes go. It listed the whole catalog once,
 * every repo carrying a muted "no prebuild" — which put the handful that
 * matter behind a scroll through the ones that never will. So the list is the
 * registry (plus whatever a run is currently touching) and the catalog moved
 * into the add control, where it is searchable because that is what the
 * composer's own picker is. While any run is live the whole view polls on a
 * short beat; the expanded row shows the step ladder and the install log tail.
 *
 * It fetches its own catalog rather than taking the Hub's: the settings page
 * also runs as the onboarding gate, where there is no Hub above it to ask.
 */

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

/** The pipeline stages, in order, with the timing field each one fills. */
const STEPS: { key: 'cloneMs' | 'installMs' | 'promoteMs'; label: string }[] = [
  { key: 'cloneMs', label: 'Clone' },
  { key: 'installMs', label: 'Install' },
  { key: 'promoteMs', label: 'Promote' }
];

export function PrebuildsSection() {
  const [view, setView] = useState<PrebuildsView>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogTried, setCatalogTried] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyRepo, setBusyRepo] = useState<string>();
  const [pending, setPending] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await fetchPrebuilds());
      setLoadError(undefined);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const hasActiveRun = Object.values(view?.runs ?? {}).some(
    (run) => run.status === 'running'
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const timer = setInterval(
      () => void load(),
      hasActiveRun ? ACTIVE_POLL_MS : IDLE_POLL_MS
    );
    return () => clearInterval(timer);
  }, [load, hasActiveRun]);

  /*
    A catalog that will not load leaves the registry's own rows readable, so an
    existing prebuild stays deletable either way — only adding a new one needs
    the list. `catalogTried` is what stops the picker from sitting on
    "Loading repositories…" forever when that read failed: it opens empty
    instead, with its own refresh inside.
  */
  useEffect(() => {
    let cancelled = false;
    void fetchCatalog()
      .then((next) => {
        if (!cancelled) {
          setCatalog(next);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setCatalogTried(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCatalog = useCallback(async () => {
    setCatalog(await fetchCatalog(true));
  }, []);

  const dockerAvailable = catalog?.providers.includes('docker') ?? false;

  /*
    The rows are the registry, plus whatever a run is currently saying —
    `running` so a first build is watchable from the moment it is added, and
    `failed` so an attempt that produced no prebuild leaves its error on screen
    instead of disappearing. Catalog order (last-used first) where the repo is
    still listed; anything else keeps its key as its name, because a prebuild
    for a repo GitHub stopped listing is still real and still deletable.
  */
  const rows = useMemo(() => {
    const keys = new Set<string>();
    for (const prebuild of view?.prebuilds ?? []) {
      keys.add(prebuild.repoKey);
    }
    for (const [repoKey, run] of Object.entries(view?.runs ?? {})) {
      if (run.status !== 'succeeded') {
        keys.add(repoKey);
      }
    }
    const listed = (catalog?.repos ?? []).filter((repo) => keys.has(repo.repoKey));
    const known = new Set(listed.map((repo) => repo.repoKey));
    const rest = [...keys]
      .filter((repoKey) => !known.has(repoKey))
      .sort()
      .map((repoKey) => ({ repoKey, displayName: repoKey }));
    return [...listed, ...rest];
  }, [catalog, view]);

  /** The catalog minus what is already on the list. */
  const addable = useMemo(() => {
    const shown = new Set(rows.map((row) => row.repoKey));
    return (catalog?.repos ?? []).filter((repo) => !shown.has(repo.repoKey));
  }, [catalog, rows]);

  const trigger = async (repoKey: string) => {
    setBusyRepo(repoKey);
    setActionError(undefined);
    try {
      await startPrebuild(repoKey);
      // The row appears from the run this returns, so the pending choice has
      // done its job — clearing it puts the picker back at "Add a repository".
      setPending((current) => (current === repoKey ? '' : current));
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyRepo(undefined);
    }
  };

  const remove = async (repoKey: string) => {
    if (!window.confirm(`Delete the prebuild for ${repoKey}?`)) {
      return;
    }
    setBusyRepo(repoKey);
    setActionError(undefined);
    try {
      await deletePrebuild(repoKey);
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyRepo(undefined);
    }
  };

  return (
    <section className="settings-section">
      <h2>Prebuilds</h2>
      <p className="muted">
        A prebuild is a warm workspace — checkout, node_modules, package caches
        — that new sessions of the same repository start from instead of an
        empty volume. Docker provider only for now.
      </p>

      {loadError ? (
        <div className="card error">
          <p className="muted">{loadError}</p>
          <div className="actions">
            <button className="button" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      ) : null}
      {actionError ? <p className="banner error">{actionError}</p> : null}
      {!dockerAvailable ? (
        <p className="banner">
          The Docker sandbox host is not configured, so prebuilds cannot be
          built. Set it up in the Docker host section first.
        </p>
      ) : null}

      {!view && !loadError ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="prebuild-list">
            {rows.length === 0 ? (
              <p className="muted">
                No prebuilds yet. Pick a repository below to build one.
              </p>
            ) : (
              rows.map((repo) => (
                <PrebuildRow
                  key={repo.repoKey}
                  displayName={repo.displayName}
                  prebuild={view?.prebuilds.find(
                    (entry) => entry.repoKey === repo.repoKey
                  )}
                  run={view?.runs[repo.repoKey]}
                  canBuild={dockerAvailable}
                  busy={busyRepo === repo.repoKey}
                  onBuild={() => void trigger(repo.repoKey)}
                  onDelete={() => void remove(repo.repoKey)}
                />
              ))
            )}
          </div>

          {/*
            Adding is picking a repository and pressing Add: the catalog is a
            long list to scroll and a short one to search, so this is the
            composer's own picker rather than a second list of rows.
          */}
          <div className="prebuild-add">
            <RepoSelect
              repos={addable}
              value={pending}
              allowNone={false}
              label="Add a repository"
              loading={!catalogTried}
              disabled={!dockerAvailable || busyRepo !== undefined}
              onChange={setPending}
              onRefresh={refreshCatalog}
            />
            <button
              className="button"
              type="button"
              disabled={
                !dockerAvailable || pending === '' || busyRepo !== undefined
              }
              onClick={() => void trigger(pending)}
            >
              {busyRepo === pending && pending !== '' ? 'Adding…' : 'Add'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function PrebuildRow({
  displayName,
  prebuild,
  run,
  canBuild,
  busy,
  onBuild,
  onDelete
}: {
  displayName: string;
  prebuild?: PrebuildsView['prebuilds'][number];
  run?: PrebuildRunView;
  canBuild: boolean;
  busy: boolean;
  onBuild: () => void;
  onDelete: () => void;
}) {
  const running = run?.status === 'running';
  const failed = run?.status === 'failed';

  return (
    <div className="card prebuild-row">
      <div className="prebuild-row-head">
        <div className="prebuild-row-title">
          <h3>{displayName}</h3>
          <p className="muted">
            {prebuild ? (
              <>
                built {formatRelative(prebuild.updatedAt)}
                {' · '}
                {prebuild.provider}
                {prebuild.sizeBytes !== undefined
                  ? ` · ${formatBytes(prebuild.sizeBytes)}`
                  : ''}
              </>
            ) : running ? (
              'building the first one…'
            ) : (
              'no prebuild'
            )}
          </p>
        </div>
        <div className="prebuild-row-actions">
          {/*
            Not only when a prebuild exists: a failed first attempt is on the
            list too, and delete is how the repository leaves it.
          */}
          {(prebuild || failed) && !running ? (
            <button
              className="button danger"
              type="button"
              disabled={busy}
              onClick={onDelete}
            >
              Delete
            </button>
          ) : null}
          <button
            className="button"
            type="button"
            disabled={!canBuild || running || busy}
            onClick={onBuild}
          >
            {running ? 'Building…' : prebuild ? 'Rebuild' : 'Build'}
          </button>
        </div>
      </div>

      {running && run ? <RunLadder run={run} /> : null}

      {failed && run ? (
        <details className="prebuild-failure">
          <summary>
            Last run failed {formatRelative(run.finishedAt ?? run.startedAt)}
          </summary>
          {run.error ? <p className="muted">{run.error}</p> : null}
          {run.logTail ? <pre className="prebuild-log">{run.logTail}</pre> : null}
        </details>
      ) : null}

      {run?.status === 'succeeded' && run.timings?.totalMs !== undefined ? (
        <p className="muted prebuild-run-summary">
          Last run {formatRelative(run.finishedAt ?? run.startedAt)} took{' '}
          {formatDuration(run.timings.totalMs)}
          {describeSteps(run)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The live step ladder: finished steps show their duration, the current one
 * its elapsed time. "Current" is simply the first step without a recorded
 * duration — the run writes each timing as the stage completes.
 */
function RunLadder({ run }: { run: PrebuildRunView }) {
  const timings = run.timings ?? {};
  const currentIndex = STEPS.findIndex((step) => timings[step.key] === undefined);
  return (
    <div className="prebuild-ladder">
      <ol>
        {STEPS.map((step, index) => {
          const done = timings[step.key] !== undefined;
          const current = index === currentIndex;
          return (
            <li
              key={step.key}
              className={done ? 'done' : current ? 'current' : 'pending'}
            >
              <span className="step-label">{step.label}</span>
              <span className="muted">
                {done
                  ? formatDuration(timings[step.key]!)
                  : current
                    ? `${formatDuration(Date.now() - Date.parse(run.startedAt))} elapsed`
                    : ''}
              </span>
            </li>
          );
        })}
      </ol>
      {run.logTail ? <pre className="prebuild-log">{run.logTail}</pre> : null}
    </div>
  );
}

function describeSteps(run: PrebuildRunView): string {
  const timings = run.timings ?? {};
  const parts = STEPS.filter((step) => timings[step.key] !== undefined).map(
    (step) => `${step.label.toLowerCase()} ${formatDuration(timings[step.key]!)}`
  );
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}
