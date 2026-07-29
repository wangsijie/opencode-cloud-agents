/**
 * The code a session produced, as read out of the container.
 *
 * The pure half of the diff: parsing git's porcelain output and quoting what
 * will be interpolated into a shell command, while
 * [runtime-ops.ts](runtime-ops.ts) runs the commands and
 * [api-sessions.ts](api-sessions.ts) exposes the result.
 *
 * This module used to own a second half — commit, push, open a pull request,
 * onto `opencode/<session id>` and never onto the default branch. It is gone.
 * The agent inside the container has git and `gh` and pushes its own work when
 * asked to, which is how every session actually published; the Hub's own route
 * duplicated that, never had a button, and so was never used. What survives is
 * the read, which the Changes panel needs.
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
  /** Whether the checkout is sitting on the repository's default branch. */
  onDefaultBranch: boolean;
  head?: SessionChangesHead;
  files: ChangedFile[];
  /** Unified diff of every tracked change against `HEAD`. */
  diff: string;
  /** Whether the diff was cut short; the file list is always complete. */
  diffTruncated: boolean;
  /** Commits on this branch that the remote does not have yet. */
  unpushedCommits: number;
}

/**
 * How much diff text is returned. The file list is what the UI navigates by, so
 * a diff long enough to be unreadable is cut rather than paged: the escape hatch
 * for a change that size is the workspace panel, or a checkout of the branch.
 */
export const MAX_DIFF_LENGTH = 200_000;

/**
 * Wrap a value for `sh -c`.
 *
 * Paths and branch names reach a shell inside the container, so this is a
 * correctness boundary and not a formality: single quotes stop every
 * metacharacter, and the only character that can end the quoting is escaped by
 * closing, escaping, and reopening.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Decode `git status --porcelain=v1 -z` output that was base64-wrapped in the
 * container.
 *
 * The status is NUL-separated, but exec output rides a text transport that is
 * not guaranteed to deliver NUL bytes — when they were dropped, every record
 * fused into one long path (`a.tsx M b.css`). Piping through `base64` in the
 * container turns the bytes into plain ASCII that survives any transport, and
 * this undoes it. Whitespace is stripped first because `base64` wraps its
 * output in lines.
 */
export function decodeGitStatusOutput(output: string): string {
  const packed = output.replace(/\s/g, '');
  if (!packed) {
    return '';
  }
  const bytes = Uint8Array.from(atob(packed), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
