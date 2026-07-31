/**
 * Prebuild fixtures: one repo with a warm prebuild, one whose last run
 * failed, the rest untouched. Triggering a build walks a scripted pipeline —
 * clone, install, promote — on a brisk clock so the page's step ladder and
 * log tail are watchable without a Docker host.
 */
import type { PrebuildRunView, PrebuildView } from '../../api';
import { hoursAgo, minutesAgo } from './util';

interface PrebuildState {
  prebuilds: Map<string, PrebuildView>;
  runs: Map<string, PrebuildRunView>;
}

export const prebuildState: PrebuildState = {
  prebuilds: new Map([
    [
      'acme/webapp',
      {
        repoKey: 'acme/webapp',
        provider: 'docker' as const,
        location: 'oc-prebuild-acme-webapp',
        sizeBytes: 1_430_000_000,
        source: 'run',
        updatedAt: hoursAgo(2)
      }
    ]
  ]),
  runs: new Map([
    [
      'acme/webapp',
      {
        id: 'run-webapp-1',
        repoKey: 'acme/webapp',
        provider: 'docker' as const,
        status: 'succeeded' as const,
        startedAt: hoursAgo(2),
        finishedAt: hoursAgo(2),
        timings: { cloneMs: 9_400, installMs: 258_000, promoteMs: 41_000, totalMs: 312_000 },
        logTail: '+ vitest 1.6.0\n\nDone in 4m 18.1s using pnpm v11.5.2\n== install done'
      }
    ],
    [
      'acme/api-server',
      {
        id: 'run-api-1',
        repoKey: 'acme/api-server',
        provider: 'docker' as const,
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
export function startMockRun(repoKey: string): string {
  const runId = `run-${Math.random().toString(36).slice(2, 8)}`;
  const run: PrebuildRunView = {
    id: runId,
    repoKey,
    provider: 'docker',
    status: 'running',
    startedAt: new Date().toISOString(),
    timings: {},
    logTail: `Cloning into '/workspace/${repoKey}'...`
  };
  prebuildState.runs.set(repoKey, run);

  const stage = (afterMs: number, apply: () => void) =>
    setTimeout(() => {
      if (prebuildState.runs.get(repoKey)?.id !== runId) return;
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
    prebuildState.prebuilds.set(repoKey, {
      repoKey,
      provider: 'docker',
      location: `oc-prebuild-${repoKey.replaceAll('/', '-')}`,
      sizeBytes: 980_000_000,
      source: 'run',
      updatedAt: new Date().toISOString()
    });
  });
  return runId;
}
