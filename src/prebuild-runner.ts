/**
 * The dedicated prebuild run: a throwaway container that clones a repository,
 * installs its dependencies, and promotes the result as the repo's prebuild.
 * See docs/prebuild-design.md, "Dedicated prebuild runs".
 *
 * One Durable Object per (host, repository) — `getByName('docker:<id>/<repo>')`
 * — which is what makes "one run per repo per host at a time" true by
 * construction. A prebuild is a volume on one box, so the same repository may
 * be building on two hosts at once and neither run knows about the other. The pipeline is
 * alarm-driven: short steps run inline in one alarm invocation, the install —
 * the long one — runs detached inside the container and is polled, so no
 * single invocation has to survive for the length of a `pnpm install`. Every
 * step re-arms the alarm as a watchdog first, so an evicted invocation
 * becomes a failed run instead of a phantom "running" that blocks the repo
 * forever.
 *
 * The host stays dumb (PROTOCOL.md): everything here speaks the ordinary
 * session primitives — ensure, exec, files, stop, remove — plus the one
 * mechanical prebuild promote. The container deliberately never starts an
 * OpenCode server, so the promoted workspace carries no conversation state.
 */
import { DurableObject } from 'cloudflare:workers';

import type { SessionProvider } from '../protocol/types.ts';

import {
  containerEnv,
  loadContainerCredentials
} from './container-credentials.ts';
import { HostError, resolveHostClient, type HostClient } from './host-client.ts';
import { findCatalogRepo } from './hub-store.ts';
import {
  findActivePrebuildRun,
  getPrebuildRun,
  insertPrebuildRun,
  updatePrebuildRun,
  upsertPrebuildRecord,
  type PrebuildRunRecord,
  type PrebuildRunStep,
  type PrebuildRunTimings
} from './prebuilds.ts';
import { workspaceDirectory, type RepoDefinition } from './repos.ts';
import {
  CONTAINER_RUNTIME_ENV,
  PERSISTENCE_MARKER_NAME,
  injectContainerCredentials,
  provisionRepository,
  sanitizeSeededWorkspace,
  wipeSeededWorkspace,
  type RuntimeCheckout
} from './runtime-ops.ts';
import { shellQuote } from './session-changes.ts';

/** Where the run's script, log and outcome live inside the container. */
const RUN_SCRIPT_PATH = '/tmp/oc-prebuild-run.sh';
const RUN_LOG_PATH = '/tmp/oc-prebuild.log';
const RUN_EXIT_PATH = '/tmp/oc-prebuild.exit';
const RUN_STARTED_PATH = '/tmp/oc-prebuild.started';

const RUN_ID_STORAGE_KEY = 'prebuild:run-id';

/** How much of the install log rides along on each poll. */
const LOG_TAIL_BYTES = 4000;

const POLL_INTERVAL_MS = 10 * 1000;

/**
 * Per-step budgets. The watchdog alarm fires past `budget + slack` only when
 * the invocation that owned the step died; a step that merely takes long is
 * still awaited by its own invocation.
 */
const STEP_BUDGET_MS: Record<PrebuildRunStep, number> = {
  provision: 10 * 60 * 1000,
  'install-start': 2 * 60 * 1000,
  install: 30 * 60 * 1000,
  stop: 2 * 60 * 1000,
  promote: 20 * 60 * 1000,
  cleanup: 5 * 60 * 1000
};
const WATCHDOG_SLACK_MS = 60 * 1000;

interface ActiveRunContext {
  record: PrebuildRunRecord;
  repo: RepoDefinition;
  sessionId: string;
}

export interface StartPrebuildRunInput {
  runId: string;
  repoKey: string;
  repo: RepoDefinition;
  /** The Docker host to build on; the API resolves it before calling. */
  provider: SessionProvider;
}

export type StartPrebuildRunResult =
  | { started: true }
  | { started: false; reason: 'busy' };

