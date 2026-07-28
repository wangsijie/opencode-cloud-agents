/**
 * What the Hub does *inside* a container, expressed against the host protocol.
 *
 * Credential injection, repository provisioning, the working-tree diff and
 * publishing all used to be methods on the Sandbox Durable Object, calling the
 * sandbox SDK's `exec`/`writeFile` on itself. They are functions here instead,
 * taking the narrow {@link RuntimeHost} slice of
 * [host-client.ts](host-client.ts) — so they work against any host, and so a
 * unit test can hand them a stub instead of a container.
 *
 * The round trips are what changed with them. A remote host is a public HTTPS
 * hop rather than a local method call, so a wake writes every credential in one
 * `files/write-batch` and runs every git config in one `sh -lc` script, instead
 * of one call per file and one per command.
 *
 * [session-changes.ts](session-changes.ts) stays the pure half — quoting,
 * parsing, branch rules — and is imported rather than duplicated here.
 */
import type { ExecRequest, ExecResponse, HostFileWrite } from '../protocol/types.ts';
import {
  CONTAINER_AGENTS_MD_PATH,
  CONTAINER_SKILLS_ROOT,
  containerEnv,
  credentialFiles,
  gitConfigCommands,
  type ContainerCredentialSettings
} from './container-credentials.ts';
import { truncateOutput } from './http.ts';
import { repoOwnerFromCloneUrl, type RepoDefinition } from './repos.ts';
import {
  decodeGitStatusOutput,
  isSafeBranchName,
  limitDiff,
  normalizeCommitMessage,
  parseGitStatus,
  parsePullRequestUrl,
  resolvePublishBranch,
  shellQuote,
  type PublishSessionChangesInput,
  type PublishSessionChangesResult,
  type SessionChanges,
  type SessionChangesHead
} from './session-changes.ts';

/** A clone of a large repository over SSH is the slowest thing a wake does. */
export const REPO_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
export const REPO_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
export const GIT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
export const GH_COMMAND_TIMEOUT_MS = 60 * 1000;

/** The part of a host these operations use: run a command, write files, look. */
export interface RuntimeHost {
  exec(
    command: string,
    options?: Omit<ExecRequest, 'command'>
  ): Promise<ExecResponse>;
  writeBatch(files: HostFileWrite[]): Promise<{ written: number }>;
  exists(path: string): Promise<{ exists: boolean }>;
}

/** The checkout one instance works in, as the Sandbox knows it. */
export interface RuntimeCheckout {
  repo?: RepoDefinition;
  repoKey?: string;
  directory: string;
  sessionId: string;
}

/**
 * Write the operator's credentials and skills into the container.
 *
 * Runs on every wake, before anything reaches the repository over SSH.
 * Everything written lives under `/root`, which no snapshot covers, so the
 * container always reflects the settings table as of this wake — including
 * deletions, which is why the skills tree is removed wholesale first rather
 * than merged into.
 *
 * Three round trips regardless of how many skills are configured: the removal,
 * the batch (whose host creates parents and applies each `mode` — `writeFile`
 * promises nothing about permissions and OpenSSH refuses a private key others
 * could read), and the git configuration.
 *
 * Returns the operator's extra environment variables for the server start.
 */
export async function injectContainerCredentials(
  host: RuntimeHost,
  settings: ContainerCredentialSettings,
  checkout: { repoKey?: string; repo?: RepoDefinition }
): Promise<Record<string, string>> {
  await mustExec(
    host,
    `rm -rf ${shellQuote(CONTAINER_SKILLS_ROOT)} && rm -f ${shellQuote(
      CONTAINER_AGENTS_MD_PATH
    )}`
  );

  const files = credentialFiles(settings, checkout.repoKey);
  if (files.length > 0) {
    await host.writeBatch(
      files.map(
        (file): HostFileWrite => ({
          path: file.path,
          content: file.content,
          encoding: 'utf-8',
          mode: file.mode
        })
      )
    );
  }

  // The instance is bound to one repository, so the identity choice — a
  // per-organization override or the base one — is made here, not by git.
  const repoOwner = checkout.repo
    ? repoOwnerFromCloneUrl(checkout.repo.cloneUrl)
    : undefined;
  const commands = gitConfigCommands(settings, repoOwner);
  if (commands.length > 0) {
    await mustExec(host, commands.join(' && '));
  }
  return containerEnv(settings);
}

