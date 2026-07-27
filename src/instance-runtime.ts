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
import type { InstanceRuntimeStatus } from './instances';
import type { LifecycleStatus } from './lifecycle';

/** How long an explicit wake stays attached to a queued lifecycle transition. */
const WAKE_POLL_INTERVAL_MS = 500;
const WAKE_POLL_ATTEMPTS = 60;

/** The container port the OpenCode server listens on. */
export const OPENCODE_PORT = 4096;

/**
 * Every container request carries the runtime generation it was issued for, so
 * a request that survives a stop/start lands in an error instead of silently
 * reaching a newer container.
 */
export const RUNTIME_EPOCH_HEADER = 'x-opencode-hub-runtime';

export interface CreateOpencodeSessionInput {
  directory: string;
}

export interface PromptOpencodeSessionInput {
  opencodeSessionId: string;
  directory: string;
  providerID: string;
  modelID: string;
  /** OpenCode model variant (reasoning effort), when the model defines any. */
  variant?: string;
  text: string;
}

export interface ListOpencodeSessionMessagesInput {
  opencodeSessionId: string;
  directory: string;
}

/**
 * Resolve where a subagent session sits under the container's root session.
 * `rootOpencodeSessionId` is what the walk has to reach for the requested id to
 * be readable through this Hub session at all (see
 * [session-lineage.ts](session-lineage.ts)).
 */
export interface GetOpencodeSessionLineageInput {
  opencodeSessionId: string;
  rootOpencodeSessionId: string;
  directory: string;
}

export interface AbortOpencodeSessionInput {
  opencodeSessionId: string;
  directory: string;
}

export interface OpencodeSessionActivityInput {
  opencodeSessionId: string;
  directory: string;
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
  isOpencodeSessionActive(
    runtimeEpoch: string,
    input: OpencodeSessionActivityInput
  ): Promise<boolean>;
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
  instanceId: string
): InstanceSandboxRpc {
  return getSandbox(env.Sandbox, instanceId, {
    normalizeId: true,
    keepAlive: true
  }) as unknown as InstanceSandboxRpc;
}

export function resolveInstanceLifecycle(env: Env, instanceId: string) {
  return env.LifecycleCoordinator.getByName(instanceId);
}

/** Read the lifecycle status, initializing the coordinator on first contact. */
export async function ensureLifecycleInitialized(
  env: Env,
  instanceId: string,
  lifecycle = resolveInstanceLifecycle(env, instanceId)
): Promise<LifecycleStatus> {
  const status = await lifecycle.getLifecycleStatus();
  return status.phase === 'uninitialized'
    ? lifecycle.initializeInstance({ instanceId })
    : status;
}

/**
 * The only helper allowed to start a stopped runtime. Callers must represent
 * explicit user intent: creating a session, sending a session message, or an
 * operator starting the container by hand.
 */
export async function wakeInstanceRuntime(
  env: Env,
  instanceId: string,
  lifecycle = resolveInstanceLifecycle(env, instanceId)
): Promise<{ runtimeEpoch: string; status: LifecycleStatus }> {
  await ensureLifecycleInitialized(env, instanceId, lifecycle);
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
