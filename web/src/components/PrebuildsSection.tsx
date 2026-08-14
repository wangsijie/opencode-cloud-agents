import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deletePrebuild,
  fetchCatalog,
  fetchPrebuilds,
  prebuildKey,
  startPrebuild,
  type Catalog,
  type PrebuildRunView,
  type PrebuildsView,
  type SessionProvider
} from '../api';
import { formatBytes, formatDuration, formatRelative } from '../format';
import { providerLabel } from './ProviderSelect';
import { RepoSelect } from './RepoSelect';

/**
 * The prebuilds settings section: one row per *prebuilt* repository, grouped
 * by the host the prebuild lives on, plus a picker that adds one.
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
 * A prebuild is a volume on one box, so a repository can hold one on every
 * Docker host and each is its own row: its own build, its own delete. A group
 * for a host that is no longer configured is still drawn — its rows cannot be
 * built, but they can be deleted, which is the only way they would ever leave.
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

/** One host's section of the list. */
interface PrebuildGroup {
  provider: SessionProvider;
  label: string;
  /** False for a host that has been removed from settings since. */
  configured: boolean;
  repos: { repoKey: string; displayName: string }[];
}

export function PrebuildsSection() {
  const [view, setView] = useState<PrebuildsView>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [catalogTried, setCatalogTried] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [pending, setPending] = useState('');
  const [pendingHost, setPendingHost] = useState<SessionProvider>();

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

  const hosts = useMemo(() => view?.hosts ?? [], [view?.hosts]);
  const dockerAvailable = hosts.length > 0;

  // Which host the add control builds on. Follows the first configured one
  // until a deliberate pick, which then sticks while that host is still there.
  useEffect(() => {
    setPendingHost((current) =>
      current && hosts.some((host) => host.provider === current)
        ? current
        : hosts[0]?.provider
    );
  }, [hosts]);

  /*
    The rows are the registry, plus whatever a run is currently saying —
    `running` so a first build is watchable from the moment it is added, and
    `failed` so an attempt that produced no prebuild leaves its error on screen
    instead of disappearing. Grouped by host, in the order settings lists them,
    with any host that has since been removed after those. Catalog order
    (last-used first) within a group where the repo is still listed; anything
    else keeps its key as its name, because a prebuild for a repo GitHub
    stopped listing is still real and still deletable.
  */
  const groups = useMemo<PrebuildGroup[]>(() => {
    const byProvider = new Map<string, Set<string>>();
    const add = (provider: string, repoKey: string) => {
      const existing = byProvider.get(provider);
      if (existing) {
        existing.add(repoKey);
      } else {
        byProvider.set(provider, new Set([repoKey]));
      }
    };
    for (const prebuild of view?.prebuilds ?? []) {
      add(prebuild.provider, prebuild.repoKey);
    }
    for (const run of Object.values(view?.runs ?? {})) {
      if (run.status !== 'succeeded') {
        add(run.provider, run.repoKey);
      }
    }
    const configured = new Map<string, string>(
      hosts.map((host) => [host.provider, host.label])
    );
    const orphaned = [...byProvider.keys()]
      .filter((provider) => !configured.has(provider))
      .sort();
    return [...configured.keys(), ...orphaned]
      .map((provider) => ({
        provider: provider as SessionProvider,
        label: configured.get(provider) ?? providerLabel(provider as SessionProvider),
        configured: configured.has(provider),
        repos: orderRepos(byProvider.get(provider) ?? new Set(), catalog)
      }))
      .filter((group) => group.configured || group.repos.length > 0);
  }, [catalog, hosts, view]);

  /** The catalog minus what the chosen host already has on the list. */
  const addable = useMemo(() => {
    const shown = new Set(
      groups
        .find((group) => group.provider === pendingHost)
        ?.repos.map((row) => row.repoKey) ?? []
    );
    return (catalog?.repos ?? []).filter((repo) => !shown.has(repo.repoKey));
  }, [catalog, groups, pendingHost]);

  const trigger = async (provider: SessionProvider, repoKey: string) => {
    setBusyKey(prebuildKey(provider, repoKey));
    setActionError(undefined);
    try {
      await startPrebuild(repoKey, provider);
      // The row appears from the run this returns, so the pending choice has
      // done its job — clearing it puts the picker back at "Add a repository".
      setPending((current) => (current === repoKey ? '' : current));
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(undefined);
    }
  };

  const remove = async (provider: SessionProvider, repoKey: string) => {
    if (!window.confirm(`Delete the prebuild for ${repoKey} on ${providerLabel(provider)}?`)) {
      return;
    }
    setBusyKey(prebuildKey(provider, repoKey));
    setActionError(undefined);
    try {
      await deletePrebuild(repoKey, provider);
      await load();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyKey(undefined);
    }
  };

  const addBusy =
    pendingHost !== undefined &&
    pending !== '' &&
    busyKey === prebuildKey(pendingHost, pending);

  return (
    <section className="settings-section">
      <h2>Prebuilds</h2>
      <p className="muted">
        A prebuild is a warm workspace — checkout, node_modules, package caches
        — that new sessions of the same repository start from instead of an
        empty volume. It is a volume on one machine, so each Docker host keeps
        its own. Docker provider only for now.
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
      {view && !dockerAvailable ? (
        <p className="banner">
          No Docker sandbox host is configured, so prebuilds cannot be built.
          Add one in the Docker hosts section first.
        </p>
      ) : null}

      {!view && !loadError ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          {groups.length === 0 ? null : (
            groups.map((group) => (
              <div key={group.provider} className="prebuild-group">
                {/* Named only when there is more than one place a prebuild
                    could be: with a single host the heading would repeat what
                    the section already says. */}
                {groups.length > 1 ? (
                  <h3>
                    {group.label}
                    {group.configured ? '' : ' (removed)'}
                  </h3>
                ) : null}
                <div className="prebuild-list">
                  {group.repos.length === 0 ? (
                    <p className="muted">
                      No prebuilds yet. Pick a repository below to build one.
                    </p>
                  ) : (
                    group.repos.map((repo) => (
                      <PrebuildRow
                        key={repo.repoKey}
                        displayName={repo.displayName}
                        prebuild={view?.prebuilds.find(
                          (entry) =>
                            entry.repoKey === repo.repoKey &&
                            entry.provider === group.provider
                        )}
                        run={view?.runs[prebuildKey(group.provider, repo.repoKey)]}
                        canBuild={group.configured}
                        busy={busyKey === prebuildKey(group.provider, repo.repoKey)}
                        onBuild={() => void trigger(group.provider, repo.repoKey)}
                        onDelete={() => void remove(group.provider, repo.repoKey)}
                      />
                    ))
                  )}
                </div>
              </div>
            ))
          )}

          {/*
            Adding is picking a repository and pressing Add: the catalog is a
            long list to scroll and a short one to search, so this is the
            composer's own picker rather than a second list of rows. The host
            comes with it once there is more than one to build on.
          */}
          <div className="prebuild-add">
            <RepoSelect
              repos={addable}
              value={pending}
              allowNone={false}
              label="Add a repository"
              loading={!catalogTried}
              disabled={!dockerAvailable || busyKey !== undefined}
              onChange={setPending}
              onRefresh={refreshCatalog}
            />
            {hosts.length > 1 ? (
              <select
                aria-label="Host to build on"
                value={pendingHost ?? ''}
                disabled={busyKey !== undefined}
                onChange={(event) =>
                  setPendingHost(event.target.value as SessionProvider)
                }
              >
                {hosts.map((host) => (
                  <option key={host.provider} value={host.provider}>
                    {host.label}
                  </option>
                ))}
              </select>
            ) : null}
            <button
              className="button"
              type="button"
              disabled={
                !dockerAvailable ||
                pendingHost === undefined ||
                pending === '' ||
                busyKey !== undefined
              }
              onClick={() => {
                if (pendingHost) {
                  void trigger(pendingHost, pending);
                }
              }}
            >
              {addBusy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * One host's repositories, catalog order (last-used first) where the catalog
 * still lists them, then the rest by key.
 */
function orderRepos(
  keys: Set<string>,
  catalog: Catalog | undefined
): { repoKey: string; displayName: string }[] {
  const listed = (catalog?.repos ?? []).filter((repo) => keys.has(repo.repoKey));
  const known = new Set(listed.map((repo) => repo.repoKey));
  const rest = [...keys]
    .filter((repoKey) => !known.has(repoKey))
    .sort()
    .map((repoKey) => ({ repoKey, displayName: repoKey }));
  return [
    ...listed.map((repo) => ({
      repoKey: repo.repoKey,
      displayName: repo.displayName
    })),
    ...rest
  ];
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
                {/* No host here: the group above is headed by it, and with
                    one host the whole section is about that host. */}
                built {formatRelative(prebuild.updatedAt)}
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
