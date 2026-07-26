import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import type { InstanceRecord } from './instances';
import type { LifecycleCoordinator } from './lifecycle';
import { isModelRef } from './opencode-config';
import {
  isSafeRepoDefinition,
  repoWorkspaceDirectory,
  type RepoDefinition
} from './repos';
import {
  BUNDLED_GITHUB_TOKEN,
  REPO_CATALOG_TTL_MS,
  fetchGithubRepoCatalog
} from './github-catalog';
import type { SessionRecord, SessionStatePatch } from './sessions';

const SCHEMA_VERSION_KEY = 'hub:schema-version';
const SCHEMA_VERSION = 3;
const INSTANCE_KEY_PREFIX = 'instance:';
const SESSION_KEY_PREFIX = 'session:';
const REPO_CATALOG_KEY = 'hub:repo-catalog';
const DELETE_ATTEMPT_TIMEOUT_MS = 12 * 60 * 1000;

interface CachedRepoCatalog {
  fetchedAt: string;
  repos: RepoDefinition[];
}

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

  /**
   * The repositories a new session may choose from.
   *
   * GitHub is the only source. Cached in the Hub rather than fetched per
   * request: the composer asks on every page load and GitHub's answer does not
   * change between two of them, so this costs two API calls per `TTL` no matter
   * how many people are looking.
   *
   * A failed refresh serves the last good answer, because a GitHub outage
   * should not stop somebody starting a session on a repository that has been
   * there all along. With nothing cached it raises: an empty picker that looks
   * like "you have no repositories" would be worse than an error saying the
   * listing failed.
   *
   * `force` skips the cache — the composer's refresh, for a repository created
   * a minute ago.
   */
  async listRepoCatalog(force = false): Promise<RepoDefinition[]> {
    await this.initialized;
    const cached = await this.ctx.storage.get<CachedRepoCatalog>(
      REPO_CATALOG_KEY
    );
    if (
      !force &&
      cached &&
      Date.now() - Date.parse(cached.fetchedAt) < REPO_CATALOG_TTL_MS
    ) {
      return cached.repos;
    }
    // The secret is not declared in wrangler.jsonc, because it exists only
    // where somebody has set one; the bundled token is what this deployment
    // runs on until that happens.
    const token =
      (this.env as Env & { GITHUB_TOKEN?: string }).GITHUB_TOKEN ||
      BUNDLED_GITHUB_TOKEN;
    try {
      if (!token) {
        throw new Error('No GitHub token is configured');
      }
      const repos = await fetchGithubRepoCatalog(token);
      if (repos.length === 0) {
        throw new Error('GitHub returned no repositories this token can push to');
      }
      await this.ctx.storage.put(REPO_CATALOG_KEY, {
        fetchedAt: new Date().toISOString(),
        repos
      } satisfies CachedRepoCatalog);
      return repos;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cached) {
        console.warn('Serving a stale repository catalog', message);
        return cached.repos;
      }
      throw new Error(`Failed to read the repository catalog: ${message}`);
    }
  }

  /** Resolve a repository key against the catalog a session may be created from. */
  async findCatalogRepo(repoKey: string): Promise<RepoDefinition | undefined> {
    return (await this.listRepoCatalog()).find(
      (repo) => repo.repoKey === repoKey
    );
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

  /**
   * Instances exist only to run a session, so a repository is mandatory.
   *
   * The whole definition is stored, not just the key: the catalog is dynamic
   * now, and an instance whose clone URL had to be looked up again at wake time
   * would break the day a repository is renamed or leaves the account.
   */
  private async createInstance(repo: RepoDefinition): Promise<InstanceRecord> {
    if (!isSafeRepoDefinition(repo)) {
      throw new Error('Unsafe repository definition');
    }
    const now = new Date().toISOString();
    const record: InstanceRecord = {
      id: `inst-${crypto.randomUUID()}`,
      name: randomInstanceName(),
      repoKey: repo.repoKey,
      repo,
      lifecycle: 'ready',
      createdAt: now,
      updatedAt: now
    };

    const sandbox = resolveSandbox(this.env, record.id);
    const lifecycle = resolveLifecycle(this.env, record.id);
    await sandbox.initializeInstance(record.id, record.repoKey, repo);
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
    repo: RepoDefinition;
    model: string;
    title: string;
  }): Promise<SessionRecord> {
    await this.initialized;
    if (!isSafeRepoDefinition(input.repo)) {
      throw new Error('Unknown repository');
    }
    if (!isModelRef(input.model)) {
      throw new Error(`Unknown model: ${String(input.model)}`);
    }

    const instance = await this.createInstance(input.repo);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: instance.id,
      instanceId: instance.id,
      repoKey: input.repo.repoKey,
      // Pinned with the instance, so nothing this session does later depends on
      // the catalog still containing the repository it started from.
      directory: repoWorkspaceDirectory(input.repo.repoKey),
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
        ...(patch.model ? { model: patch.model } : {}),
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

  /**
   * Archive or restore a session.
   *
   * Archiving is a list-level decision and nothing more: the container, the
   * history and the mirror are untouched, so an archived session can be read and
   * continued exactly as before. That is what makes it the safe alternative to
   * deleting, which destroys the workspace.
   */
  async setSessionArchived(
    id: string,
    archived: boolean
  ): Promise<SessionRecord | undefined> {
    await this.initialized;
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<SessionRecord>(sessionStorageKey(id));
      if (!record) {
        return undefined;
      }
      if (Boolean(record.archivedAt) === archived) {
        return record;
      }
      const updated: SessionRecord = {
        ...record,
        updatedAt: new Date().toISOString()
      };
      if (archived) {
        updated.archivedAt = updated.updatedAt;
      } else {
        delete updated.archivedAt;
      }
      await transaction.put(sessionStorageKey(id), updated);
      return updated;
    });
  }

  /**
   * Name a session by hand.
   *
   * This also stops the automatic title from applying: a session OpenCode would
   * have called something else keeps the name it was given.
   */
  async renameSession(
    id: string,
    title: string
  ): Promise<SessionRecord | undefined> {
    await this.initialized;
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<SessionRecord>(sessionStorageKey(id));
      if (!record) {
        return undefined;
      }
      const updated: SessionRecord = {
        ...record,
        title,
        titleLocked: true,
        updatedAt: new Date().toISOString()
      };
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