/**
 * Provision the instance's catalog repository below /workspace during wake.
 * The first wake clones; later wakes see the restored checkout and only run a
 * best-effort fetch, never touching the working tree.
 *
 * An instance created without a repository has nothing to provision: the
 * workspace root is where its session works, and it is already there.
 *
 * Returns the fetch when there was already a checkout, wrapped rather than
 * returned bare: an `async` function adopts a promise it returns, so handing it
 * back on its own would await it here and cost the caller exactly the overlap
 * this exists to buy. Nothing the OpenCode server needs depends on the refs it
 * updates, so the caller runs the two together.
 */
export async function provisionRepository(
  host: RuntimeHost,
  checkout: RuntimeCheckout
): Promise<{ fetching?: Promise<void> }> {
  const { repo, repoKey, directory, sessionId } = checkout;
  if (!repoKey) {
    return {};
  }
  const existing = await host.exists(`${directory}/.git`);
  if (existing.exists) {
    // A restored checkout knows its own remote, so resuming one needs nothing
    // from the catalog. That is what keeps an instance created before the
    // catalog was dynamic — or one whose repository has since left it —
    // working exactly as it did.
    //
    // A fetch failure (offline remote, revoked key) must not block resuming the
    // already-restored workspace — and neither must its latency, so this is
    // handed back unawaited.
    const fetching = host
      .exec(`git -C ${shellQuote(directory)} fetch origin --prune`, {
        timeoutMs: REPO_FETCH_TIMEOUT_MS
      })
      .then(
        (fetched) => {
          if (!fetched.success) {
            console.warn(
              `Repo fetch failed for ${repoKey}: ${truncateOutput(fetched.stderr)}`
            );
          }
        },
        (error) => {
          // A timed-out or refused fetch is a warning, not a failed wake: the
          // checkout it was refreshing is already restored and usable.
          console.warn(`Repo fetch failed for ${repoKey}`, error);
        }
      );
    return { fetching };
  }

  if (!repo) {
    throw new Error(
      `Instance ${sessionId} has no checkout and no pinned repository for ${repoKey}; wake refused`
    );
  }
  const cloned = await host.exec(
    `git clone --depth 1 --branch ${shellQuote(repo.defaultBranch)} ${shellQuote(
      repo.cloneUrl
    )} ${shellQuote(directory)}`,
    { timeoutMs: REPO_CLONE_TIMEOUT_MS }
  );
  if (!cloned.success) {
    throw new Error(
      `git clone failed for ${repoKey}: ${truncateOutput(cloned.stderr)}`
    );
  }
  return {};
}

/**
 * Read what the agent changed in the session's checkout.
 *
 * A git read and not an OpenCode one: the diff the user cares about is the
 * working tree, including edits an agent made through a shell rather than
 * through the edit tool. Untracked files are listed but not diffed — showing
 * their content would mean staging them, and a read must not move the index.
 */
