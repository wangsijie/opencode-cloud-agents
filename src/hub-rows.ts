/**
 * Row projections for the D1 session registry.
 *
 * A session and its instance share one `sessions` row (they are 1:1 by
 * design), and these functions turn that row into the two record shapes the
 * rest of the code speaks. They live apart from [hub-store.ts](hub-store.ts)
 * because they are pure: the store pulls in Durable Object stubs the moment it
 * is imported, and these are what the unit tests need to reach.
 */
import type { SessionProvider } from '../protocol/types.ts';
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
 * One `sessions` row, as D1 returns it.
 *
 * `repo_key` is `NOT NULL` and empty for a session created without a
 * repository; the record shapes leave `repoKey` out entirely in that case, so
 * "no repository" is one absent field everywhere above this projection rather
 * than an empty string nobody remembers to check.
 */
export interface SessionRow {
  id: string;
  name: string;
  repo_key: string;
  repo_json: string | null;
  provider: string;
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
  cleaned_at: string | null;
  unread_at: string | null;
  pinned_at: string | null;
  workspace_origin: string | null;
  boot_step: string | null;
  runtime_lifecycle: string | null;
  container: string | null;
  status_query: number;
  status_observed_at: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToInstance(row: SessionRow): InstanceRecord {
  const repo = parseRepoJson(row.repo_json);
  return {
    id: row.id,
    name: row.name,
    ...(row.repo_key ? { repoKey: row.repo_key } : {}),
    ...(repo ? { repo } : {}),
    provider: row.provider as SessionProvider,
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
    ...(row.repo_key ? { repoKey: row.repo_key } : {}),
    ...(row.directory === null ? {} : { directory: row.directory }),
    provider: row.provider as SessionProvider,
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
    ...(row.cleaned_at === null ? {} : { cleanedAt: row.cleaned_at }),
    ...(row.unread_at === null ? {} : { unreadAt: row.unread_at }),
    ...(row.pinned_at === null ? {} : { pinnedAt: row.pinned_at }),
    ...(row.title_locked ? { titleLocked: true } : {}),
    ...(row.workspace_origin === null
      ? {}
      : { workspaceOrigin: row.workspace_origin as WorkspaceOrigin }),
    ...(row.boot_step === null ? {} : { bootStep: row.boot_step as BootStep }),
    ...(row.runtime_lifecycle === null
      ? {}
      : { runtimeLifecycle: row.runtime_lifecycle as RuntimeLifecycle }),
    ...(row.container === null
      ? {}
      : { container: row.container as CachedContainerStatus }),
    statusQuery: row.status_query !== 0,
    ...(row.status_observed_at === null
      ? {}
      : { statusObservedAt: row.status_observed_at }),
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
