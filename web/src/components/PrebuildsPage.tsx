import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deletePrebuild,
  fetchPrebuilds,
  startPrebuild,
  type Catalog,
  type PrebuildRunView,
  type PrebuildsView
} from '../api';
import { formatBytes, formatDuration, formatRelative } from '../format';
import { MenuIcon } from './icons';

/**
 * The prebuilds page: one row per repository, the row is the trigger.
 *
 * A prebuild is a warm workspace copy new sessions of the same repo are
 * seeded from (docs/prebuild-design.md); this page exists to build one by
 * hand and to watch where its minutes go. The repo list is the same catalog
 * the composer reads, merged with the registry — every repo appears whether
 * or not it has one. While any run is live the whole view polls on a short
 * beat; the expanded row shows the step ladder and the install log tail.
 */

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 30_000;

/** The pipeline stages, in order, with the timing field each one fills. */
const STEPS: { key: 'cloneMs' | 'installMs' | 'promoteMs'; label: string }[] = [
  { key: 'cloneMs', label: 'Clone' },
  { key: 'installMs', label: 'Install' },
  { key: 'promoteMs', label: 'Promote' }
];

export function PrebuildsPage({
  catalog,
  onMenu
}: {
  catalog?: Catalog;
  onMenu: () => void;
}) {
  const [view, setView] = useState<PrebuildsView>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyRepo, setBusyRepo] = useState<string>();

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

  const dockerAvailable = catalog?.providers.includes('docker') ?? false;

  // Catalog order (last-used first), plus any repo that holds a prebuild but
  // has left the catalog — its cache is still real and still deletable.
  const rows = useMemo(() => {
    const catalogKeys = new Set(
      (catalog?.repos ?? []).map((repo) => repo.repoKey)
    );
    const orphans = (view?.prebuilds ?? [])
      .filter((prebuild) => !catalogKeys.has(prebuild.repoKey))
      .map((prebuild) => ({
        repoKey: prebuild.repoKey,
        displayName: prebuild.repoKey
      }));
    return [...(catalog?.repos ?? []), ...orphans];
  }, [catalog, view]);

  const trigger = async (repoKey: string) => {
    setBusyRepo(repoKey);
    setActionError(undefined);
    try {
      await startPrebuild(repoKey);
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
    <div className="session-view">
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
        <div className="prebuilds-page">
          <h1>Prebuilds</h1>
          <p className="muted">
            A prebuild is a warm workspace — checkout, node_modules, package
            caches — that new sessions of the same repository start from
            instead of an empty volume. Docker provider only for now.
          </p>

          {loadError ? (
            <section className="card error">
              <p className="muted">{loadError}</p>
              <div className="actions">
                <button className="button" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            </section>
          ) : null}
          {actionError ? <p className="banner error">{actionError}</p> : null}
          {!dockerAvailable ? (
            <p className="banner">
              The Docker sandbox host is not configured, so prebuilds cannot be
              built. Set it up in Settings first.
            </p>
          ) : null}

          {!view && !loadError ? (
            <p className="muted">Loading…</p>
          ) : (
            <div className="prebuild-list">
              {rows.length === 0 ? (
                <p className="muted">No repositories in the catalog yet.</p>
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
          )}
        </div>
      </div>
    </div>
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
    <section className="card prebuild-row">
      <div className="prebuild-row-head">
        <div className="prebuild-row-title">
          <h2>{displayName}</h2>
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
            ) : (
              'no prebuild'
            )}
          </p>
        </div>
        <div className="prebuild-row-actions">
          {prebuild && !running ? (
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
    </section>
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
