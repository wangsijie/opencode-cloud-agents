/**
 * Shared helpers for fixture data.
 *
 * Timestamps are computed relative to now so the sidebar's date buckets and the
 * relative-time labels stay populated no matter when the dev server starts.
 */

/** Greppable marker proving no mock code reaches a production bundle. */
export const MOCK_SENTINEL = 'OPENCODE_HUB_MOCK_FIXTURES';

export const minutesAgo = (n: number): string =>
  new Date(Date.now() - n * 60_000).toISOString();

export const hoursAgo = (n: number): string => minutesAgo(n * 60);

export const daysAgo = (n: number): string => hoursAgo(n * 24);

export const inMinutes = (n: number): string =>
  new Date(Date.now() + n * 60_000).toISOString();

/** Epoch milliseconds for `MessageInfo.time` fields. */
export const msAgo = (n: number): number => Date.now() - n;

/**
 * A whole-file unified diff without git's `diff --git` header — the shape
 * OpenCode's turn summaries use (`MessageDiff.patch`). Lines are prefixed with
 * ` `, `+` or `-`; the single hunk starts at line 1 so `recutPatch` can
 * reconstruct both file versions and make the collapsed regions expandable.
 */
export function wholeFilePatch(path: string, lines: string[]): string {
  const oldCount = lines.filter((line) => !line.startsWith('+')).length;
  const newCount = lines.filter((line) => !line.startsWith('-')).length;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...lines
  ].join('\n');
}

export const countAdditions = (lines: string[]): number =>
  lines.filter((line) => line.startsWith('+')).length;

export const countDeletions = (lines: string[]): number =>
  lines.filter((line) => line.startsWith('-')).length;

/** One `git diff HEAD` block for a modified file. */
export function gitModified(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    wholeFilePatch(path, lines)
  ].join('\n');
}

/** One block for a newly added (tracked) file; every line must start with `+`. */
export function gitAdded(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..2222222',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines
  ].join('\n');
}

/** One block for a deleted file; every line must start with `-`. */
export function gitDeleted(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1111111..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines
  ].join('\n');
}

/** One block for a rename with edits. */
export function gitRenamed(from: string, to: string, lines: string[]): string {
  const oldCount = lines.filter((line) => !line.startsWith('+')).length;
  const newCount = lines.filter((line) => !line.startsWith('-')).length;
  return [
    `diff --git a/${from} b/${to}`,
    'similarity index 87%',
    `rename from ${from}`,
    `rename to ${to}`,
    'index 1111111..2222222 100644',
    `--- a/${from}`,
    `+++ b/${to}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...lines
  ].join('\n');
}

/** One block for a binary change — no hunks, just the marker line. */
export function gitBinary(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `Binary files a/${path} and b/${path} differ`
  ].join('\n');
}
