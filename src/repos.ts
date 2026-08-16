/**
 * What a repository is, and where it lives inside a container.
 *
 * The catalog itself is no longer here: it comes from GitHub (see
 * [github-catalog.ts](github-catalog.ts)), so this module is only the shape of
 * an entry, the rules that make one safe to interpolate into a container shell
 * command, and the one path convention every checkout follows.
 *
 * An instance created with a repository provisions it at wake time rather than
 * baking it into an image: the first wake shallow-clones into
 * `/workspace/<repoKey>`; later wakes restore the workspace snapshot and run a
 * best-effort `git fetch`.
 *
 * The chosen entry is copied onto the session, instance and Sandbox records when
 * a session is created, so nothing an existing container does depends on the
 * catalog still listing it — or on the catalog being reachable at all.
 *
 * A session may also be created without a repository at all. Then there is no
 * entry to pin, nothing is cloned or fetched, and the session works directly in
 * `/workspace` — see `workspaceDirectory` below.
 */
export interface RepoDefinition {
  /** Directory name below /workspace and the stable API identifier. */
  repoKey: string;
  /** Label shown in the creation dialog. */
  displayName: string;
  cloneUrl: string;
  defaultBranch: string;
}

/** Root of the snapshotted container workspace shared by every instance. */
export const WORKSPACE_ROOT = '/workspace';

/**
 * The directory below /workspace that holds the session's files.
 *
 * A place to put things that are not the repository: what the user uploads for
 * the agent to work on, and what the agent produces that does not belong in a
 * commit. A sibling of the checkout rather than a directory inside it, which is
 * what keeps it out of `git status` by construction instead of by convention.
 *
 * It lives in the workspace, so it is exactly as durable as the session: the
 * snapshot carries it on a Cloudflare host and the volume carries it on a
 * Docker one, and a session that is lost loses it too. There is no mirror
 * outside the container, so a sleeping session cannot be browsed — the same
 * rule the workspace panel already follows.
 */
export const ARTIFACTS_DIRECTORY_NAME = 'artifacts';

/** Absolute container path of that directory. */
export const ARTIFACTS_ROOT = `${WORKSPACE_ROOT}/${ARTIFACTS_DIRECTORY_NAME}`;

/**
 * Absolute container path a session works in.
 *
 * Derived from the key alone, so an existing session can always locate its own
 * checkout without asking GitHub anything. A session created without a
 * repository has no checkout to locate: it works in the workspace root itself.
 */
export function workspaceDirectory(repoKey?: string): string {
  return repoKey ? `${WORKSPACE_ROOT}/${repoKey}` : WORKSPACE_ROOT;
}

/**
 * The owner segment of a clone URL — the GitHub organization or user — for
 * both https and scp-style ssh forms. Undefined when the URL has no
 * owner/repository tail, in which case identity overrides simply do not apply.
 */
export function repoOwnerFromCloneUrl(cloneUrl: string): string | undefined {
  const match = /^(?:https:\/\/[^/]+\/|git@[^:]+:)([^/]+)\/[^/]+$/.exec(
    cloneUrl.replace(/\.git$/, '').replace(/\/+$/, '')
  );
  return match?.[1];
}

/**
 * Repository keys become directory names and reach container shell commands, so
 * they are constrained rather than escaped.
 */
const SAFE_REPO_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]{1,255}$/;
const SAFE_CLONE_URL = /^(?:https:\/\/|git@)[A-Za-z0-9._/:@-]+$/;

/**
 * Names that are already something else below /workspace. A repository called
 * `artifacts` is a perfectly ordinary GitHub repository and an entirely
 * reasonable key, and cloning it would land on top of the session's artifacts
 * directory.
 */
const RESERVED_REPO_KEYS = new Set([ARTIFACTS_DIRECTORY_NAME]);

export function isSafeRepoKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_REPO_KEY.test(value) &&
    !value.includes('..') &&
    !RESERVED_REPO_KEYS.has(value)
  );
}

/**
 * Whether an entry is safe to store and act on.
 *
 * Applied to every entry that arrives from GitHub, where neither the names nor
 * the URLs are ours to trust.
 */
export function isSafeRepoDefinition(value: unknown): value is RepoDefinition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const repo = value as Partial<RepoDefinition>;
  return (
    isSafeRepoKey(repo.repoKey) &&
    typeof repo.displayName === 'string' &&
    repo.displayName.length > 0 &&
    repo.displayName.length <= 200 &&
    typeof repo.defaultBranch === 'string' &&
    SAFE_GIT_REF.test(repo.defaultBranch) &&
    typeof repo.cloneUrl === 'string' &&
    SAFE_CLONE_URL.test(repo.cloneUrl)
  );
}
