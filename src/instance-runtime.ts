/**
 * Shared instance runtime access.
 *
 * Both the Worker router and the SessionAgent Durable Object need to resolve an
 * instance's Sandbox/LifecycleCoordinator stubs and to wake a sleeping runtime
 * through the single explicit-intent path. The RPC surfaces are declared
 * structurally (as in [lifecycle.ts](lifecycle.ts)) so this module never has to
 * import the Sandbox class and create a module cycle with the Worker entry.
 */
import { getSandbox } from '@cloudflare/sandbox';
import {
  CURRENT_IMAGE_KEY,
  LOGTO_IMAGE_KEY,
  type ImageKey,
  type InstanceRuntimeStatus
} from './instances';
import type { LifecycleStatus } from './lifecycle';

/** How long an explicit wake stays attached to a queued lifecycle transition. */
const WAKE_POLL_INTERVAL_MS = 500;
const WAKE_POLL_ATTEMPTS = 60;

export interface CreateOpencodeSessionInput {
  title: string;
  directory: string;
}

export interface PromptOpencodeSessionInput {
  opencodeSessionId: string;
  directory: string;
  providerID: string;
  modelID: string;
  text: string;
}

/** The subset of Sandbox RPC the session dispatcher depends on. */
export interface InstanceSandboxRpc {
  getInstanceRuntimeStatus(): Promise<InstanceRuntimeStatus>;
  createOpencodeSession(
    runtimeEpoch: string,
    input: CreateOpencodeSessionInput
  ): Promise<string>;
  promptOpencodeSessionAsync(
    runtimeEpoch: string,
    input: PromptOpencodeSessionInput
  ): Promise<void>;
}

/** Raised when a wake is queued behind an in-flight shutdown barrier. */
export class InstanceWakePendingError extends Error {
  constructor(message = 'Instance wake is still pending; retry shortly') {
    super(message);
    this.name = 'InstanceWakePendingError';
  }
}

export function resolveInstanceSandbox(
  env: Env,
  instanceId: string,
  imageKey: ImageKey
): InstanceSandboxRpc {
  switch (imageKey) {
    case CURRENT_IMAGE_KEY:
      return getSandbox(env.Sandbox, instanceId, {
        normalizeId: true,
        keepAlive: true
      }) as unknown as InstanceSandboxRpc;
    case LOGTO_IMAGE_KEY:
      return getSandbox(env.LogtoSandbox, instanceId, {
        normalizeId: true,
        keepAlive: true
      }) as unknown as InstanceSandboxRpc;
    default:
      throw new Error(`Unsupported image: ${String(imageKey)}`);
  }
}

export function resolveInstanceLifecycle(env: Env, instanceId: string) {
  return env.LifecycleCoordinator.getByName(instanceId);
}

/**
 * Read the lifecycle status, initializing the coordinator on first contact.
 * A container which predates the coordinator is adopted rather than started.
 */
export async function ensureLifecycleInitialized(
  env: Env,
  instanceId: string,
  imageKey: ImageKey,
  sandbox: InstanceSandboxRpc = resolveInstanceSandbox(env, instanceId, imageKey),
  lifecycle = resolveInstanceLifecycle(env, instanceId)
): Promise<LifecycleStatus> {
  const status = await lifecycle.getLifecycleStatus();
  if (status.phase !== 'uninitialized') {
    return status;
  }

  const runtime = await sandbox.getInstanceRuntimeStatus();
  return lifecycle.initializeInstance({
    instanceId,
    imageKey,
    containerRunning: runtime.platformRunning
  });
}

/**
 * The only helper allowed to start a stopped runtime. Callers must represent
 * explicit user intent: opening the stock UI, creating a session, or sending a
 * session message.
 */
export async function wakeInstanceRuntime(
  env: Env,
  instanceId: string,
  imageKey: ImageKey,
  sandbox: InstanceSandboxRpc = resolveInstanceSandbox(env, instanceId, imageKey),
  lifecycle = resolveInstanceLifecycle(env, instanceId)
): Promise<{ runtimeEpoch: string; status: LifecycleStatus }> {
  await ensureLifecycleInitialized(env, instanceId, imageKey, sandbox, lifecycle);
  let result = await lifecycle.wake();

  // A wake racing with the final idle-stop barrier is queued by the
  // coordinator. Stay attached briefly so one explicit intent normally lands in
  // the newly-created runtime epoch without a second request.
  for (
    let attempt = 0;
    result.pending && attempt < WAKE_POLL_ATTEMPTS;
    attempt += 1
  ) {
    await scheduler.wait(WAKE_POLL_INTERVAL_MS);
    result = await lifecycle.wake();
  }
  if (!result.ready || !result.runtimeEpoch) {
    throw new InstanceWakePendingError();
  }
  return { runtimeEpoch: result.runtimeEpoch, status: result.status };
}
