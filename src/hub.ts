import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import {
  CURRENT_IMAGE_KEY,
  LEGACY_INSTANCE_ID,
  LOGTO_IMAGE_KEY,
  isImageKey,
  type ImageKey,
  type InstanceRecord
} from './instances';
import type { LifecycleCoordinator } from './lifecycle';

const INITIALIZED_KEY = 'hub:initialized';
const SCHEMA_VERSION_KEY = 'hub:schema-version';
const SCHEMA_VERSION = 2;
const INSTANCE_KEY_PREFIX = 'instance:';
const DELETE_ATTEMPT_TIMEOUT_MS = 12 * 60 * 1000;

class DeleteAttemptTimeoutError extends Error {}

const ADJECTIVES = [
  'amber',
  'bright',
  'calm',
  'cobalt',
  'coral',
  'gentle',
  'golden',
  'lucky',
  'lunar',
  'mint',
  'quiet',
  'rapid',
  'silver',
  'solar',
  'swift',
  'violet'
] as const;

const NOUNS = [
  'badger',
  'cedar',
  'comet',
  'falcon',
  'fjord',
  'fox',
  'heron',
  'lynx',
  'maple',
  'otter',
  'panda',
  'pine',
  'raven',
  'reef',
  'sparrow',
  'wolf'
] as const;

/**
 * The Hub Durable Object is the strongly-consistent registry for logical
 * OpenCode instances. Container and backup lifecycle work stays in each
 * instance's Sandbox Durable Object.
 */
