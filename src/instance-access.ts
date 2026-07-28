/**
 * Worker-side access to one instance's Durable Objects.
 *
 * These helpers resolve the Sandbox and LifecycleCoordinator stubs behind
 * an instance id and turn them into the `InstanceView` the API returns. They
 * are the only place the Worker decides what "this instance is unreachable"
 * looks like, so the instance API, the session API and the stock-UI proxy all
 * report the same thing.
 *
 * The sibling [instance-runtime.ts](instance-runtime.ts) holds the subset the
 * SessionAgent Durable Object also needs, declared structurally so that object
 * never imports the Sandbox class.
 */
import { HttpError, isSafeInstanceId, json } from './http';
import { getInstance } from './hub-store';
import {
  ensureLifecycleInitialized,
  InstanceWakePendingError,
  wakeInstanceRuntime
} from './instance-runtime';
import type {
  InstanceRecord,
  InstanceRuntimeStatus,
  InstanceView
} from './instances';
import type { LifecycleStatus } from './lifecycle';
import type { Sandbox } from './sandbox';

/**
 * Every container-bound call is a Durable Object RPC method on `Sandbox`.
 *
 * A plain stub, named by the instance id. It used to come from the sandbox
 * SDK's `getSandbox()`, which wrapped it in client-side proxies — `terminal()`
 * upgrading a WebSocket onto the container's PTY was the one this app used, and
 * it is gone. Nothing reaches around the class: a proxy that bypasses it
 * bypasses the runtime gate, which is exactly how the terminal came to be dead
 * on arrival. `getByName` hashes the same name `getSandbox` did, so an existing
 * instance resolves to the object that holds its state.
 */
export function resolveSandbox(env: Env, instance: InstanceRecord): Sandbox {
  return env.Sandbox.getByName(instance.id) as unknown as Sandbox;
}

export function resolveLifecycle(env: Env, instanceId: string) {
  return env.LifecycleCoordinator.getByName(instanceId);
}

export async function wakeInstance(
  env: Env,
  record: InstanceRecord,
  lifecycle = resolveLifecycle(env, record.id)
): Promise<{
  runtimeEpoch: string;
  status: LifecycleStatus;
}> {
  try {
    return await wakeInstanceRuntime(env, record.id, lifecycle);
  } catch (error) {
    if (error instanceof InstanceWakePendingError) {
      throw new HttpError(503, error.message);
    }
    throw error;
  }
}

export async function getMergedRuntimeStatus(
  sandbox: Sandbox,
  lifecycle: LifecycleStatus
): Promise<InstanceRuntimeStatus> {
  const platform = await sandbox.getInstanceRuntimeStatus();
  return {
    ...platform,
    lifecycle: lifecycle.lifecycle,
    ...(lifecycle.idleSince ? { idleSince: lifecycle.idleSince } : {}),
    ...(lifecycle.idleDeadlineAt
      ? { idleDeadlineAt: lifecycle.idleDeadlineAt }
      : {}),
    ...(lifecycle.activeSessionCount !== undefined
      ? { activeSessionCount: lifecycle.activeSessionCount }
      : {}),
    ...(lifecycle.lastActivityProbeAt
      ? { lastActivityProbeAt: lifecycle.lastActivityProbeAt }
      : {}),
    ...(lifecycle.lifecycleError
      ? { lifecycleError: lifecycle.lifecycleError }
      : {})
  };
}

export async function rejectUnlessRuntimeAdmitted(
  env: Env,
  instanceId: string,
  runtimeEpoch: string
): Promise<Response | undefined> {
  const admission = await resolveLifecycle(env, instanceId).admit(runtimeEpoch);
  return admission.admitted
    ? undefined
    : lifecycleUnavailableResponse(admission.reason, admission.phase);
}

export function lifecycleUnavailableResponse(reason: string, phase: string): Response {
  return Response.json(
    {
      error: 'INSTANCE_SLEEPING',
      message: 'This runtime generation no longer accepts passive requests',
      reason,
      phase
    },
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'X-OpenCode-Hub-State': phase
      }
    }
  );
}

export async function requireInstance(env: Env, id: string): Promise<InstanceRecord> {
  if (!isSafeInstanceId(id)) {
    throw new HttpError(400, 'Invalid instance id');
  }
  const instance = await getInstance(env, id);
  if (!instance) {
    throw new HttpError(404, 'Instance not found');
  }
  return instance;
}

export async function requireReadyInstance(
  env: Env,
  id: string
): Promise<InstanceRecord> {
  const instance = await requireInstance(env, id);
  if (instance.lifecycle !== 'ready') {
    throw new HttpError(
      409,
      instance.lifecycle === 'deleting'
        ? 'Instance is being deleted'
        : 'Instance deletion failed; retry deletion from the Hub'
    );
  }
  return instance;
}



export function unknownRuntimeStatus(deleting: boolean): InstanceRuntimeStatus {
  return {
    container: 'unknown',
    deleting,
    lifecycle: deleting ? 'stopping' : 'error',
    persistence: {
      hasBackup: false,
      trackedBackupCount: 0
    },
    platformRunning: false
  };
}

export async function getInstanceView(
  env: Env,
  record: InstanceRecord
): Promise<InstanceView> {
  if (record.lifecycle !== 'ready') {
    return {
      ...record,
      runtime: unknownRuntimeStatus(true)
    };
  }
  try {
    const sandbox = resolveSandbox(env, record);
    const lifecycle = resolveLifecycle(env, record.id);
    const lifecycleStatus = await ensureLifecycleInitialized(
      env,
      record.id,
      lifecycle
    );
    return {
      ...record,
      runtime: await getMergedRuntimeStatus(sandbox, lifecycleStatus)
    };
  } catch (error) {
    console.warn(`Failed to read instance ${record.id} status`, error);
    return {
      ...record,
      runtime: unknownRuntimeStatus(false)
    };
  }
}
