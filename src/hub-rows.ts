/**
 * Row projections for the D1 session registry.
 *
 * A session and its instance share one `sessions` row (they are 1:1 by
 * design), and these functions turn that row into the two record shapes the
 * rest of the code speaks. They live apart from [hub-store.ts](hub-store.ts)
 * because they are pure: the store pulls in Durable Object stubs the moment it
 * is imported, and these are what the unit tests need to reach.
 */
import { sql } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import type { SessionProvider } from '../protocol/types.ts';
import { sessions } from './db/schema.ts';
import type {
  InstanceLifecycle,
  InstanceRecord,
  RuntimeLifecycle
} from './instances.ts';
import { isSafeRepoDefinition, type RepoDefinition } from './repos.ts';
import type {
  BootStep,
  CachedContainerStatus,
  SessionPhase,
  SessionRecord,
  SessionStatePatch,
  WorkspaceOrigin
} from './sessions.ts';

/**
 * One `sessions` row, as Drizzle selects it.
 *
 * Inferred from the table rather than written out, so a column added to the
 * schema reaches these projections as a type error rather than as a field that
 * silently never appears. The property names are the schema's camelCase ones;
 * the database columns they map to are still snake_case.
 *
 * `repoKey` is `NOT NULL` and empty for a session created without a
 * repository; the record shapes leave `repoKey` out entirely in that case, so
 * "no repository" is one absent field everywhere above this projection rather
 * than an empty string nobody remembers to check.
 */
export type SessionRow = typeof sessions.$inferSelect;

export function rowToInstance(row: SessionRow): InstanceRecord {
  const repo = parseRepoJson(row.repoJson);
  return {
    id: row.id,
    name: row.name,
    ...(row.repoKey ? { repoKey: row.repoKey } : {}),
    ...(repo ? { repo } : {}),
    provider: row.provider as SessionProvider,
    lifecycle: row.lifecycle as InstanceLifecycle,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.lifecycleError === null ? {} : { lastError: row.lifecycleError }),
    ...(row.deleteOperationId === null
      ? {}
      : { deleteOperationId: row.deleteOperationId })
  };
}

export function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    instanceId: row.id,
    ...(row.repoKey ? { repoKey: row.repoKey } : {}),
    ...(row.directory === null ? {} : { directory: row.directory }),
    provider: row.provider as SessionProvider,
    model: row.model,
    ...(row.variant === null ? {} : { variant: row.variant }),
    title: row.title,
    ...(row.opencodeSessionId === null
      ? {}
      : { opencodeSessionId: row.opencodeSessionId }),
    phase: row.phase as SessionPhase,
    pendingPromptCount: row.pendingPromptCount,
    ...(row.lastError === null ? {} : { lastError: row.lastError }),
    ...(row.lastPromptAt === null ? {} : { lastPromptAt: row.lastPromptAt }),
    ...(row.cleanedAt === null ? {} : { cleanedAt: row.cleanedAt }),
    ...(row.unreadAt === null ? {} : { unreadAt: row.unreadAt }),
    ...(row.pinnedAt === null ? {} : { pinnedAt: row.pinnedAt }),
    ...(row.titleLocked ? { titleLocked: true } : {}),
    ...(row.workspaceOrigin === null
      ? {}
      : { workspaceOrigin: row.workspaceOrigin as WorkspaceOrigin }),
    ...(row.bootStep === null ? {} : { bootStep: row.bootStep as BootStep }),
    ...(row.runtimeLifecycle === null
      ? {}
      : { runtimeLifecycle: row.runtimeLifecycle as RuntimeLifecycle }),
    ...(row.container === null
      ? {}
      : { container: row.container as CachedContainerStatus }),
    statusQuery: row.statusQuery !== 0,
    ...(row.statusObservedAt === null
      ? {}
      : { statusObservedAt: row.statusObservedAt }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function parseRepoJson(
  value: string | null
): RepoDefinition | undefined {
  if (value === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isSafeRepoDefinition(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The column assignments for `updateSession`, derived from a patch.
 *
 * The statement this replaced carried every field as a bind parameter and let
 * SQL decide what to do with it: `COALESCE(?, column)` to keep an absent one,
 * and — because a single parameter cannot say the difference between "leave
 * this alone" and "set it to NULL" — a mode string beside the value for the two
 * tri-state fields. Building the assignment list in TypeScript says all of that
 * directly, so a patch now writes only the columns it actually names.
 *
 * The semantics are unchanged and deliberate:
 *
 * - `variant` and `lastError` are tri-state — absent keeps the column, `null`
 *   clears it, a value sets it.
 * - The other fields keep their column when the patch omits them, or (matching
 *   the registry this replaced) when they are falsy. `pendingPromptCount` is
 *   the exception that distinguishes 0 from absent, because a session with no
 *   prompts left is a real state.
 * - `title` only lands while `title_locked` is unset, which has to stay a
 *   per-row decision in SQL: a name a human chose outranks the automatic one,
 *   and the lock may have been taken between the read and this write.
 */
export function sessionPatchAssignments(
  patch: SessionStatePatch,
  updatedAt: string
): SQLiteUpdateSetSource<typeof sessions> {
  return {
    ...(patch.phase ? { phase: patch.phase } : {}),
    ...(patch.model ? { model: patch.model } : {}),
    ...(patch.title
      ? {
          title: sql`CASE WHEN ${sessions.titleLocked} = 0
                          THEN ${patch.title} ELSE ${sessions.title} END`
        }
      : {}),
    ...(patch.opencodeSessionId
      ? { opencodeSessionId: patch.opencodeSessionId }
      : {}),
    ...(patch.pendingPromptCount === undefined
      ? {}
      : { pendingPromptCount: patch.pendingPromptCount }),
    ...(patch.lastPromptAt ? { lastPromptAt: patch.lastPromptAt } : {}),
    ...(patch.variant === undefined ? {} : { variant: patch.variant }),
    ...(patch.lastError === undefined ? {} : { lastError: patch.lastError }),
    updatedAt
  };
}
