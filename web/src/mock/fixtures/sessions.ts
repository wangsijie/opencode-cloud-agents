/**
 * The session inventory — one fixture per UI state the app can render.
 *
 * | id            | covers                                                        |
 * | ------------- | ------------------------------------------------------------- |
 * | ses_working   | live streaming loop, Stop button, warm lastWake, growing usage |
 * | ses_idle      | kitchen-sink transcript, subagents, idle countdown, cold wake |
 * | ses_sleeping  | mirror transcript, asleep composer + panels, wake-on-send     |
 * | ses_waking    | waking runtime badge over a mirror transcript                 |
 * | ses_queued    | boot screen; the store auto-advances it to a first reply      |
 * | ses_starting  | cold-start boot copy                                          |
 * | ses_failed    | failure card + lastError + Retry recovery                     |
 * | ses_lost      | workspace-loss card, disabled composer                        |
 * | ses_error     | runtime error badge                                           |
 * | ses_deleting  | deleting row styling, sending disabled                        |
 * | ses_cjk       | CJK title and transcript                                      |
 * | ses_long      | long-title truncation + variant pill                          |
 * | ses_no_repo   | session started with no repository: /workspace, no Changes tab |
 * | ses_docker    | Docker host: list + header badge, volume-persistence copy      |
 */
import type { SessionUsage, SessionView } from '../../api';
import type { MockSessionState } from '../types';
import { idleChanges, workingChanges } from './changes';
import {
  grepScoutTranscript,
  idleLineages,
  idleTranscript,
  reviewerTranscript,
  shortTranscript,
  workingTranscript
} from './transcript';
import { daysAgo, hoursAgo, inMinutes, minutesAgo } from './util';
import { repoWorkspace } from './workspace';

const usage = (partial: Partial<SessionUsage>): SessionUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  assistantMessages: 0,
  ...partial
});

const bareState = (view: SessionView): MockSessionState => ({
  view,
  transcript: [],
  childTranscripts: {},
  lineages: {}
});