export class PrebuildRunner extends DurableObject<Env> {
  private runInProgress = false;

  /**
   * Begin a run, unless one is already underway for this repo. The run row is
   * inserted here, inside the same object that will update it, so a row in
   * `running` with no coordinator behind it can only mean a crash the
   * watchdog will convert to `failed`.
   */
  async startRun(input: StartPrebuildRunInput): Promise<StartPrebuildRunResult> {
    if (this.runInProgress) {
      return { started: false, reason: 'busy' };
    }
    const storedRunId = await this.ctx.storage.get<string>(RUN_ID_STORAGE_KEY);
    if (storedRunId) {
      const existing = await getPrebuildRun(this.env, storedRunId);
      if (existing && existing.status === 'running') {
        return { started: false, reason: 'busy' };
      }
    }
    const active = await findActivePrebuildRun(this.env, input.repoKey, input.provider);
    if (active) {
      return { started: false, reason: 'busy' };
    }

    this.runInProgress = true;
    const now = Date.now();
    await insertPrebuildRun(this.env, {
      id: input.runId,
      repoKey: input.repoKey,
      provider: input.provider,
      status: 'running',
      startedAt: new Date(now).toISOString(),
      step: 'provision',
      stepStartedAt: now,
      attempts: 0
    });
    await this.ctx.storage.put(RUN_ID_STORAGE_KEY, input.runId);
    await this.ctx.storage.setAlarm(now);
    return { started: true };
  }

  /** Whether a run is underway. The API's 409 for delete-while-building. */
  async isRunning(context?: { repoKey: string; provider: SessionProvider }): Promise<boolean> {
    if (this.runInProgress) {
      return true;
    }
    const storedRunId = await this.ctx.storage.get<string>(RUN_ID_STORAGE_KEY);
    if (storedRunId) {
      const existing = await getPrebuildRun(this.env, storedRunId);
      if (existing && existing.status === 'running') {
        return true;
      }
    }
    if (context) {
      const active = await findActivePrebuildRun(this.env, context.repoKey, context.provider);
      if (active) {
        return true;
      }
    }
    return false;
  }

  async alarm(): Promise<void> {
    const runId = await this.ctx.storage.get<string>(RUN_ID_STORAGE_KEY);
    if (!runId) {
      this.runInProgress = false;
      return;
    }
    const record = await getPrebuildRun(this.env, runId);
    if (!record || record.status !== 'running') {
      await this.ctx.storage.delete(RUN_ID_STORAGE_KEY);
      this.runInProgress = false;
      return;
    }
    this.runInProgress = true;

    const repo = await findCatalogRepo(this.env, record.repoKey);
    if (!repo) {
      await this.failRun(
        { record, repo: fallbackRepo(record.repoKey), sessionId: runSessionId(record.repoKey) },
        `Repository "${record.repoKey}" is no longer in the catalog`
      );
      return;
    }

    const ctx: ActiveRunContext = {
      record,
      repo,
      sessionId: runSessionId(record.repoKey)
    };

    const step = record.step ?? 'provision';
    const stepStartedAt = record.stepStartedAt ?? (Date.parse(record.startedAt) || Date.now());
    let attempts = record.attempts ?? 0;

    // An alarm for an inline step can only mean the invocation that ran it
    // died (success re-arms the alarm for the *next* step before returning).
    // The poll step is the exception: its alarms are the ordinary heartbeat.
    if (step !== 'install') {
      attempts += 1;
      if (attempts > 2) {
        await this.failRun(
          ctx,
          `The ${step} step died twice; giving up`
        );
        return;
      }
      await updatePrebuildRun(this.env, record.id, { attempts });
      ctx.record.attempts = attempts;
    } else if (Date.now() - stepStartedAt > STEP_BUDGET_MS.install) {
      await this.failRun(ctx, 'The install ran past its 30 minute budget');
      return;
    }

    try {
      await this.runStep(ctx);
    } catch (error) {
      await this.failRun(ctx, describeError(error));
    }
  }

