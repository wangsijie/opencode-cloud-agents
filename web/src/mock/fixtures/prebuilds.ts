/**
 * Prebuild fixtures: one repo with a warm prebuild, one whose last run
 * failed, the rest untouched — all on the first mock host, so the second one
 * shows the empty side of a two-host list. Triggering a build walks a scripted
 * pipeline — clone, install, promote — on a brisk clock so the page's step
 * ladder and log tail are watchable without a Docker host.
 *
 * Keyed the way the Hub keys them: `<provider>/<repoKey>`, because the same
 * repository can hold a prebuild on every host.
 */
import { prebuildKey, type PrebuildRunView, type PrebuildView, type SessionProvider } from '../../api';
import { hoursAgo, minutesAgo } from './util';

/** The host the fixtures live on; matches the first entry in the settings fixture. */
const MOCK_HOST: SessionProvider = 'docker:mac-mini';

interface PrebuildState {
  prebuilds: Map<string, PrebuildView>;
  runs: Map<string, PrebuildRunView>;
}

export const prebuildState: PrebuildState = {
  prebuilds: new Map([
    [
      prebuildKey(MOCK_HOST, 'acme/webapp'),
      {
        repoKey: 'acme/webapp',
        provider: MOCK_HOST,
        location: 'oc-prebuild-acme-webapp',
        sizeBytes: 1_430_000_000,
        source: 'run',
        updatedAt: hoursAgo(2)
      }
    ]
  ]),
  runs: new Map([
    [
      prebuildKey(MOCK_HOST, 'acme/webapp'),
      {
        id: 'run-webapp-1',
        repoKey: 'acme/webapp',
        provider: MOCK_HOST,
        status: 'succeeded' as const,
        startedAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
        timings: { cloneMs: 9_400, installMs: 258_000, promoteMs: 41_000, totalMs: 312_000 },
        logTail: '+ vitest 1.6.0\n\nDone in 4m 18.1s using pnpm v11.5.2\n== install done'
      }
    ],
    [
      prebuildKey(MOCK_HOST, 'acme/api-server'),
      {
        id: 'run-api-1',
        repoKey: 'acme/api-server',
        provider: MOCK_HOST,
        status: 'failed' as const,
        startedAt: minutesAgo(50),
        finishedAt: minutesAgo(45),
        timings: { cloneMs: 12_000 },
        error: 'The install exited 1. Log tail:\nERR_PNPM_OUTDATED_LOCKFILE',
        logTail:
          'Progress: resolved 812, reused 790, downloaded 22\nERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date'
      }
    ]
  ])
};

/** Kick off a scripted run: each stage lands on a timer, then the registry updates. */
export function startMockRun(
  repoKey: string,
  provider: SessionProvider = MOCK_HOST
): string {
  const runId = `run-${Math.random().toString(36).slice(2, 8)}`;
  const key = prebuildKey(provider, repoKey);
  const run: PrebuildRunView = {
    id: runId,
    repoKey,
    provider,
    status: 'running',
    startedAt: new Date().toISOString(),
    timings: {},
    logTail: `Cloning into '/workspace/${repoKey}'...`
  };
  prebuildState.runs.set(key, run);

  const stage = (afterMs: number, apply: () => void) =>
    setTimeout(() => {
      if (prebuildState.runs.get(key)?.id !== runId) return;
      apply();
    }, afterMs);

  stage(4_000, () => {
    run.timings = { ...run.timings, cloneMs: 4_000 };
    run.logTail = 'Progress: resolved 812, reused 790, downloaded 22\nPackages are hard linked from the content-addressable store';
  });
  stage(14_000, () => {
    run.timings = { ...run.timings, installMs: 10_000 };
    run.logTail = 'Done in 10.2s using pnpm v11.5.2\n== install done';
  });
  stage(19_000, () => {
    run.timings = { ...run.timings, promoteMs: 5_000, totalMs: 19_000 };
    run.status = 'succeeded';
    run.finishedAt = new Date().toISOString();
    prebuildState.prebuilds.set(key, {
      repoKey,
      provider,
      location: `oc-prebuild-${repoKey.replaceAll('/', '-')}`,
      sizeBytes: 980_000_000,
      source: 'run',
      updatedAt: new Date().toISOString()
    });
  });
  return runId;
}
