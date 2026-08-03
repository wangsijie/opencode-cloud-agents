/**
 * What the Hub does *inside* a container, expressed against the host protocol.
 *
 * Credential injection, repository provisioning and the working-tree diff all
 * used to be methods on the Sandbox Durable Object, calling the sandbox SDK's
 * `exec`/`writeFile` on itself. They are functions here instead,
 * taking the narrow {@link RuntimeHost} slice of
 * [host-client.ts](host-client.ts) — so they work against any host, and so a
 * unit test can hand them a stub instead of a container.
 *
 * The round trips are what changed with them. A remote host is a public HTTPS
 * hop rather than a local method call, so a wake writes every credential in one
 * `files/write-batch` and runs every git config in one `sh -lc` script, instead
 * of one call per file and one per command.
 *
 * [session-changes.ts](session-changes.ts) stays the pure half — quoting and
 * parsing — and is imported rather than duplicated here.
 */
import type { ExecRequest, ExecResponse, HostFileWrite } from '../protocol/types.ts';
import {
  CONTAINER_AGENTS_MD_PATH,
  CONTAINER_SKILLS_ROOT,
  containerEnv,
  credentialFiles,
  gitConfigCommands,
  mcpAuthClearCommand,
  mcpAuthSeedCommand,
  type ContainerCredentialSettings
} from './container-credentials.ts';
import { truncateOutput } from './http.ts';
import {
  WORKSPACE_ROOT,
  repoOwnerFromCloneUrl,
  type RepoDefinition
} from './repos.ts';
import {
  decodeGitStatusOutput,
  limitDiff,
  MAX_DIFF_LENGTH,
  parseGitStatus,
  shellQuote,
  type ChangedFile,
  type SessionChanges,
  type SessionChangesHead
} from './session-changes.ts';

/** A clone of a large repository over SSH is the slowest thing a wake does. */
export const REPO_CLONE_TIMEOUT_MS = 5 * 60 * 1000;
export const REPO_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
export const GIT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The workspace-relative name of the marker the Sandbox writes once a
 * session's workspace is materialized. Named here, beside the other workspace
 * operations, because prebuild promotion must exclude it: a seeded workspace
 * that arrived with a donor's marker would look already-restored to the wake.
 */
export const PERSISTENCE_MARKER_NAME = '.opencode-persistence-ready';

/**
 * The XDG redirects that keep OpenCode's sessions and every package-manager
 * cache inside the snapshotted workspace. XDG_CONFIG_HOME stays unset so gh
 * reads the injected /root/.config/gh/hosts.yml login. Shared between the
 * OpenCode server start (sandbox.ts) and prebuild runs, which must install
 * dependencies under the same paths or the warm store would land in /root —
 * wiped on boot and carried by no snapshot.
 */