export class Hub extends DurableObject<Env> {
  private readonly initialized: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.get<number>(SCHEMA_VERSION_KEY)) !== SCHEMA_VERSION) {
        const registryExists = Boolean(
          await ctx.storage.get<boolean>(INITIALIZED_KEY)
        );
        const existingLegacy = await ctx.storage.get<InstanceRecord>(
          instanceStorageKey(LEGACY_INSTANCE_ID)
        );

        if (!registryExists || existingLegacy) {
          // Preserve the pre-Hub deployment's fixed "opencode" Durable Object
          // and its R2 backup. This identity RPC does not start its container.
          const now = new Date().toISOString();
          const legacy: InstanceRecord = existingLegacy
            ? {
                ...existingLegacy,
                imageKey: CURRENT_IMAGE_KEY,
                updatedAt: now
              }
            : {
                id: LEGACY_INSTANCE_ID,
                name: 'original-opencode',
                imageKey: CURRENT_IMAGE_KEY,
                lifecycle: 'ready',
                createdAt: now,
                updatedAt: now
              };
          const sandbox = resolveSandbox(env, legacy.id, legacy.imageKey);
          await sandbox.initializeInstance(legacy.id, legacy.imageKey);
          await ctx.storage.put(instanceStorageKey(legacy.id), legacy);
        }

        await ctx.storage.put({
          [INITIALIZED_KEY]: true,
          [SCHEMA_VERSION_KEY]: SCHEMA_VERSION
        });
      }

      const [records, alarm] = await Promise.all([
        ctx.storage.list<InstanceRecord>({ prefix: INSTANCE_KEY_PREFIX }),
        ctx.storage.getAlarm()
      ]);
      if ([...records.values()].some(isPendingDeletion) && alarm === null) {
        await ctx.storage.setAlarm(Date.now());
      }
    });
  }

  async listInstances(): Promise<InstanceRecord[]> {
    await this.initialized;
    const stored = await this.ctx.storage.list<InstanceRecord>({
      prefix: INSTANCE_KEY_PREFIX
    });

    return [...stored.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  async getInstance(id: string): Promise<InstanceRecord | undefined> {
    await this.initialized;
    return this.ctx.storage.get<InstanceRecord>(instanceStorageKey(id));
  }

  async createInstance(
    imageKey: ImageKey = CURRENT_IMAGE_KEY
  ): Promise<InstanceRecord> {
    await this.initialized;
    if (!isImageKey(imageKey)) {
      throw new Error(`Unsupported image: ${String(imageKey)}`);
    }
    const now = new Date().toISOString();
    const record: InstanceRecord = {
      id: `inst-${crypto.randomUUID()}`,
      name: randomInstanceName(),
      imageKey,
      lifecycle: 'ready',
      createdAt: now,
      updatedAt: now
    };

    const sandbox = resolveSandbox(this.env, record.id, record.imageKey);
    const lifecycle = resolveLifecycle(this.env, record.id);
    await sandbox.initializeInstance(record.id, record.imageKey);
    try {
      await lifecycle.initializeInstance({
        instanceId: record.id,
        imageKey: record.imageKey
      });
      await this.ctx.storage.put(instanceStorageKey(record.id), record);
    } catch (error) {
      await sandbox.purgeInstance().catch(() => undefined);
      await lifecycle.markDeleted().catch(() => undefined);
      throw error;
    }
    return record;
  }

  async beginDelete(id: string): Promise<InstanceRecord | undefined> {
    await this.initialized;
    const deleting = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<InstanceRecord>(
        instanceStorageKey(id)
      );
      if (!record) {
        return undefined;
      }

      if (record.lifecycle === 'deleting' && record.deleteOperationId) {
        await transaction.setAlarm(Date.now());
        return record;
      }

      const deleting: InstanceRecord = {
        ...record,
        lifecycle: 'deleting',
        deleteOperationId: crypto.randomUUID(),
        updatedAt: new Date().toISOString()
      };
      delete deleting.lastError;
      await transaction.put(instanceStorageKey(id), deleting);
      await transaction.setAlarm(Date.now());
      return deleting;
    });
    if (deleting) {
      await resolveLifecycle(this.env, deleting.id).beginDelete();
    }
    return deleting;
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    const records = await this.listInstances();
    const record = records
      .filter(isPendingDeletion)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
    if (record) {
      const operationId = record.deleteOperationId!;
      try {
        const sandbox = resolveSandbox(this.env, record.id, record.imageKey);
        const lifecycle = resolveLifecycle(this.env, record.id);
        await lifecycle.beginDelete();
        const purgeResult = await withTimeout(
          sandbox.purgeInstance(),
          DELETE_ATTEMPT_TIMEOUT_MS,
          `Timed out deleting instance ${record.id}`
        );
        if (purgeResult.outcome === 'termination_pending') {
          console.warn(`Container termination pending for ${record.id}`);
          await this.deferDelete(
            record.id,
            operationId,
            'Container termination is still pending'
          );
        } else {
          await lifecycle.markDeleted();
          await this.finishDelete(record.id, operationId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DeleteAttemptTimeoutError) {
          console.warn(`Delete attempt timed out for ${record.id}`);
          await this.deferDelete(record.id, operationId, message);
        } else {
          console.error(`Failed to delete instance ${record.id}`, error);
          await this.markDeleteFailed(record.id, operationId, message);
        }
      }
    }

    const remaining = await this.listInstances();
    if (remaining.some(isPendingDeletion)) {
      await this.ctx.storage.setAlarm(Date.now());
    }
  }

  async markDeleteFailed(
    id: string,
    operationId: string,
    error: string
  ): Promise<void> {
    await this.initialized;
    await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<InstanceRecord>(
        instanceStorageKey(id)
      );
      if (!record || record.deleteOperationId !== operationId) {
        return;
      }

      await transaction.put(instanceStorageKey(id), {
        ...record,
        lifecycle: 'delete_failed',
        updatedAt: new Date().toISOString(),
        lastError: error
      } satisfies InstanceRecord);
    });
  }

  async deferDelete(
    id: string,
    operationId: string,
    message: string
  ): Promise<void> {
    await this.initialized;
    await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<InstanceRecord>(
        instanceStorageKey(id)
      );
      if (!record || record.deleteOperationId !== operationId) {
        return;
      }
      await transaction.put(instanceStorageKey(id), {
        ...record,
        updatedAt: new Date().toISOString(),
        lastError: `${message}; retry scheduled`
      } satisfies InstanceRecord);
    });
  }

  async finishDelete(id: string, operationId: string): Promise<void> {
    await this.initialized;
    await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<InstanceRecord>(
        instanceStorageKey(id)
      );
      if (!record || record.deleteOperationId !== operationId) {
        return;
      }
      await transaction.delete(instanceStorageKey(id));
    });
  }
}

function instanceStorageKey(id: string): string {
  return `${INSTANCE_KEY_PREFIX}${id}`;
}

function isPendingDeletion(record: InstanceRecord): boolean {
  return record.lifecycle === 'deleting' && Boolean(record.deleteOperationId);
}

function resolveSandbox(env: Env, id: string, imageKey: ImageKey) {
  switch (imageKey) {
    case CURRENT_IMAGE_KEY:
      return getSandbox(env.Sandbox, id, {
        normalizeId: true,
        keepAlive: true
      });
    case LOGTO_IMAGE_KEY:
      return getSandbox(env.LogtoSandbox, id, {
        normalizeId: true,
        keepAlive: true
      });
    default:
      throw new Error(`Unsupported image: ${String(imageKey)}`);
  }
}

function resolveLifecycle(env: Env, id: string) {
  const lifecycleEnv = env as Env & {
    LifecycleCoordinator: DurableObjectNamespace<LifecycleCoordinator>;
  };
  return lifecycleEnv.LifecycleCoordinator.getByName(id);
}

function randomInstanceName(): string {
  const adjective = ADJECTIVES[randomIndex(ADJECTIVES.length)];
  const noun = NOUNS[randomIndex(NOUNS.length)];
  const suffix = randomIndex(36 ** 4).toString(36).padStart(4, '0');
  return `${adjective}-${noun}-${suffix}`;
}

function randomIndex(length: number): number {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % length;
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
