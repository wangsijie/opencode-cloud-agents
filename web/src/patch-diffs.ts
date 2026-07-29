/**
 * What a `patch` part changed, joined to the diff that belongs to it.
 *
 * OpenCode splits this across two places. The assistant's `patch` part names
 * the files one step of a turn touched, by absolute container path, and carries
 * a snapshot hash but no content. The diff itself is summarized once per user
 * turn and stored on the *user* message, keyed by checkout-relative path. So a
 * patch row is rendered by looking up its own files in the turn it belongs to.
 *
 * The counts are therefore the turn's, not the step's: two steps that edit the
 * same file both report the file's total for the turn. That is the only diff
 * OpenCode records, and it is the number a reader is looking for — how much of
 * this file the turn rewrote — so it is shown rather than withheld.
 */
import type { MessageDiff, MessagePart, SessionMessage } from './api';

export interface PatchFile {
  /** Checkout-relative wherever the turn summary knows the file. */
  path: string;
  additions: number;
  deletions: number;
  status?: string;
  /** Absent when the turn summary has nothing for this file. */
  patch?: string;
}

export interface PatchSummary {
  files: PatchFile[];
  additions: number;
  deletions: number;
  /** False when no file in this part has a diff behind it. */
  hasDiff: boolean;
}

/** Every user turn's diff, by the message id an assistant message points at. */
export function turnDiffsByMessage(
  messages: SessionMessage[]
): Map<string, MessageDiff[]> {
  const byId = new Map<string, MessageDiff[]>();
  for (const message of messages) {
    const diffs = message.info.summary?.diffs;
    if (diffs && diffs.length > 0) {
      byId.set(message.info.id, diffs);
    }
  }
  return byId;
}

/** The files a `patch` part lists, or an empty list for any other part. */
function patchFilePaths(part: MessagePart): string[] {
  return Array.isArray(part.files)
    ? part.files.filter((file): file is string => typeof file === 'string')
    : [];
}

/**
 * The turn's entry for one absolute path.
 *
 * Matching is by suffix because the two sides disagree on the root: the part
 * says `/workspace/repo/src/a.ts` and the summary says `src/a.ts`. The `/`
 * boundary keeps `src/a.ts` from matching `other-src/a.ts`.
 */
function findDiff(
  file: string,
  diffs: MessageDiff[]
): MessageDiff | undefined {
  return diffs.find(
    (diff) => file === diff.file || file.endsWith(`/${diff.file}`)
  );
}

/**
 * Where the checkout starts, learned from a file that did match.
 *
 * A file with no diff still has a path worth reading, and `/workspace/repo/`
 * in front of every row is noise. One matched pair reveals the prefix, and it
 * is the same for the rest.
 */
function checkoutPrefix(files: string[], diffs: MessageDiff[]): string {
  for (const file of files) {
    const diff = findDiff(file, diffs);
    if (diff && file.endsWith(`/${diff.file}`)) {
      return file.slice(0, file.length - diff.file.length);
    }
  }
  return '';
}

/** `/workspace/repo/src/a.ts` → `src/a.ts`, as well as it can be known. */
function relativize(file: string, prefix: string): string {
  if (prefix && file.startsWith(prefix)) {
    return file.slice(prefix.length);
  }
  // Nothing matched, so the checkout root is a guess: drop the mount point and
  // leave the repository directory, which at least reads as a path.
  return file.replace(/^\/workspace\//, '');
}

export function summarizePatch(
  part: MessagePart,
  diffs: MessageDiff[] | undefined
): PatchSummary {
  const paths = patchFilePaths(part);
  const known = diffs ?? [];
  const prefix = checkoutPrefix(paths, known);
  const files = paths.map((file) => {
    const diff = findDiff(file, known);
    if (!diff) {
      return { path: relativize(file, prefix), additions: 0, deletions: 0 };
    }
    return {
      path: diff.file,
      additions: diff.additions,
      deletions: diff.deletions,
      ...(diff.status ? { status: diff.status } : {}),
      ...(diff.patch ? { patch: diff.patch } : {})
    };
  });
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    hasDiff: files.some((file) => file.patch !== undefined)
  };
}