  private async runStep(ctx: ActiveRunContext): Promise<void> {
    const host = await resolveHostClient(
      this.env,
      ctx.sessionId,
      providerOf(ctx.record)
    );
    const step = ctx.record.step ?? 'provision';
    switch (step) {
      case 'provision':
        return this.provision(ctx, host);
      case 'install-start':
        return this.startInstall(ctx, host);
      case 'install':
        return this.pollInstall(ctx, host);
      case 'stop':
        return this.stopContainer(ctx, host);
      case 'promote':
        return this.promote(ctx, host);
      case 'cleanup':
        return this.cleanup(ctx, host);
    }
  }

  /**
   * Everything before the install: a clean slate (a crashed run's leftovers
   * are removed, idempotently), a fresh container — seeded from the existing
   * prebuild when there is one, which is what makes a re-run incremental —
   * credentials, and a checkout on the current default branch.
   */
  private async provision(ctx: ActiveRunContext, host: HostClient): Promise<void> {
    await this.armWatchdog(ctx);
    const startedAt = Date.now();
    await host.remove();
    const ensured = await host.ensure({ repoKey: ctx.record.repoKey });
    const checkout = this.checkoutOf(ctx);
    await injectContainerCredentials(
      host,
      await loadContainerCredentials(this.env),
      checkout
    );
    if (ensured.seededFromPrebuild) {
      try {
        await sanitizeSeededWorkspace(host, checkout);
      } catch (error) {
        console.warn(
          `Prebuild run seed unusable for ${ctx.record.repoKey}; wiping and cloning`,
          error
        );
        await wipeSeededWorkspace(host, checkout);
        await provisionRepository(host, checkout);
      }
    } else {
      await provisionRepository(host, checkout);
    }
    const timings = { ...ctx.record.timings, cloneMs: Date.now() - startedAt };
    ctx.record.timings = timings;
    await updatePrebuildRun(this.env, ctx.record.id, { timings });
    await this.advance(ctx, 'install-start');
  }

  /**
   * Launch the install script detached and let the container run it alone.
   * The started-marker makes a retried launch a no-op instead of a second
   * install racing the first.
   */
  private async startInstall(ctx: ActiveRunContext, host: HostClient): Promise<void> {
    await this.armWatchdog(ctx);
    const started = await host.exists(RUN_STARTED_PATH);
    if (!started.exists) {
      await host.writeBatch([
        {
          path: RUN_SCRIPT_PATH,
          content: installScript(this.checkoutOf(ctx).directory),
          mode: '755'
        }
      ]);
      const operatorEnv = await loadOperatorEnv(this.env);
      const launched = await host.exec(
        [
          `: > ${RUN_STARTED_PATH}`,
          `nohup sh -c 'sh ${RUN_SCRIPT_PATH} > ${RUN_LOG_PATH} 2>&1; echo $? > ${RUN_EXIT_PATH}' > /dev/null 2>&1 &`,
          'echo launched'
        ].join('\n'),
        { env: { ...operatorEnv, ...CONTAINER_RUNTIME_ENV }, timeoutMs: 30_000 }
      );
      if (!launched.success) {
        throw new Error(`Could not launch the install: ${launched.stderr}`);
      }
    }
    await this.advance(ctx, 'install', { alarmInMs: POLL_INTERVAL_MS });
  }