export function buildFixtureSessions(): MockSessionState[] {
  const working: MockSessionState = {
    view: {
      id: 'ses_working',
      provider: 'cloudflare',
      repoKey: 'wangsijie/logto',
      directory: '/workspace/logto',
      model: 'anthropic/claude-opus-4-5',
      variant: 'medium',
      title: 'Add a dark-mode toggle to the settings page.',
      displayTitle: 'Add dark-mode toggle to the settings page',
      phase: 'working',
      status: 'working',
      lastActivityAt: minutesAgo(2),
      instance: {
        id: 'ses_working',
        lifecycle: 'ready',
        runtime: {
          container: 'healthy',
          lifecycle: 'busy',
          // A warm wake: the modal says the container has not come back cold.
          lastWake: { totalMs: 1_850, at: minutesAgo(35), cold: false }
        }
      },
      transcript: {
        mirroredAt: minutesAgo(7),
        messageCount: 2,
        lastMessageAt: minutesAgo(7),
        usage: usage({
          inputTokens: 182_000,
          outputTokens: 9_400,
          reasoningTokens: 3_100,
          cacheReadTokens: 590_000,
          cacheWriteTokens: 41_000,
          cost: 3.72,
          assistantMessages: 2
        })
      }
    },
    transcript: workingTranscript(),
    childTranscripts: {},
    lineages: {},
    changes: workingChanges(),
    workspace: repoWorkspace()
  };

  const idle: MockSessionState = {
    view: {
      id: 'ses_idle',
      provider: 'cloudflare',
      repoKey: 'wangsijie/opencode-cloud',
      directory: '/workspace/opencode-cloud',
      model: 'anthropic/claude-opus-4-5',
      variant: 'high',
      title: 'Refactor the auth middleware: parse the Bearer prefix properly…',
      displayTitle: 'Refactor auth middleware with subagent review',
      phase: 'working',
      status: 'idle',
      lastActivityAt: minutesAgo(25),
      instance: {
        id: 'ses_idle',
        lifecycle: 'ready',
        runtime: {
          container: 'running',
          lifecycle: 'idle',
          idleDeadlineAt: inMinutes(7),
          lastWake: {
            restoreMs: 8_200,
            repoMs: 14_100,
            serverMs: 3_800,
            totalMs: 26_400,
            at: hoursAgo(1),
            cold: true
          }
        }
      },
      transcript: {
        mirroredAt: minutesAgo(25),
        messageCount: 6,
        lastMessageAt: minutesAgo(29),
        usage: usage({
          inputTokens: 1_240_000,
          outputTokens: 96_000,
          reasoningTokens: 84_000,
          cacheReadTokens: 1_160_000,
          cacheWriteTokens: 210_000,
          cost: 12.34,
          assistantMessages: 9
        }),
        opencodeTitle: 'Refactor auth middleware with subagent review'
      }
    },
    transcript: idleTranscript(),
    childTranscripts: {
      agt_review: reviewerTranscript(),
      agt_review_grep: grepScoutTranscript()
    },
    lineages: idleLineages(),
    changes: idleChanges(),
    workspace: repoWorkspace()
  };

  const sleeping: MockSessionState = {
    ...bareState({
      id: 'ses_sleeping',
      provider: 'cloudflare',
      repoKey: 'wangsijie/opencode-cloud',
      model: 'anthropic/claude-sonnet-4-5',
      title: 'Migrate the web build to Vite 8.',
      displayTitle: 'Migrate the web build to Vite 8',
      phase: 'working',
      status: 'sleeping',
      lastActivityAt: hoursAgo(26),
      instance: {
        id: 'ses_sleeping',
        lifecycle: 'ready',
        runtime: { container: 'stopped', lifecycle: 'sleeping' }
      },
      transcript: {
        mirroredAt: hoursAgo(26),
        messageCount: 2,
        lastMessageAt: hoursAgo(26),
        // Tiny usage: exercises the 4-decimal cost branch.
        usage: usage({
          inputTokens: 12_300,
          outputTokens: 1_200,
          cost: 0.0042,
          assistantMessages: 1
        })
      }
    }),
    transcript: shortTranscript({
      prompt: 'Migrate the web build to Vite 8 and fix whatever breaks.',
      reply:
        'Vite 8 is in. The only breakage was the deprecated `ssr.noExternal` shorthand; I moved it to the new `environments` block and the build is green.',
      baseMinutesAgo: 26 * 60
    }),
    mirroredAt: hoursAgo(2),
    changes: undefined,
    workspace: repoWorkspace()
  };

  const waking: MockSessionState = {
    ...bareState({
      id: 'ses_waking',
      provider: 'cloudflare',
      repoKey: 'wangsijie/opencode-cloud',
      model: 'anthropic/claude-sonnet-4-5',
      title: 'Backfill the D1 migration history.',
      displayTitle: 'Backfill D1 migration history',
      phase: 'working',
      status: 'starting',
      lastActivityAt: hoursAgo(30),
      instance: {
        id: 'ses_waking',
        lifecycle: 'ready',
        runtime: { container: 'provisioning', lifecycle: 'waking' }
      },
      transcript: {
        mirroredAt: hoursAgo(30),
        messageCount: 2,
        lastMessageAt: hoursAgo(30)
      }
    }),
    transcript: shortTranscript({
      prompt: 'Backfill the D1 migration history so fresh checkouts apply cleanly.',
      reply: 'Recorded the two hand-applied migrations as files 0003 and 0004.',
      baseMinutesAgo: 30 * 60
    }),
    mirroredAt: hoursAgo(30)
  };

  const queued = bareState({
    id: 'ses_queued',
    provider: 'cloudflare',
    repoKey: 'wangsijie/logto',
    model: 'anthropic/claude-opus-4-5',
    variant: 'medium',
    title: 'Investigate the memory leak in the SSE fan-out.',
    displayTitle: 'Investigate the memory leak in the SSE fan-out',
    phase: 'queued',
    status: 'queued',
    lastActivityAt: minutesAgo(0),
    instance: {
      id: 'ses_queued',
      lifecycle: 'ready',
      runtime: { container: 'none', lifecycle: 'sleeping' }
    }
  });

  const starting = bareState({
    id: 'ses_starting',
    provider: 'cloudflare',
    repoKey: 'silverhand-io/experimental-payment-reconciliation-service',
    model: 'openai/gpt-5.2-codex',
    variant: 'medium',
    title: 'Wire preview deployments for every pull request.',
    displayTitle: 'Wire preview deployments',
    phase: 'starting',
    status: 'starting',
    lastActivityAt: minutesAgo(3),
    instance: {
      id: 'ses_starting',
      lifecycle: 'ready',
      runtime: { container: 'provisioning', lifecycle: 'waking' }
    }
  });

  const failed = bareState({
    id: 'ses_failed',
    provider: 'cloudflare',
    repoKey: 'wangsijie/opencode-cloud',
    model: 'anthropic/claude-sonnet-4-5',
    title: 'Clone from the repo with a revoked deploy key.',
    displayTitle: 'Clone from repo with a revoked deploy key',
    phase: 'failed',
    status: 'failed',
    lastActivityAt: daysAgo(3),
    lastError:
      'git clone failed: Permission denied (publickey). fatal: Could not read from remote repository.',
    instance: {
      id: 'ses_failed',
      lifecycle: 'ready',
      runtime: { container: 'none', lifecycle: 'sleeping' }
    }
  });

  const lost: MockSessionState = {
    ...bareState({
      id: 'ses_lost',
      provider: 'cloudflare',
      repoKey: 'wangsijie/logto',
      model: 'anthropic/claude-opus-4-5',
      title: 'Prototype: WASM sqlite in the Worker.',
      displayTitle: 'Prototype: WASM sqlite in the Worker',
      phase: 'lost',
      status: 'lost',
      lastActivityAt: daysAgo(5),
      lastError:
        'Container instance was recycled without a workspace checkpoint (runtime epoch 4 → 5).',
      instance: {
        id: 'ses_lost',
        lifecycle: 'ready',
        runtime: { container: 'stopped', lifecycle: 'sleeping' }
      },
      transcript: {
        mirroredAt: daysAgo(5),
        messageCount: 2,
        lastMessageAt: daysAgo(5)
      }
    }),
    transcript: shortTranscript({
      prompt: 'Try running sqlite compiled to WASM inside the Worker and benchmark it.',
      reply:
        'Got a proof of concept running; cold instantiation costs ~180 ms and simple selects are near-native. Notes are in docs/wasm-sqlite.md.',
      baseMinutesAgo: 5 * 24 * 60
    }),
    mirroredAt: daysAgo(5)
  };

  const error: MockSessionState = {
    ...bareState({
      id: 'ses_error',
      provider: 'cloudflare',
      repoKey: 'wangsijie/opencode-cloud',
      model: 'anthropic/claude-sonnet-4-5',
      title: 'Container stuck in a restart loop.',
      displayTitle: 'Container stuck in a restart loop',
      phase: 'working',
      status: 'error',
      lastActivityAt: daysAgo(9),
      lastError: 'Runtime status probe failed twice: container exited with code 137.',
      instance: {
        id: 'ses_error',
        lifecycle: 'ready',
        runtime: { container: 'unhealthy', lifecycle: 'error' }
      }
    }),
    transcript: shortTranscript({
      prompt: 'Upgrade the base image to node 24.',
      reply: 'Image built; rolling the container now.',
      baseMinutesAgo: 9 * 24 * 60
    }),
    mirroredAt: daysAgo(9)
  };

  const deleting: MockSessionState = {
    ...bareState({
      id: 'ses_deleting',
      provider: 'cloudflare',
      repoKey: 'wangsijie/logto',
      model: 'anthropic/claude-sonnet-4-5',
      title: 'Teardown test.',
      displayTitle: 'Teardown test',
      phase: 'working',
      status: 'deleting',
      lastActivityAt: daysAgo(10),
      instance: {
        id: 'ses_deleting',
        lifecycle: 'deleting',
        runtime: { container: 'stopping', lifecycle: 'stopping' }
      }
    }),
    transcript: shortTranscript({
      prompt: 'Scratch session to test deletion.',
      reply: 'Nothing to do here.',
      baseMinutesAgo: 10 * 24 * 60
    }),
    mirroredAt: daysAgo(10)
  };

  const cjk: MockSessionState = {
    ...bareState({
      id: 'ses_cjk',
      provider: 'cloudflare',
      repoKey: 'wangsijie/知识库',
      model: 'anthropic/claude-sonnet-4-5',
      title: 'リポジトリの CI を高速化する — キャッシュ導入と並列化の検証',
      displayTitle: 'リポジトリの CI を高速化する — キャッシュ導入と並列化の検証',
      phase: 'working',
      status: 'sleeping',
      lastActivityAt: hoursAgo(4),
      instance: {
        id: 'ses_cjk',
        lifecycle: 'ready',
        runtime: { container: 'stopped', lifecycle: 'sleeping' }
      },
      transcript: {
        mirroredAt: hoursAgo(4),
        messageCount: 2,
        lastMessageAt: hoursAgo(4)
      }
    }),
    transcript: shortTranscript({
      prompt: 'CI の実行時間を短縮してください。キャッシュと並列化を検討して。',
      reply:
        'pnpm ストアのキャッシュ導入とテストの 4 分割並列化で、CI 全体を 11 分 → 4 分に短縮しました。詳細は `.github/workflows/ci.yml` を参照してください。',
      baseMinutesAgo: 4 * 60
    }),
    mirroredAt: hoursAgo(4)
  };

  const long: MockSessionState = {
    ...bareState({
      id: 'ses_long',
      provider: 'cloudflare',
      repoKey: 'silverhand-io/experimental-payment-reconciliation-service',
      model: 'anthropic/claude-opus-4-5',
      variant: 'high',
      title:
        'Implement the full end-to-end release pipeline including changelog generation, artifact signing, staged rollouts, automated smoke tests and rollback triggers for the reconciliation service',
      displayTitle:
        'Implement the full end-to-end release pipeline including changelog generation, artifact signing, staged rollouts, automated smoke tests and rollback triggers',
      phase: 'working',
      status: 'idle',
      lastActivityAt: hoursAgo(1),
      instance: {
        id: 'ses_long',
        lifecycle: 'ready',
        runtime: {
          container: 'running',
          lifecycle: 'idle',
          idleDeadlineAt: inMinutes(12),
          lastWake: {
            restoreMs: 5_100,
            repoMs: 22_800,
            serverMs: 2_900,
            totalMs: 30_800,
            at: hoursAgo(1),
            cold: true
          }
        }
      },
      transcript: {
        mirroredAt: hoursAgo(1),
        messageCount: 2,
        lastMessageAt: hoursAgo(1),
        usage: usage({
          inputTokens: 310_000,
          outputTokens: 22_000,
          reasoningTokens: 40_000,
          cacheReadTokens: 120_000,
          cacheWriteTokens: 33_000,
          cost: 4.05,
          assistantMessages: 3
        })
      }
    }),
    transcript: shortTranscript({
      prompt:
        'Design and implement the release pipeline: changelog, signing, staged rollout, smoke tests, rollback.',
      reply:
        'Pipeline skeleton is in `.github/workflows/release.yml`; changelog and signing stages are done, staged rollout is next.',
      baseMinutesAgo: 60
    }),
    workspace: repoWorkspace()
  };

  // Started from the composer's "No repository": nothing was cloned, so there
  // is no repoKey, no diff and no Changes tab — only the workspace.
  const noRepo: MockSessionState = {
    ...bareState({
      id: 'ses_no_repo',
      provider: 'cloudflare',
      directory: '/workspace',
      model: 'anthropic/claude-opus-4-5',
      title: 'Sketch a migration plan before touching any repository.',
      displayTitle: 'Sketch a migration plan',
      phase: 'working',
      status: 'idle',
      lastActivityAt: minutesAgo(6),
      instance: {
        id: 'ses_no_repo',
        lifecycle: 'ready',
        runtime: {
          container: 'running',
          lifecycle: 'idle',
          idleDeadlineAt: inMinutes(9)
        }
      },
      transcript: {
        mirroredAt: minutesAgo(6),
        messageCount: 2,
        lastMessageAt: minutesAgo(6)
      }
    }),
    transcript: shortTranscript({
      prompt: 'Draft a plan for splitting the monolith, no code yet.',
      reply:
        'Wrote `plan.md` in the workspace: four phases, each behind its own flag.',
      baseMinutesAgo: 6
    }),
    workspace: repoWorkspace()
  };

  // The only session on the Docker host: the badge in the list and the header,
  // and an instance modal that says the workspace lives on a volume rather than
  // in a snapshot. Asleep, because that is where the difference is visible —
  // this one's container is gone and its checkout is not.
  const docker: MockSessionState = {
    ...bareState({
      id: 'ses_docker',
      provider: 'docker',
      repoKey: 'wangsijie/logto',
      directory: '/workspace/logto',
      model: 'anthropic/claude-opus-4-5',
      variant: 'high',
      title: 'Profile the connector test suite on the mini.',
      displayTitle: 'Profile the connector test suite',
      phase: 'working',
      status: 'sleeping',
      lastActivityAt: hoursAgo(5),
      instance: {
        id: 'ses_docker',
        lifecycle: 'ready',
        runtime: {
          container: 'stopped',
          lifecycle: 'sleeping',
          // No restore stage: a volume is already there when the container
          // starts, so a Docker wake has one fewer thing to wait for.
          lastWake: {
            restoreMs: 1_400,
            repoMs: 900,
            serverMs: 2_600,
            totalMs: 4_900,
            at: hoursAgo(5),
            cold: true
          }
        }
      },
      transcript: {
        mirroredAt: hoursAgo(5),
        messageCount: 2,
        lastMessageAt: hoursAgo(5),
        usage: usage({
          inputTokens: 48_000,
          outputTokens: 3_100,
          cost: 0.41,
          assistantMessages: 1
        })
      }
    }),
    transcript: shortTranscript({
      prompt: 'Find out why the connector tests take four minutes on this box.',
      reply:
        'It is the Docker bind mount: the suite stats every fixture twice. Caching the listing in `setup.ts` takes it to 48 seconds.',
      baseMinutesAgo: 5 * 60
    }),
    mirroredAt: hoursAgo(5),
    workspace: repoWorkspace()
  };

  return [
    working,
    idle,
    sleeping,
    waking,
    queued,
    starting,
    failed,
    lost,
    error,
    deleting,
    cjk,
    long,
    noRepo,
    docker
  ];
}
