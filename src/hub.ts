import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import type { InstanceRecord } from './instances';
import type { LifecycleCoordinator } from './lifecycle';
import { isModelRef } from './opencode-config';
import { isRepoKey } from './repos';
import type { SessionRecord, SessionStatePatch } from './sessions';

const SCHEMA_VERSION_KEY = 'hub:schema-version';
const SCHEMA_VERSION = 3;
const INSTANCE_KEY_PREFIX = 'instance:';
const SESSION_KEY_PREFIX = 'session:';
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
        await ctx.storage.put(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
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

  /** Instances exist only to run a session, so a repository is mandatory. */
  private async createInstance(repoKey: string): Promise<InstanceRecord> {
    if (!isRepoKey(repoKey)) {
      throw new Error(`Unknown repository: ${String(repoKey)}`);
    }
    const now = new Date().toISOString();
    const record: InstanceRecord = {
      id: `inst-${crypto.randomUUID()}`,
      name: randomInstanceName(),
      repoKey,
      lifecycle: 'ready',
      createdAt: now,
      updatedAt: now
    };

    const sandbox = resolveSandbox(this.env, record.id);
    const lifecycle = resolveLifecycle(this.env, record.id);
    await sandbox.initializeInstance(record.id, record.repoKey);
    try {
      await lifecycle.initializeInstance({ instanceId: record.id });
      await this.ctx.storage.put(instanceStorageKey(record.id), record);
    } catch (error) {
      await sandbox.purgeInstance().catch(() => undefined);
      await lifecycle.markDeleted().catch(() => undefined);
      throw error;
    }
    return record;
  }

  async listSessions(): Promise<SessionRecord[]> {
    await this.initialized;
    const stored = await this.ctx.storage.list<SessionRecord>({
      prefix: SESSION_KEY_PREFIX
    });
    return [...stored.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
    );
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    await this.initialized;
    return this.ctx.storage.get<SessionRecord>(sessionStorageKey(id));
  }

  /**
   * Create a session and the instance that runs it in one step. The session id
   * is the instance id: one session always owns exactly one container.
   *
   * The record starts with the opening prompt already counted as pending; the
   * caller then hands it to the session's SessionAgent for dispatch.
   */
  async createSession(input: {
    repoKey: string;
    model: string;
    title: string;
  }): Promise<SessionRecord> {
    await this.initialized;
    if (!isRepoKey(input.repoKey)) {
      throw new Error(`Unknown repository: ${String(input.repoKey)}`);
    }
    if (!isModelRef(input.model)) {
      throw new Error(`Unknown model: ${String(input.model)}`);
    }

    const instance = await this.createInstance(input.repoKey);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: instance.id,
      instanceId: instance.id,
      repoKey: input.repoKey,
      model: input.model,
      title: input.title,
      phase: 'queued',
      pendingPromptCount: 1,
      createdAt: now,
      updatedAt: now
    };
    await this.ctx.storage.put(sessionStorageKey(record.id), record);
    return record;
  }

  /** Mirror of the SessionAgent's dispatch state; the agent stays canonical. */
  async updateSession(
    id: string,
    patch: SessionStatePatch
  ): Promise<SessionRecord | undefined> {
    await this.initialized;
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<SessionRecord>(
        sessionStorageKey(id)
      );
      if (!record) {
        return undefined;
      }
      const updated: SessionRecord = {
        ...record,
        ...(patch.phase ? { phase: patch.phase } : {}),
        ...(patch.opencodeSessionId
          ? { opencodeSessionId: patch.opencodeSessionId }
          : {}),
        ...(patch.pendingPromptCount !== undefined
          ? { pendingPromptCount: patch.pendingPromptCount }
          : {}),
        ...(patch.lastPromptAt ? { lastPromptAt: patch.lastPromptAt } : {}),
        updatedAt: new Date().toISOString()
      };
      if (patch.lastError === null) {
        delete updated.lastError;
      } else if (patch.lastError !== undefined) {
        updated.lastError = patch.lastError;
      }
      await transaction.put(sessionStorageKey(id), updated);
      return updated;
    });
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
      // A session and its instance share one id and are deleted together.
      await transaction.delete(sessionStorageKey(id));
    });
  }
}

function instanceStorageKey(id: string): string {
  return `${INSTANCE_KEY_PREFIX}${id}`;
}

function sessionStorageKey(id: string): string {
  return `${SESSION_KEY_PREFIX}${id}`;
}

function isPendingDeletion(record: InstanceRecord): boolean {
  return record.lifecycle === 'deleting' && Boolean(record.deleteOperationId);
}

function resolveSandbox(env: Env, id: string) {
  return getSandbox(env.Sandbox, id, {
    normalizeId: true,
    keepAlive: true
  });
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