export const OPENCODE_XDG_ENV = {
  XDG_DATA_HOME: `${WORKSPACE_ROOT}/.opencode-state/data`,
  XDG_STATE_HOME: `${WORKSPACE_ROOT}/.opencode-state/state`,
  XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.opencode-state/cache`
};

/**
 * Where the images baked Playwright's browsers, undoing the redirect above for
 * this one tool.
 *
 * Playwright resolves its browser registry to `$XDG_CACHE_HOME/ms-playwright`,
 * and XDG_CACHE_HOME points into the workspace — so without this the browsers
 * installed in the image are invisible, and the first `chromium.launch()` of
 * every session fails with "Executable doesn't exist" and an invitation to
 * download 344 MB into the snapshot. Pinning it back to the image's path is
 * what makes the preinstall count.
 *
 * It has to be passed rather than left to the Dockerfile's `ENV`: the Docker
 * host starts OpenCode as a `docker exec` with an explicit environment, which
 * inherits nothing from the image. Both hosts therefore get it from here.
 */
export const PLAYWRIGHT_ENV = {
  PLAYWRIGHT_BROWSERS_PATH: '/usr/local/share/ms-playwright'
};

/**
 * Everything in the server's environment that is a property of the image
 * rather than of the operator's settings. Merged last by both callers, so —
 * like the XDG redirects always have been — it wins over an operator variable
 * of the same name: these paths describe where this image actually put things,
 * and a session that disagreed with them would simply not work.
 */
export const CONTAINER_RUNTIME_ENV = {
  ...OPENCODE_XDG_ENV,
  ...PLAYWRIGHT_ENV
};

/**
 * What a prebuild seed carries that belongs to the donor session, not to the
 * repository: OpenCode's own database and state under the XDG redirects (see
 * OPENCODE_ENV in sandbox.ts). The pnpm store (`.opencode-state/data/pnpm`)
 * and the download caches (`.opencode-state/cache`) stay — they are the whole
 * point of seeding.
 *
 * The persistence marker is deliberately NOT in this list. Sanitize runs
 * *after* `restoreWorkspace` has written the session's own fresh marker, so
 * removing it here deletes that marker and the next wake reads the surviving
 * volume as a lost workspace — which is exactly how inst-14d65198 was falsely
 * marked lost on 2026-07-31. A donor marker cannot leak through a seed in the
 * first place: promote excludes it at copy time (see prebuild-runner.ts).
 */
const SEED_DONOR_STATE = [
  '.opencode-state/data/opencode',
  '.opencode-state/state'
];

/**
 * How many new files are diffed by content. A session that adds a hundred files
 * has already outgrown a sidebar; past this the rest keep their place in the
 * tree with the name and status only.
 */
export const MAX_NEW_FILE_DIFFS = 100;

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
 * could read), and one script for the git configuration plus the MCP auth
 * seed. The seed is the one exception to "everything lives under `/root`": it
 * installs the staged store into the snapshotted workspace, guarded so an
 * unchanged setting never overwrites tokens OpenCode has refreshed there.
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
  commands.push(
    settings.mcpAuth
      ? mcpAuthSeedCommand(settings.mcpAuth.token)
      : mcpAuthClearCommand()
  );
  await mustExec(host, commands.join(' && '));
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
): Promise<{ fetching?: Promise<void>; cloned?: boolean }> {
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
  return { cloned: true };
}

/**
 * Turn a freshly seeded workspace into this session's own.
 *
 * A seed is a copy of some other session's workspace: right repository, warm
 * caches, wrong everything else. This removes the donor's OpenCode state (a
 * conversation database the new container must never open), resets the
 * checkout to a clean tree, and moves it to the current default branch — a
 * *blocking* fetch, unlike the resume path's background one, because the seed
 * may sit on a stale commit of whatever branch the donor was on. `git clean
 * -fd` without `-x` is deliberate: ignored files are where `node_modules`
 * lives, and carrying the donor's other ignored files is an accepted property
 * of the design (docs/prebuild-design.md).
 *
 * Runs after credential injection (the fetch needs auth) and before the
 * OpenCode server starts (the state removal must win that race). Idempotent,
 * because a wake that dies halfway through re-runs it. Throws on any failure;
 * the caller wipes the workspace and falls back to a plain clone.
 */
export async function sanitizeSeededWorkspace(
  host: RuntimeHost,
  checkout: RuntimeCheckout
): Promise<void> {
  const { repo, repoKey, directory } = checkout;
  if (!repoKey) {
    throw new Error('A repo-less session has no prebuild to sanitize');
  }
  const removals = SEED_DONOR_STATE.map(
    (path) => `${WORKSPACE_ROOT}/${path}`
  );
  await mustExec(
    host,
    removals.map((path) => `rm -rf ${shellQuote(path)}`).join(' && ')
  );

  const existing = await host.exists(`${directory}/.git`);
  if (!existing.exists) {
    throw new Error(`The seeded workspace has no checkout at ${directory}`);
  }
  const at = shellQuote(directory);
  await mustExec(
    host,
    `git -C ${at} reset --hard && git -C ${at} clean -fd`
  );

  const fetched = await host.exec(`git -C ${at} fetch origin --prune`, {
    timeoutMs: REPO_FETCH_TIMEOUT_MS
  });
  if (!fetched.success) {
    throw new Error(
      `Seed fetch failed for ${repoKey}: ${truncateOutput(fetched.stderr)}`
    );
  }
  const defaultBranch = await resolveDefaultBranch(host, directory, repo);
  const branch = shellQuote(defaultBranch);
  const remoteRef = shellQuote(`origin/${defaultBranch}`);
  await mustExec(
    host,
    `git -C ${at} checkout -B ${branch} ${remoteRef} && git -C ${at} reset --hard ${remoteRef}`
  );
}

/**
 * Throw away a workspace whose seed could not be sanitized, so the ordinary
 * clone path starts from nothing instead of from half a donor. Only the
 * checkout and the seeded state go; the marker has already been rewritten by
 * the time anything could care.
 */
export async function wipeSeededWorkspace(
  host: RuntimeHost,
  checkout: RuntimeCheckout
): Promise<void> {
  const targets = [
    checkout.directory,
    ...SEED_DONOR_STATE.map((path) => `${WORKSPACE_ROOT}/${path}`),
    `${WORKSPACE_ROOT}/.opencode-state`
  ];
  await mustExec(
    host,
    targets.map((path) => `rm -rf ${shellQuote(path)}`).join(' && ')
  );
}

/**
 * Read what the agent changed in the session's checkout.
 *
 * A git read and not an OpenCode one: the diff the user cares about is the
 * working tree, including edits an agent made through a shell rather than
 * through the edit tool — and including files the agent created, which
 * `git diff HEAD` has nothing to say about. A session that only adds files is
 * exactly the session whose changes are worth reading, so the new ones are
 * diffed against `/dev/null` in a second pass rather than left as a file list
 * with an apology under each name.
 */
export async function readSessionChanges(
  host: RuntimeHost,
  checkout: RuntimeCheckout & { repoKey: string }
): Promise<SessionChanges> {
  const { repo, repoKey, directory } = checkout;
  const defaultBranch = await resolveDefaultBranch(host, directory, repo);
  const at = shellQuote(directory);
  const [branchOut, headOut, statusOut, diffOut, remoteOut] = await Promise.all([
    host.exec(`git -C ${at} rev-parse --abbrev-ref HEAD`),
    host.exec(`git -C ${at} log -1 --format='%H%x09%s'`),
    // Wrapped in base64 because the NUL separators do not reliably survive the
    // exec transport; the worker decodes before parsing.
    // `-uall` names every file inside a new directory. Without it git collapses
    // one to `docs/`, which is a row the viewer cannot diff and a path the user
    // never wrote.
    host.exec(`git -C ${at} status --porcelain=v1 -z -uall | base64`),
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
  const files = parseGitStatus(decodeGitStatusOutput(statusOut.stdout));
  const remoteBranches = new Set(
    remoteOut.success
      ? remoteOut.stdout
          .split('\n')
          .map((line) => line.trim().replace(/^origin\//, ''))
          .filter(Boolean)
      : []
  );
  return {
    observedAt: new Date().toISOString(),
    repoKey,
    branch,
    defaultBranch,
    onDefaultBranch: branch === defaultBranch,
    ...(headOut.success && headOut.stdout.trim()
      ? { head: parseHeadLine(headOut.stdout) }
      : {}),
    files,
    // A diff that fails on a repository whose status read worked is an empty
    // diff as far as the user is concerned; the file list is the part that must
    // be right.
    ...limitDiff(
      (diffOut.success ? diffOut.stdout : '') +
        (await diffNewFiles(host, directory, files))
    ),
    unpushedCommits: await countUnpushedCommits(
      host,
      directory,
      branch,
      defaultBranch,
      remoteBranches.has(branch)
    )
  };
}

/**
 * Diff the files git does not know about yet, as additions against nothing.
 *
 * `--no-index` is what keeps this a read: staging the files with `add -N` would
 * produce the same patch, but a panel that is opened to look at a session must
 * not move that session's index. The output is the ordinary `diff --git` form
 * with `--- /dev/null` on the old side, so the viewer splits and renders it
 * exactly like the tracked half.
 *
 * Every path is one `git` in a single shell round trip. `--no-index` exits 1
 * whenever the two sides differ, which for a new file is always, so each
 * command swallows its status and the read is judged by its output.
 */
async function diffNewFiles(
  host: RuntimeHost,
  directory: string,
  files: ChangedFile[]
): Promise<string> {
  const paths = files
    .filter((file) => file.status === 'untracked')
    .slice(0, MAX_NEW_FILE_DIFFS)
    .map((file) => file.path);
  if (paths.length === 0) {
    return '';
  }
  const at = shellQuote(directory);
  const script = paths
    .map(
      (path) =>
        `git -C ${at} diff --no-index --no-color -- /dev/null ${shellQuote(path)} || true`
    )
    .join('\n');
  // Bounded in the container rather than after the fact: a single generated
  // file can be megabytes, and the budget is what the response may carry, not
  // what the transport should have to.
  const out = await host.exec(`{\n${script}\n} | head -c ${MAX_DIFF_LENGTH + 1}`, {
    timeoutMs: GIT_COMMAND_TIMEOUT_MS
  });
  return out.success ? out.stdout : '';
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
