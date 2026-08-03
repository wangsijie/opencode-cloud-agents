/**
 * D1 mirror of per-session runtime status for the session list.
 *
 * Lives apart from [hub-store.ts](hub-store.ts) so the LifecycleCoordinator can
 * write here without importing the rest of the registry (and the type-only
 * cycle that would create). Cache writes deliberately leave `updated_at`
 * alone — calibration is not activity.
 */
import { eq } from 'drizzle-orm';
import { db, sessions } from './db/index.ts';
import type { RuntimeLifecycle } from './instances.ts';
import {
  containerHintForRuntimeLifecycle,
  runtimeLifecycleNeedsStatusQuery,
  type CachedContainerStatus
} from './sessions.ts';

/** Patch accepted by {@link patchSessionRuntimeStatus}. */
export interface SessionRuntimeStatusPatch {
  runtimeLifecycle: RuntimeLifecycle;
  container?: CachedContainerStatus;
  /**
   * When omitted, derived from `runtimeLifecycle`: idle/sleeping clear the
   * flag, everything else sets it.
   */
  statusQuery?: boolean;
}

/**
 * Mirror runtime status onto the session row for fast list reads.
 *
 * Called from the LifecycleCoordinator on transitions and from list/detail
 * calibration after a live query.
 */
export async function patchSessionRuntimeStatus(
  env: Env,
  id: string,
  patch: SessionRuntimeStatusPatch
): Promise<void> {
  const statusQuery =
    patch.statusQuery ??
    runtimeLifecycleNeedsStatusQuery(patch.runtimeLifecycle);
  const container =
    patch.container ??
    containerHintForRuntimeLifecycle(patch.runtimeLifecycle);
  await db(env)
    .update(sessions)
    .set({
      runtimeLifecycle: patch.runtimeLifecycle,
      container,
      statusQuery: statusQuery ? 1 : 0,
      statusObservedAt: new Date().toISOString()
    })
    .where(eq(sessions.id, id));
}

/**
 * Mark a session so the list keeps live-querying it.
 *
 * Intent paths (send, retry, abort, wake) call this when runtime state is
 * about to change and the coordinator has not yet pushed a hot lifecycle.
 */
export async function markSessionStatusQuery(
  env: Env,
  id: string
): Promise<void> {
  await db(env)
    .update(sessions)
    .set({ statusQuery: 1 })
    .where(eq(sessions.id, id));
}
