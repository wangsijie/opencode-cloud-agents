/**
 * Instance API: the container behind a session, addressed directly.
 *
 * These routes are the operator-level view (list, inspect, wake, checkpoint,
 * stop, delete). Product-level work goes through the session API instead.
 */
import { HttpError, decodeRouteSegment, json, methodNotAllowed } from './http';
import * as hubStore from './hub-store';
import {
  getInstanceView,
  getMergedRuntimeStatus,
  lifecycleUnavailableResponse,
  requireInstance,
  requireReadyInstance,
  resolveLifecycle,
  resolveSandbox,
  wakeInstance
} from './instance-access';
import { ensureLifecycleInitialized } from './instance-runtime';

export async function handleHubApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Instances are only created as part of a session. What remains here is the
  // operational surface: reading container state and driving one runtime.
  if (url.pathname === '/api/instances') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    const records = await hubStore.listInstances(env);
    return json(
      await Promise.all(records.map((record) => getInstanceView(env, record)))
    );
  }

  const match = /^\/api\/instances\/([^/]+)(?:\/([^/]+))?$/.exec(
    url.pathname
  );
  if (!match) {
    throw new HttpError(404, 'Instance API route not found');
  }
  const id = decodeRouteSegment(match[1]);
  const action = match[2];

  if (!action) {
    if (request.method === 'GET') {
      const record = await requireInstance(env, id);
      return json(await getInstanceView(env, record));
    }
    if (request.method === 'DELETE') {
      const deleting = await hubStore.beginDelete(env, id);
      if (!deleting) {
        throw new HttpError(404, 'Instance not found');
      }
      return json(
        {
          deleting: true,
          id,
          operationId: deleting.deleteOperationId
        },
        202
      );
    }
    return methodNotAllowed('GET, DELETE');
  }

  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  const record = await requireReadyInstance(env, id);
  const sandbox = resolveSandbox(env, record);
  const lifecycle = resolveLifecycle(env, record.id);
  switch (action) {
    // Nothing in the UI wakes a container directly any more — sending a message
    // does, through the session agent. This stays as the operator's manual
    // start, and now answers with runtime state rather than a URL to enter.
    case 'wake': {
      const wake = await wakeInstance(env, record, lifecycle);
      return json({
        runtime: await getMergedRuntimeStatus(sandbox, wake.status)
      });
    }
    case 'checkpoint': {
      const runtime = await ensureLifecycleInitialized(
        env,
        record.id,
        lifecycle,
        record.provider
      );
      // A sleeping instance was already checkpointed before it stopped. Do
      // not start it merely to create an identical manual checkpoint.
      if (!runtime.admissionOpen) {
        return json(await sandbox.getPersistenceStatus());
      }
      if (!runtime.runtimeEpoch) {
        throw new HttpError(409, 'Running lifecycle has no runtime epoch');
      }
      return json(await sandbox.checkpointWorkspace(runtime.runtimeEpoch));
    }
    case 'stop':
      await ensureLifecycleInitialized(
        env,
        record.id,
        lifecycle,
        record.provider
      );
      await lifecycle.forceStop();
      return json(await getInstanceView(env, record));
    case 'test': {
      const wake = await wakeInstance(env, record, lifecycle);
      const lease = await lifecycle.beginWork(wake.runtimeEpoch);
      if (!lease.admitted) {
        return lifecycleUnavailableResponse(lease.reason, lease.phase);
      }
      try {
        return await sandbox.runSdkTest(wake.runtimeEpoch);
      } finally {
        await lifecycle.endWork(wake.runtimeEpoch, lease.leaseId);
      }
    }
    default:
      throw new HttpError(404, 'Instance action not found');
  }
}
