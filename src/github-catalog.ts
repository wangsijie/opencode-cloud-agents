/**
 * The repository catalog, read from GitHub.
 *
 * The static list in [repos.ts](repos.ts) needed a deploy per repository. This
 * asks GitHub for the account's own repositories instead, so the composer
 * offers whatever the account can actually push to.
 *
 * It runs in the Worker rather than in a container: the catalog is needed to
 * *create* a session, which is exactly the moment no container exists yet.
 * That means the Worker needs its own credential rather than the `gh` login
 * baked into the image.
 *
 * Cloning still goes over SSH with the image's bundled key, so a repository
 * listed here is only usable if that key is authorized for it. The token
 * decides what is *offered*; the key decides what can be *cloned*.
 */
import { isSafeRepoDefinition, type RepoDefinition } from './repos.ts';

/**
 * The token the Hub lists repositories with.
 *
 * Committed like the rest of this private image's credentials (`docker/auth`,
 * `docker/ssh`) — the same trade, and the same warning: anyone who can read the
 * repository can use it. A `GITHUB_TOKEN` secret overrides it when one is set,
 * which is the path this should move to.
 *
 * It is only ever used for `GET /user/repos`. Nothing here writes to GitHub;
 * pushing and opening pull requests happen inside a container with the image's
 * own `gh` login.
 */
export const BUNDLED_GITHUB_TOKEN =
  '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';

/** How long a fetched catalog is served before GitHub is asked again. */
export const REPO_CATALOG_TTL_MS = 10 * 60 * 1000;

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_PAGES = 5;

interface GithubRepo {
  name?: unknown;
  full_name?: unknown;
  ssh_url?: unknown;
  default_branch?: unknown;
  archived?: unknown;
  disabled?: unknown;
  permissions?: { push?: unknown };
}

/**
 * Turn a GitHub API page into catalog entries.
 *
 * The repository key becomes a directory name under `/workspace`, so it comes
 * from the repository's own name, lowercased and stripped of anything that is
 * not safe in a path. Two repositories can share a name across owners, so a
 * collision falls back to `owner-name`, and anything still colliding — or still
 * unsafe — is dropped rather than silently pointed at another checkout.
 *
 * Archived and read-only repositories are left out: a session that cannot push
 * its work is a session that cannot finish.
 */
export function repoDefinitionsFromGithub(
  payload: unknown,
  existing: readonly RepoDefinition[] = []
): RepoDefinition[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const taken = new Set(existing.map((repo) => repo.repoKey));
  const repos: RepoDefinition[] = [];
  for (const value of payload as GithubRepo[]) {
    if (
      typeof value !== 'object' ||
      value === null ||
      value.archived === true ||
      value.disabled === true ||
      value.permissions?.push !== true
    ) {
      continue;
    }
    const fullName = typeof value.full_name === 'string' ? value.full_name : '';
    const name = typeof value.name === 'string' ? value.name : '';
    const owner = fullName.split('/')[0] ?? '';
    const candidate = normalizeRepoKey(name);
    const key = !candidate || taken.has(candidate)
      ? normalizeRepoKey(`${owner}-${name}`)
      : candidate;
    if (!key || taken.has(key)) {
      continue;
    }
    const repo = {
      repoKey: key,
      displayName: fullName || name,
      cloneUrl: typeof value.ssh_url === 'string' ? value.ssh_url : '',
      defaultBranch:
        typeof value.default_branch === 'string' ? value.default_branch : ''
    };
    if (!isSafeRepoDefinition(repo)) {
      continue;
    }
    taken.add(key);
    repos.push(repo);
  }
  return repos;
}

/** Lowercase, collapse anything unsafe, and trim to what a path may hold. */
export function normalizeRepoKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '');
}

/**
 * Read every repository the token can push to, newest activity first.
 *
 * Pagination is bounded: an account with thousands of repositories would make
 * the composer unusable long before the catalog ran out, so the first few pages
 * — the most recently pushed — are what gets offered.
 */
export async function fetchGithubRepoCatalog(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<RepoDefinition[]> {
  const repos: RepoDefinition[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL('/user/repos', GITHUB_API);
    url.searchParams.set('per_page', String(PER_PAGE));
    url.searchParams.set('sort', 'pushed');
    url.searchParams.set('affiliation', 'owner,collaborator,organization_member');
    url.searchParams.set('page', String(page));

    const response = await fetchImpl(url.toString(), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'opencode-cloud-hub',
        'x-github-api-version': '2022-11-28'
      }
    });
    if (!response.ok) {
      throw new Error(
        `GitHub repository listing failed (${response.status})`
      );
    }
    const payload: unknown = await response.json();
    const batch = repoDefinitionsFromGithub(payload, repos);
    repos.push(...batch);
    if (!Array.isArray(payload) || payload.length < PER_PAGE) {
      break;
    }
  }
  return repos;
}
