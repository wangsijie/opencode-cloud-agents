import { DurableObject } from 'cloudflare:workers';
import {
  deferDelete,
  finishDelete,
  hasPendingDeletion,
  markDeleteFailed,
  nextPendingDeletion
} from './hub-store';
import type { LifecycleCoordinator } from './lifecycle';

/** The storage key the registry lived under before it moved to D1. */
const LEGACY_SCHEMA_VERSION_KEY = 'hub:schema-version';
const DELETE_ATTEMPT_TIMEOUT_MS = 12 * 60 * 1000;

class DeleteAttemptTimeoutError extends Error {}

/**
 * The Hub Durable Object is what remains of the registry after the records
 * moved to D1 (see [hub-store.ts](hub-store.ts)): the alarm that drains the
 * deletion queue. Deleting an instance means purging a container and its R2
 * backups, which can take minutes and must not overlap — a single object's
 * alarm is exactly one worker running exactly one attempt at a time, and it
 * fires the moment `beginDelete` pokes it rather than on a cron's schedule.
 */
export class Hub extends DurableObject<Env> {
  private readonly initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      // The registry this object used to hold was left behind, not migrated;
      // the marker key is only present on storage from that era.
      if ((await ctx.storage.get(LEGACY_SCHEMA_VERSION_KEY)) !== undefined) {
        await ctx.storage.deleteAll();
      }
      // A crash between the D1 claim and the poke would otherwise strand a
      // queued deletion until the next delete request happens to arrive.
      if (
        (await ctx.storage.getAlarm()) === null &&
        (await hasPendingDeletion(env))
      ) {
        await ctx.storage.setAlarm(Date.now());
      }
    });
  }

  /** Make sure the queue will be looked at; called after every `beginDelete`. */
  async poke(): Promise<void> {
    await this.initialized;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    const record = await nextPendingDeletion(this.env);
    if (record) {
      const operationId = record.deleteOperationId!;
      try {
        const sandbox = resolveSandbox(this.env, record.id);
        const lifecycle = resolveLifecycle(this.env, record.id);
        await lifecycle.beginDelete();
        const purgeResult = await withTimeout(
          sandbox.purgeInstance(),
          DELETE_ATTEMPT_TIMEOUT_MS,
          `Timed out deleting instance ${record.id}`
        );
        if (purgeResult.outcome === 'termination_pending') {
          console.warn(`Container termination pending for ${record.id}`);
          await deferDelete(
            this.env,
            record.id,
            operationId,
            'Container termination is still pending'
          );
        } else {
          await lifecycle.markDeleted();
          await finishDelete(this.env, record.id, operationId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DeleteAttemptTimeoutError) {
          console.warn(`Delete attempt timed out for ${record.id}`);
          await deferDelete(this.env, record.id, operationId, message);
        } else {
          console.error(`Failed to delete instance ${record.id}`, error);
          await markDeleteFailed(this.env, record.id, operationId, message);
        }
      }
    }

    if (await hasPendingDeletion(this.env)) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }
}

function resolveSandbox(env: Env, id: string) {
  return env.Sandbox.getByName(id);
}

function resolveLifecycle(env: Env, id: string) {
  const lifecycleEnv = env as Env & {
    LifecycleCoordinator: DurableObjectNamespace<LifecycleCoordinator>;
  };
  return lifecycleEnv.LifecycleCoordinator.getByName(id);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new DeleteAttemptTimeoutError(message)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}
