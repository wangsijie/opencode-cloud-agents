/**
 * The code a session produced, and how it leaves the container.
 *
 * An agent that edits a repository is only useful if the work can get out, so
 * this module owns both halves of that: reading the working tree (which files
 * changed, and the diff) and publishing it (commit, push, pull request). It
 * holds the pure parts — parsing git's porcelain output, validating what will be
 * interpolated into a shell command, deciding which branch to publish onto —
 * while [sandbox.ts](sandbox.ts) runs the commands and
 * [api-sessions.ts](api-sessions.ts) exposes them.
 *
 * ## Branching
 *
 * Publishing never commits onto the repository's default branch. The roadmap
 * left the branch question open; this is the answer: an agent's work lands on
 * `opencode/<session id>`, which is created on first publish and reused
 * afterwards, and the pull request against the default branch is where a human
 * reviews it. Committing straight to `master` is the one outcome that cannot be
 * undone by closing a tab, so it is not the default and cannot be reached by
 * accident — only by naming the branch explicitly.
 */

/** How a path differs from `HEAD`, folded down from git's two-letter codes. */
export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  /** Present for renames and copies: where the content came from. */
  renamedFrom?: string;
}

export interface SessionChangesHead {
  sha: string;
  subject: string;
}

/** What the working tree of a session's checkout currently looks like. */
export interface SessionChanges {
  observedAt: string;
  repoKey: string;
  branch: string;
  defaultBranch: string;
  /** Whether committing here would land on the branch publishing protects. */
  onDefaultBranch: boolean;
  head?: SessionChangesHead;
  files: ChangedFile[];
  /** Unified diff of every tracked change against `HEAD`. */
  diff: string;
  /** Whether the diff was cut short; the file list is always complete. */
  diffTruncated: boolean;
  /** Commits on this branch that the remote does not have yet. */
  unpushedCommits: number;
  /** The branch publishing would use, given the current state. */
  publishBranch: string;
  /** Set once this branch exists on the remote. */
  remoteBranch?: string;
}

export interface PublishSessionChangesInput {
  message: string;
  /** Overrides the derived branch. Refused when it is the default branch. */
  branch?: string;
  pullRequest?: { title: string; body?: string };
}

export interface PublishSessionChangesResult {
  branch: string;
  /** Absent when the working tree had nothing left to commit. */
  commit?: SessionChangesHead;
  /** How many commits the push carried, including ones from earlier turns. */
  pushed: boolean;
  pullRequestUrl?: string;
  /** Set when the tree was already clean, so the push carried earlier work. */
  nothingToCommit: boolean;
}

export const MAX_COMMIT_MESSAGE_LENGTH = 4_000;
export const MAX_PULL_REQUEST_BODY_LENGTH = 60_000;
/**
 * How much diff text is returned. The file list is what the UI navigates by, so
 * a diff long enough to be unreadable is cut rather than paged: the escape hatch
 * for a change that size is the workspace panel, or a checkout of the branch.
 */
export const MAX_DIFF_LENGTH = 200_000;

/**
 * Wrap a value for `sh -c`.
 *
 * Commit messages and pull request bodies are user text that reaches a shell, so
 * this is a correctness boundary and not a formality: single quotes stop every
 * metacharacter, and the only character that can end the quoting is escaped by
 * closing, escaping, and reopening.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a string is usable as a git branch name.
 *
 * Deliberately far narrower than `git check-ref-format`: the names this accepts
 * are the ones a person types into the publish form, and everything exotic that
 * git would tolerate is refused rather than escaped.
 */
export function isSafeBranchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 100 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  );
}

/** The branch a session publishes onto when nobody names one. */
export function sessionPublishBranch(sessionId: string): string {
  return `opencode/${sessionId}`;
}

/**
 * Which branch a publish should target.
 *
 * A session that is already on its own branch keeps using it, so a second
 * publish adds a commit rather than starting somewhere new. Anything still on
 * the default branch moves onto the session branch, which is the whole point of
 * the rule.
 */
export function resolvePublishBranch(input: {
  sessionId: string;
  currentBranch: string;
  defaultBranch: string;
  requested?: string;
}): string {
  if (input.requested) {
    return input.requested;
  }
  if (
    input.currentBranch &&
    input.currentBranch !== input.defaultBranch &&
    input.currentBranch !== 'HEAD'
  ) {
    return input.currentBranch;
  }
  return sessionPublishBranch(input.sessionId);
}

/** Normalize a commit message, or return undefined when it is unusable. */
export function normalizeCommitMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Git strips trailing whitespace per line anyway; doing it here keeps the
  // message that is echoed back identical to the one that was committed.
  const message = value
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
  if (!message || message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    return undefined;
  }
  return message;
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * The NUL-separated form is used rather than the readable one because git
 * quotes and escapes paths in the default output, and a path that has to be
 * unescaped before it can be shown is a path that can be shown wrong.
 * Renames and copies carry a second record with the original path.
 */
export function parseGitStatus(output: string): ChangedFile[] {
  const records = output.split('\0');
  const files: ChangedFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) {
      continue;
    }
    const index0 = record[0];
    const worktree = record[1];
    const path = record.slice(3);
    if (index0 === 'R' || index0 === 'C') {
      // The original path is its own record; skipping it here is what keeps it
      // from also being listed as a change of its own.
      const renamedFrom = records[index + 1];
      index += 1;
      files.push({
        path,
        status: 'renamed',
        ...(renamedFrom ? { renamedFrom } : {})
      });
      continue;
    }
    files.push({ path, status: statusFromCodes(index0, worktree) });
  }
  return files;
}

function statusFromCodes(index0: string, worktree: string): ChangedFileStatus {
  if (index0 === '?' || worktree === '?') {
    return 'untracked';
  }
  if (index0 === 'U' || worktree === 'U' || (index0 === 'A' && worktree === 'A')) {
    return 'conflicted';
  }
  if (index0 === 'D' || worktree === 'D') {
    return 'deleted';
  }
  if (index0 === 'A') {
    return 'added';
  }
  return 'modified';
}

/** Cut a diff to the response budget, reporting whether anything was dropped. */
export function limitDiff(diff: string): { diff: string; diffTruncated: boolean } {
  return diff.length > MAX_DIFF_LENGTH
    ? { diff: diff.slice(0, MAX_DIFF_LENGTH), diffTruncated: true }
    : { diff, diffTruncated: false };
}

/**
 * The pull request URL `gh pr create` printed.
 *
 * `gh` prints the URL on its own line, but it also prints progress and hints
 * around it, so the URL is found rather than assumed to be the whole output.
 */
export function parsePullRequestUrl(output: string): string | undefined {
  const match = /https:\/\/[^\s]*\/pull\/\d+/.exec(output);
  return match?.[0];
}