export async function readSessionChanges(
  host: RuntimeHost,
  checkout: RuntimeCheckout & { repoKey: string }
): Promise<SessionChanges> {
  const { repo, repoKey, directory, sessionId } = checkout;
  const defaultBranch = await resolveDefaultBranch(host, directory, repo);
  const at = shellQuote(directory);
  const [branchOut, headOut, statusOut, diffOut, remoteOut] = await Promise.all([
    host.exec(`git -C ${at} rev-parse --abbrev-ref HEAD`),
    host.exec(`git -C ${at} log -1 --format='%H%x09%s'`),
    // Wrapped in base64 because the NUL separators do not reliably survive the
    // exec transport; the worker decodes before parsing.
    host.exec(`git -C ${at} status --porcelain=v1 -z | base64`),
    host.exec(`git -C ${at} diff HEAD --no-color`),
    host.exec(`git -C ${at} branch --remotes --list 'origin/*'`)
  ]);
  if (!branchOut.success) {
    throw new Error(`git rev-parse failed: ${truncateOutput(branchOut.stderr)}`);
  }
  if (!statusOut.success) {
    throw new Error(`git status failed: ${truncateOutput(statusOut.stderr)}`);
  }

  const branch = branchOut.stdout.trim();
  const remoteBranches = new Set(
    remoteOut.success
      ? remoteOut.stdout
          .split('\n')
          .map((line) => line.trim().replace(/^origin\//, ''))
          .filter(Boolean)
      : []
  );
  const publishBranch = resolvePublishBranch({
    sessionId,
    currentBranch: branch,
    defaultBranch
  });
  return {
    observedAt: new Date().toISOString(),
    repoKey,
    branch,
    defaultBranch,
    onDefaultBranch: branch === defaultBranch,
    ...(headOut.success && headOut.stdout.trim()
      ? { head: parseHeadLine(headOut.stdout) }
      : {}),
    files: parseGitStatus(decodeGitStatusOutput(statusOut.stdout)),
    // A diff that fails on a repository whose status read worked is an empty
    // diff as far as the user is concerned; the file list is the part that must
    // be right.
    ...limitDiff(diffOut.success ? diffOut.stdout : ''),
    unpushedCommits: await countUnpushedCommits(
      host,
      directory,
      branch,
      defaultBranch,
      remoteBranches.has(branch)
    ),
    publishBranch,
    ...(remoteBranches.has(publishBranch) ? { remoteBranch: publishBranch } : {})
  };
}

/**
 * Commit the working tree onto the session branch, push it, and optionally open
 * a pull request.
 *
 * Every step is sequential and stops at the first failure, so a push that
 * cannot reach the remote leaves a real commit behind rather than an unclear
 * half-state — the commit is in the workspace snapshot and the next publish
 * pushes it. That is also why this is not batched into one script: which step
 * failed is the whole of the error message.
 */
export async function publishSessionChanges(
  host: RuntimeHost,
  checkout: RuntimeCheckout & { repoKey: string },
  input: PublishSessionChangesInput
): Promise<PublishSessionChangesResult> {
  const message = normalizeCommitMessage(input.message);
  if (!message) {
    throw new Error('A commit message of up to 4000 characters is required');
  }
  if (input.branch !== undefined && !isSafeBranchName(input.branch)) {
    throw new Error('Invalid branch name');
  }

  const { repo, directory, sessionId } = checkout;
  const defaultBranch = await resolveDefaultBranch(host, directory, repo);
  const at = shellQuote(directory);
  const current = await runGit(
    host,
    directory,
    'rev-parse --abbrev-ref HEAD',
    'read the current branch'
  );
  const branch = resolvePublishBranch({
    sessionId,
    currentBranch: current.trim(),
    defaultBranch,
    ...(input.branch === undefined ? {} : { requested: input.branch })
  });
  if (branch === defaultBranch) {
    throw new Error(
      `Publishing to the default branch (${defaultBranch}) is not supported; use a branch of its own`
    );
  }

  if (current.trim() !== branch) {
    // `switch -c` refuses an existing branch, which is the safe order: a second
    // publish reuses the branch instead of resetting it to HEAD.
    const created = await host.exec(
      `git -C ${at} switch -c ${shellQuote(branch)}`
    );
    if (!created.success) {
      await runGit(
        host,
        directory,
        `switch ${shellQuote(branch)}`,
        `switch to branch ${branch}`
      );
    }
  }

  await runGit(host, directory, 'add -A', 'stage the working tree');
  const staged = await host.exec(`git -C ${at} diff --cached --quiet`);
  // `--quiet` exits non-zero when there *is* a difference, so a successful run
  // means the tree was already clean.
  const nothingToCommit = staged.success;
  if (!nothingToCommit) {
    await runGit(
      host,
      directory,
      `commit -m ${shellQuote(message)}`,
      'commit the working tree'
    );
  }

  const head = parseHeadLine(
    await runGit(
      host,
      directory,
      `log -1 --format='%H%x09%s'`,
      'read the new commit'
    )
  );
  await runGit(
    host,
    directory,
    `push --set-upstream origin ${shellQuote(branch)}`,
    `push ${branch}`
  );

  return {
    branch,
    ...(nothingToCommit ? {} : { commit: head }),
    pushed: true,
    nothingToCommit,
    ...(input.pullRequest
      ? await openPullRequest(host, directory, {
          branch,
          base: defaultBranch,
          title: input.pullRequest.title,
          ...(input.pullRequest.body === undefined
            ? {}
            : { body: input.pullRequest.body })
        })
      : {})
  };
}

/**
 * Open a pull request for a branch that was just pushed.
 *
 * An existing pull request is not an error: `gh` refuses to create a second one
 * and names the existing URL in the refusal, which is the answer the caller
 * wanted anyway.
 */
async function openPullRequest(
  host: RuntimeHost,
  directory: string,
  input: { branch: string; base: string; title: string; body?: string }
): Promise<{ pullRequestUrl?: string }> {
  const result = await host.exec(
    [
      `cd ${shellQuote(directory)} &&`,
      'gh pr create',
      `--base ${shellQuote(input.base)}`,
      `--head ${shellQuote(input.branch)}`,
      `--title ${shellQuote(input.title)}`,
      `--body ${shellQuote(input.body ?? '')}`
    ].join(' '),
    { timeoutMs: GH_COMMAND_TIMEOUT_MS }
  );
  const url =
    parsePullRequestUrl(result.stdout) ?? parsePullRequestUrl(result.stderr);
  if (!result.success && !url) {
    throw new Error(
      `gh pr create failed: ${truncateOutput(result.stderr || result.stdout)}`
    );
  }
  return url ? { pullRequestUrl: url } : {};
}

/**
 * The branch this checkout treats as its trunk.
 *
 * Read from `origin/HEAD` rather than from the pinned catalog entry: the
 * remote's own answer is the correct one, it is available to instances that
 * predate pinning, and it stays right if the repository's default branch is
 * renamed. The pinned value is the fallback for a checkout whose `origin/HEAD`
 * was never set — a shallow clone that has not fetched since.
 */
export async function resolveDefaultBranch(
  host: RuntimeHost,
  directory: string,
  repo?: RepoDefinition
): Promise<string> {
  const result = await host.exec(
    `git -C ${shellQuote(directory)} symbolic-ref --short refs/remotes/origin/HEAD`
  );
  const branch = result.stdout.trim().replace(/^origin\//, '');
  return (result.success && branch) || repo?.defaultBranch || 'main';
}

/**
 * How far this branch is ahead of what the remote already has.
 *
 * A branch that has been pushed is measured against its own remote; one that
 * has not is measured against the default branch, because "5 commits nobody
 * else has" is the useful answer either way.
 */
async function countUnpushedCommits(
  host: RuntimeHost,
  directory: string,
  branch: string,
  defaultBranch: string,
  hasRemoteBranch: boolean
): Promise<number> {
  const base = hasRemoteBranch ? branch : defaultBranch;
  const result = await host.exec(
    `git -C ${shellQuote(directory)} rev-list --count ${shellQuote(
      `origin/${base}..HEAD`
    )}`
  );
  const count = Number.parseInt(result.stdout.trim(), 10);
  return result.success && Number.isFinite(count) ? count : 0;
}

/** Run one git command in a checkout, raising its stderr on failure. */
async function runGit(
  host: RuntimeHost,
  directory: string,
  args: string,
  intent: string
): Promise<string> {
  const result = await host.exec(
    `git -C ${shellQuote(directory)} ${args}`,
    { timeoutMs: GIT_COMMAND_TIMEOUT_MS }
  );
  if (!result.success) {
    throw new Error(
      `Failed to ${intent}: ${truncateOutput(result.stderr || result.stdout)}`
    );
  }
  return result.stdout;
}

/** `exec` that treats a non-zero exit as the failure it is. */
export async function mustExec(
  host: RuntimeHost,
  command: string
): Promise<void> {
  const result = await host.exec(command, {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS
  });
  if (!result.success) {
    throw new Error(
      `Container command failed (${command}): ${truncateOutput(result.stderr)}`
    );
  }
}

/**
 * Split `git log -1 --format='%H<tab>%s'`. A subject may contain anything but a
 * newline, so only the first tab separates the two fields.
 */
export function parseHeadLine(output: string): SessionChangesHead {
  const line = output.split('\n')[0] ?? '';
  const tab = line.indexOf('\t');
  return tab === -1
    ? { sha: line.trim(), subject: '' }
    : { sha: line.slice(0, tab).trim(), subject: line.slice(tab + 1).trim() };
}
