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
import {
  updatePrebuildRun,
  upsertPrebuildRecord,
  insertPrebuildRun,
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

const RUN_STORAGE_KEY = 'prebuild:run';

/** How much of the install log rides along on each poll. */
const LOG_TAIL_BYTES = 4000;

const POLL_INTERVAL_MS = 10 * 1000;

/**
 * Per-step budgets. The watchdog alarm fires past `budget + slack` only when
 * the invocation that owned the step died; a step that merely takes long is
 * still awaited by its own invocation.
 */
const STEP_BUDGET_MS: Record<RunStep, number> = {
  provision: 10 * 60 * 1000,
  'install-start': 2 * 60 * 1000,
  install: 30 * 60 * 1000,
  stop: 2 * 60 * 1000,
  promote: 20 * 60 * 1000,
  cleanup: 5 * 60 * 1000
};
const WATCHDOG_SLACK_MS = 60 * 1000;

type RunStep =
  | 'provision'
  | 'install-start'
  | 'install'
  | 'stop'
  | 'promote'
  | 'cleanup';

interface RunState {
  runId: string;
  repoKey: string;
  repo: RepoDefinition;
  /**
   * Which Docker host this run builds on. Absent on a run that was underway
   * when this field arrived, which is read as the first configured host —
   * the only one such a run could have been placed on.
   */
  provider?: SessionProvider;
  /** The throwaway host session the run drives. */
  sessionId: string;
  step: RunStep;
  stepStartedAt: number;
  startedAt: number;
  /** Retries of the current step after a suspected death; 2 strikes out. */
  attempts: number;
  timings: PrebuildRunTimings;
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
  /**
   * Begin a run, unless one is already underway for this repo. The run row is
   * inserted here, inside the same object that will update it, so a row in
   * `running` with no coordinator behind it can only mean a crash the
   * watchdog will convert to `failed`.
   */
  async startRun(input: StartPrebuildRunInput): Promise<StartPrebuildRunResult> {
    const existing = await this.ctx.storage.get<RunState>(RUN_STORAGE_KEY);
    if (existing) {
      return { started: false, reason: 'busy' };
    }
    const state: RunState = {
      runId: input.runId,
      repoKey: input.repoKey,
      repo: input.repo,
      provider: input.provider,
      // Deterministic, and sliced so the id stays inside the protocol's
      // 64-char session-id bound for the longest legal repo key.
      sessionId: `pbr-${input.repoKey.slice(0, 56)}`,
      step: 'provision',
      stepStartedAt: Date.now(),
      startedAt: Date.now(),
      attempts: 0,
      timings: {}
    };
    await insertPrebuildRun(this.env, {
      id: input.runId,
      repoKey: input.repoKey,
      provider: input.provider,
      status: 'running',
      startedAt: new Date().toISOString()
    });
    await this.ctx.storage.put(RUN_STORAGE_KEY, state);
    await this.ctx.storage.setAlarm(Date.now());
    return { started: true };
  }

  /** Whether a run is underway. The API's 409 for delete-while-building. */
  async isRunning(): Promise<boolean> {
    return (await this.ctx.storage.get<RunState>(RUN_STORAGE_KEY)) !== undefined;
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<RunState>(RUN_STORAGE_KEY);
    if (!state) {
      return;
    }
    // An alarm for an inline step can only mean the invocation that ran it
    // died (success re-arms the alarm for the *next* step before returning).
    // The poll step is the exception: its alarms are the ordinary heartbeat.
    if (state.step !== 'install') {
      state.attempts += 1;
      if (state.attempts > 2) {
        await this.failRun(
          state,
          `The ${state.step} step died twice; giving up`
        );
        return;
      }
      await this.ctx.storage.put(RUN_STORAGE_KEY, state);
    } else if (Date.now() - state.stepStartedAt > STEP_BUDGET_MS.install) {
      await this.failRun(state, 'The install ran past its 30 minute budget');
      return;
    }

    try {
      await this.runStep(state);
    } catch (error) {
      await this.failRun(state, describeError(error));
    }
  }

  private async runStep(state: RunState): Promise<void> {
    const host = await resolveHostClient(
      this.env,
      state.sessionId,
      providerOf(state)
    );
    switch (state.step) {
      case 'provision':
        return this.provision(state, host);
      case 'install-start':
        return this.startInstall(state, host);
      case 'install':
        return this.pollInstall(state, host);
      case 'stop':
        return this.stopContainer(state, host);
      case 'promote':
        return this.promote(state, host);
      case 'cleanup':
        return this.cleanup(state, host);
    }
  }

  /**
   * Everything before the install: a clean slate (a crashed run's leftovers
   * are removed, idempotently), a fresh container — seeded from the existing
   * prebuild when there is one, which is what makes a re-run incremental —
   * credentials, and a checkout on the current default branch.
   */
  private async provision(state: RunState, host: HostClient): Promise<void> {
    await this.armWatchdog(state);
    const startedAt = Date.now();
    await host.remove();
    const ensured = await host.ensure({ repoKey: state.repoKey });
    const checkout = this.checkoutOf(state);
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
          `Prebuild run seed unusable for ${state.repoKey}; wiping and cloning`,
          error
        );
        await wipeSeededWorkspace(host, checkout);
        await provisionRepository(host, checkout);
      }
    } else {
      await provisionRepository(host, checkout);
    }
    state.timings.cloneMs = Date.now() - startedAt;
    await this.advance(state, 'install-start');
  }

  /**
   * Launch the install script detached and let the container run it alone.
   * The started-marker makes a retried launch a no-op instead of a second
   * install racing the first.
   */
  private async startInstall(state: RunState, host: HostClient): Promise<void> {
    await this.armWatchdog(state);
    const started = await host.exists(RUN_STARTED_PATH);
    if (!started.exists) {
      await host.writeBatch([
        {
          path: RUN_SCRIPT_PATH,
          content: installScript(this.checkoutOf(state).directory),
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
    await this.advance(state, 'install', { alarmInMs: POLL_INTERVAL_MS });
  }

  /** One heartbeat: done yet? If not, refresh the log tail and re-arm. */
  private async pollInstall(state: RunState, host: HostClient): Promise<void> {
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
      await updatePrebuildRun(this.env, state.runId, { logTail: tail });
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
    state.timings.installMs = Date.now() - state.stepStartedAt;
    await this.advance(state, 'stop');
  }

  /**
   * Stop the container so the promote copies a quiescent volume. Pending
   * terminations are retried inline rather than via the alarm — an alarm
   * retry on this step would be indistinguishable from a died invocation.
   */
  private async stopContainer(state: RunState, host: HostClient): Promise<void> {
    await this.armWatchdog(state);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const stopped = await host.stop(5);
      if (stopped.stopped) {
        await this.advance(state, 'promote');
        return;
      }
      await scheduler.wait(3_000);
    }
    throw new Error('The run container would not stop');
  }

  private async promote(state: RunState, host: HostClient): Promise<void> {
    await this.armWatchdog(state);
    const startedAt = Date.now();
    const promoted = await host.prebuildPromote({
      repoKey: state.repoKey,
      // The one workspace file that is the site's bookkeeping, not the
      // repo's: a seeded workspace must not arrive looking already-restored.
      exclude: [PERSISTENCE_MARKER_NAME]
    });
    state.timings.promoteMs = Date.now() - startedAt;
    await upsertPrebuildRecord(this.env, {
      repoKey: state.repoKey,
      provider: providerOf(state),
      // Mirrors `prebuildVolumeName` in agent/docker.mjs.
      location: `oc-prebuild-${state.repoKey}`,
      ...(promoted.sizeBytes !== undefined
        ? { sizeBytes: promoted.sizeBytes }
        : {}),
      source: 'run',
      updatedAt: new Date().toISOString()
    });
    await this.advance(state, 'cleanup');
  }

  private async cleanup(state: RunState, host: HostClient): Promise<void> {
    await this.armWatchdog(state);
    await host.remove();
    state.timings.totalMs = Date.now() - state.startedAt;
    await updatePrebuildRun(this.env, state.runId, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
      timings: state.timings
    });
    await this.ctx.storage.delete(RUN_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Terminal failure: record it, then make a best effort at not leaking the
   * throwaway container. The existing prebuild, if any, is untouched — a
   * failed refresh keeps yesterday's warm copy.
   */
  private async failRun(state: RunState, message: string): Promise<void> {
    console.warn(`Prebuild run failed for ${state.repoKey}: ${message}`);
    await updatePrebuildRun(this.env, state.runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      timings: state.timings,
      error: message.slice(0, 2000)
    });
    await this.ctx.storage.delete(RUN_STORAGE_KEY);
    await this.ctx.storage.deleteAlarm();
    try {
      const host = await resolveHostClient(
        this.env,
        state.sessionId,
        providerOf(state)
      );
      await host.remove();
    } catch (error) {
      console.warn('Prebuild run cleanup failed', error);
    }
  }

  /** Move to the next step and arm its alarm (watchdog or poll heartbeat). */
  private async advance(
    state: RunState,
    step: RunStep,
    options: { alarmInMs?: number } = {}
  ): Promise<void> {
    state.step = step;
    state.stepStartedAt = Date.now();
    state.attempts = 0;
    await this.ctx.storage.put(RUN_STORAGE_KEY, state);
    await this.ctx.storage.setAlarm(
      Date.now() +
        (options.alarmInMs ?? STEP_BUDGET_MS[step] + WATCHDOG_SLACK_MS)
    );
    await this.runStep(state);
  }

  /**
   * Re-arm the current step's watchdog before its long awaits, so a died
   * invocation is retried (then failed) instead of leaving the run stuck.
   */
  private async armWatchdog(state: RunState): Promise<void> {
    await this.ctx.storage.setAlarm(
      Date.now() + STEP_BUDGET_MS[state.step] + WATCHDOG_SLACK_MS
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

  private checkoutOf(state: RunState): RuntimeCheckout {
    return {
      repo: state.repo,
      repoKey: state.repoKey,
      directory: workspaceDirectory(state.repoKey),
      sessionId: state.sessionId
    };
  }
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
function providerOf(state: RunState): SessionProvider {
  return state.provider ?? 'docker';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
