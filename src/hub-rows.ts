/**
 * Row projections for the D1 session registry.
 *
 * A session and its instance share one `sessions` row (they are 1:1 by
 * design), and these functions turn that row into the two record shapes the
 * rest of the code speaks. They live apart from [hub-store.ts](hub-store.ts)
 * because they are pure: the store pulls in Durable Object stubs the moment it
 * is imported, and these are what the unit tests need to reach.
 */
import type { InstanceLifecycle, InstanceRecord } from './instances.ts';
import { isSafeRepoDefinition, type RepoDefinition } from './repos.ts';
import type {
  SessionPhase,
  SessionRecord,
  SessionStatePatch
} from './sessions.ts';

/** One `sessions` row, as D1 returns it. */
export interface SessionRow {
  id: string;
  name: string;
  repo_key: string;
  repo_json: string | null;
  lifecycle: string;
  lifecycle_error: string | null;
  delete_operation_id: string | null;
  directory: string | null;
  model: string;
  variant: string | null;
  title: string;
  title_locked: number;
  opencode_session_id: string | null;
  phase: string;
  pending_prompt_count: number;
  last_error: string | null;
  last_prompt_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToInstance(row: SessionRow): InstanceRecord {
  const repo = parseRepoJson(row.repo_json);
  return {
    id: row.id,
    name: row.name,
    repoKey: row.repo_key,
    ...(repo ? { repo } : {}),
    lifecycle: row.lifecycle as InstanceLifecycle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.lifecycle_error === null ? {} : { lastError: row.lifecycle_error }),
    ...(row.delete_operation_id === null
      ? {}
      : { deleteOperationId: row.delete_operation_id })
  };
}

export function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    instanceId: row.id,
    repoKey: row.repo_key,
    ...(row.directory === null ? {} : { directory: row.directory }),
    model: row.model,
    ...(row.variant === null ? {} : { variant: row.variant }),
    title: row.title,
    ...(row.opencode_session_id === null
      ? {}
      : { opencodeSessionId: row.opencode_session_id }),
    phase: row.phase as SessionPhase,
    pendingPromptCount: row.pending_prompt_count,
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
    ...(row.last_prompt_at === null ? {} : { lastPromptAt: row.last_prompt_at }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    ...(row.title_locked ? { titleLocked: true } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
 * The bind parameters for the `updateSession` statement, derived from a patch.
 *
 * `variant` and `lastError` are tri-state — absent keeps the column, `null`
 * clears it, a value sets it — which SQL cannot read off one parameter, so
 * each travels as a mode plus a value. The other fields keep their column when
 * the patch omits them (or, matching the old registry, when they are falsy;
 * `pendingPromptCount` alone distinguishes 0 from absent).
 */
export function sessionPatchBindings(
  patch: SessionStatePatch
): (string | number | null)[] {
  const variantMode =
    patch.variant === null ? 'clear' : patch.variant !== undefined ? 'set' : 'keep';
  const errorMode =
    patch.lastError === null
      ? 'clear'
      : patch.lastError !== undefined
        ? 'set'
        : 'keep';
  return [
    patch.phase ?? null,
    patch.model || null,
    patch.title || null,
    patch.opencodeSessionId || null,
    patch.pendingPromptCount ?? null,
    patch.lastPromptAt || null,
    variantMode,
    patch.variant ?? null,
    errorMode,
    patch.lastError ?? null
  ];
}
