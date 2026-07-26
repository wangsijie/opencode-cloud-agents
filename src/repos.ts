/**
 * Repository catalog for runtime workspace provisioning.
 *
 * An instance created with a `repoKey` uses the base image and provisions the
 * repository at wake time instead of baking it into a template image: the
 * first wake clones into `/workspace/<repoKey>`; later wakes restore the
 * workspace snapshot and run a best-effort `git fetch`.
 *
 * Adding a repository is a one-line change here followed by a deploy. Public
 * repositories should use HTTPS clone URLs; private repositories use SSH and
 * require the bundled image key (`docker/ssh/id_ed25519.pub`) to be authorized
 * for them on GitHub.
 */
export interface RepoDefinition {
  /** Directory name below /workspace and the stable API identifier. */
  repoKey: string;
  /** Label shown in the creation dialog. */
  displayName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export const REPOS: readonly RepoDefinition[] = [
  {
    repoKey: 'logto',
    displayName: 'logto-io/logto',
    cloneUrl: 'https://github.com/logto-io/logto.git',
    defaultBranch: 'master'
  }
  // Private repository example:
  // {
  //   repoKey: 'my-repo',
  //   displayName: 'wangsijie/my-repo',
  //   cloneUrl: 'git@github.com:wangsijie/my-repo.git',
  //   defaultBranch: 'main'
  // }
];

/** Root of the snapshotted container workspace shared by every instance. */
export const WORKSPACE_ROOT = '/workspace';

/** Absolute container path a repository is provisioned into. */
export function repoWorkspaceDirectory(repo: RepoDefinition): string {
  return `${WORKSPACE_ROOT}/${repo.repoKey}`;
}

export function findRepo(repoKey: string): RepoDefinition | undefined {
  return REPOS.find((repo) => repo.repoKey === repoKey);
}

export function isRepoKey(value: unknown): value is string {
  return (
    typeof value === 'string' && REPOS.some((repo) => repo.repoKey === value)
  );
}

/**
 * Catalog entries are interpolated into container shell commands and instance
 * URLs, so reject unsafe definitions at module load instead of at wake time.
 */
const SAFE_REPO_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_GIT_REF = /^[A-Za-z0-9._/-]{1,255}$/;
const SAFE_CLONE_URL = /^(?:https:\/\/|git@)[A-Za-z0-9._/:@-]+$/;

for (const repo of REPOS) {
  if (!SAFE_REPO_KEY.test(repo.repoKey)) {
    throw new Error(`Unsafe repoKey in catalog: ${repo.repoKey}`);
  }
  if (!SAFE_GIT_REF.test(repo.defaultBranch)) {
    throw new Error(`Unsafe defaultBranch for ${repo.repoKey}`);
  }
  if (!SAFE_CLONE_URL.test(repo.cloneUrl)) {
    throw new Error(`Unsafe cloneUrl for ${repo.repoKey}`);
  }
}
if (new Set(REPOS.map((repo) => repo.repoKey)).size !== REPOS.length) {
  throw new Error('Duplicate repoKey in catalog');
}