  /** One heartbeat: done yet? If not, refresh the log tail and re-arm. */
  private async pollInstall(ctx: ActiveRunContext, host: HostClient): Promise<void> {
    let exitCode: number | undefined;
    try {
      const exit = await host.readFile(RUN_EXIT_PATH);
      exitCode = Number.parseInt(exit.content.trim(), 10);
    } catch (error) {
      if (!(error instanceof HostError) || error.code !== 'FILE_NOT_FOUND') {
        throw error;
      }
    }

    const tail = await this.readLogTail(host);
    if (tail !== undefined) {
      await updatePrebuildRun(this.env, ctx.record.id, { logTail: tail });
    }

    if (exitCode === undefined) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return;
    }
    if (exitCode !== 0) {
      throw new Error(
        `The install exited ${exitCode}. ${tail ? `Log tail:\n${tail}` : ''}`
      );
    }
    const stepStartedAt = ctx.record.stepStartedAt ?? Date.now();
    const timings = { ...ctx.record.timings, installMs: Date.now() - stepStartedAt };
    ctx.record.timings = timings;
    await updatePrebuildRun(this.env, ctx.record.id, { timings });
    await this.advance(ctx, 'stop');
  }

  /**
   * Stop the container so the promote copies a quiescent volume. Pending
   * terminations are retried inline rather than via the alarm — an alarm
   * retry on this step would be indistinguishable from a died invocation.
   */
  private async stopContainer(ctx: ActiveRunContext, host: HostClient): Promise<void> {
    await this.armWatchdog(ctx);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stopped = await host.stop(5);
      if (stopped.stopped) {
        await this.advance(ctx, 'promote');
        return;
      }
      await scheduler.wait(3_000);
    }
    throw new Error('The run container would not stop');
  }

  private async promote(ctx: ActiveRunContext, host: HostClient): Promise<void> {
    await this.armWatchdog(ctx);
    const startedAt = Date.now();
    const promoted = await host.prebuildPromote({
      repoKey: ctx.record.repoKey,
      // The one workspace file that is the site's bookkeeping, not the
      // repo's: a seeded workspace must not arrive looking already-restored.
      exclude: [PERSISTENCE_MARKER_NAME]
    });
    const timings = { ...ctx.record.timings, promoteMs: Date.now() - startedAt };
    ctx.record.timings = timings;
    await updatePrebuildRun(this.env, ctx.record.id, { timings });
    await upsertPrebuildRecord(this.env, {
      repoKey: ctx.record.repoKey,
      provider: providerOf(ctx.record),
      // Mirrors `prebuildVolumeName` in agent/docker.mjs.
      location: `oc-prebuild-${ctx.record.repoKey}`,
      ...(promoted.sizeBytes !== undefined
        ? { sizeBytes: promoted.sizeBytes }
        : {}),
      source: 'run',
      updatedAt: new Date().toISOString()
    });
    await this.advance(ctx, 'cleanup');
  }

  private async cleanup(ctx: ActiveRunContext, host: HostClient): Promise<void> {
    await this.armWatchdog(ctx);
    await host.remove();
    const totalStartedAt = Date.parse(ctx.record.startedAt) || Date.now();
    const timings = { ...ctx.record.timings, totalMs: Date.now() - totalStartedAt };
    await updatePrebuildRun(this.env, ctx.record.id, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      timings
    });
    await this.ctx.storage.delete(RUN_ID_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
    this.runInProgress = false;
  }

  /**
   * Terminal failure: record it, then make a best effort at not leaking the
   * throwaway container. The existing prebuild, if any, is untouched — a
   * failed refresh keeps yesterday's warm copy.
   */
  private async failRun(ctx: ActiveRunContext, message: string): Promise<void> {
    console.warn(`Prebuild run failed for ${ctx.record.repoKey}: ${message}`);
    await updatePrebuildRun(this.env, ctx.record.id, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      timings: ctx.record.timings,
      error: message.slice(0, 2000)
    });
    await this.ctx.storage.delete(RUN_ID_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
    this.runInProgress = false;
    try {
      const host = await resolveHostClient(
        this.env,
        ctx.sessionId,
        providerOf(ctx.record)
      );
      await host.remove();
    } catch (error) {
      console.warn('Prebuild run cleanup failed', error);
    }
  }

  /** Move to the next step and arm its alarm (watchdog or poll heartbeat). */
  private async advance(
    ctx: ActiveRunContext,
    step: PrebuildRunStep,
    options: { alarmInMs?: number } = {}
  ): Promise<void> {
    const stepStartedAt = Date.now();
    ctx.record.step = step;
    ctx.record.stepStartedAt = stepStartedAt;
    ctx.record.attempts = 0;
    await updatePrebuildRun(this.env, ctx.record.id, {
      step,
      stepStartedAt,
      attempts: 0
    });
    await this.ctx.storage.setAlarm(
      Date.now() +
        (options.alarmInMs ?? STEP_BUDGET_MS[step] + WATCHDOG_SLACK_MS)
    );
    await this.runStep(ctx);
  }

  /**
   * Re-arm the current step's watchdog before its long awaits, so a died
   * invocation is retried (then failed) instead of leaving the run stuck.
   */
  private async armWatchdog(ctx: ActiveRunContext): Promise<void> {
    const step = ctx.record.step ?? 'provision';
    await this.ctx.storage.setAlarm(
      Date.now() + STEP_BUDGET_MS[step] + WATCHDOG_SLACK_MS
    );
  }

  private async readLogTail(host: HostClient): Promise<string | undefined> {
    const tail = await host.exec(
      `tail -c ${LOG_TAIL_BYTES} ${shellQuote(RUN_LOG_PATH)} 2>/dev/null || true`,
      { timeoutMs: 15_000 }
    );
    const text = tail.stdout.trim();
    return text.length > 0 ? text : undefined;
  }

  private checkoutOf(ctx: ActiveRunContext): RuntimeCheckout {
    return {
      repo: ctx.repo,
      repoKey: ctx.record.repoKey,
      directory: workspaceDirectory(ctx.record.repoKey),
      sessionId: ctx.sessionId
    };
  }
}

function runSessionId(repoKey: string): string {
  return `pbr-${repoKey.slice(0, 56)}`;
}

function fallbackRepo(repoKey: string): RepoDefinition {
  return {
    repoKey,
    displayName: repoKey,
    defaultBranch: 'main',
    cloneUrl: `https://github.com/unknown/${repoKey}.git`
  };
}

/**
 * Convention-driven installs: the repo root and each first-level directory
 * that carries a lockfile, in lockfile-appropriate form. Progress lands in
 * the log the poll tails; the script's exit code is the run's install
 * verdict. Idempotent by construction — every installer here tolerates a
 * partially warm node_modules, which is exactly what a seeded re-run has.
 */
function installScript(directory: string): string {
  return `#!/bin/sh
set -e
cd ${shellQuote(directory)}
install_in() {
  d="$1"
  if [ -f "$d/pnpm-lock.yaml" ]; then
    echo "== pnpm install in $d"
    (cd "$d" && pnpm install --frozen-lockfile --prefer-offline)
  elif [ -f "$d/package-lock.json" ]; then
    echo "== npm ci in $d"
    (cd "$d" && npm ci)
  elif [ -f "$d/yarn.lock" ]; then
    echo "== yarn install in $d"
    (cd "$d" && yarn install --frozen-lockfile)
  fi
}
install_in .
for d in */; do
  [ -d "$d" ] && install_in "\${d%/}"
done
echo "== install done"
`;
}

/**
 * The operator's own container variables (registry tokens, mirrors), the
 * same ones a session's OpenCode server gets. The XDG redirects are merged
 * on top by the caller.
 */
async function loadOperatorEnv(env: Env): Promise<Record<string, string>> {
  return containerEnv(await loadContainerCredentials(env));
}

/**
 * The host a run builds on. Bare `docker` is what a run started before hosts
 * were several carries, and it resolves to the first configured one — which is
 * the only host it could have been placed on.
 */
function providerOf(record: PrebuildRunRecord): SessionProvider {
  return record.provider ?? 'docker';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
