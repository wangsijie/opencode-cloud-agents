/**
 * Browsing a session's checkout from the Hub UI.
 *
 * This module is the pure half of that feature: resolving a browser-supplied
 * path against the session's directory, and shaping what the container's file
 * API returns into something a list can render. The container calls themselves
 * live in [sandbox.ts](sandbox.ts).
 *
 * The path rules are the security boundary. A request names a path *relative to
 * the checkout*, never an absolute container path, and anything that would
 * leave that subtree — `..`, an absolute path, a NUL byte — is rejected rather
 * than clamped, because a silently rewritten path is indistinguishable from one
 * that was honoured.
 */

/** Largest file served inline. Beyond this the viewer shows a prefix. */
export const MAX_VIEWABLE_FILE_BYTES = 256 * 1024;

/** Entries returned for one directory. Deep trees are browsed one level at a time. */
export const MAX_DIRECTORY_ENTRIES = 2000;

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface WorkspaceEntry {
  name: string;
  /** Path relative to the session's checkout; `''` is the checkout itself. */
  path: string;
  type: WorkspaceEntryType;
  size: number;
  modifiedAt?: string;
}

export interface WorkspaceListing {
  /** The directory that was listed, relative to the checkout. */
  path: string;
  /** The containing directory, absent at the checkout root. */
  parent?: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  /** Absent for binary files, which are described rather than shown. */
  content?: string;
  binary: boolean;
  /** Set when only the first {@link MAX_VIEWABLE_FILE_BYTES} are included. */
  truncated: boolean;
}

/**
 * Turn a browser-supplied relative path into an absolute container path.
 *
 * `root` is the session's checkout and is trusted; `requested` is not. An empty
 * or absent request is the checkout root, which is what makes the panel's first
 * load a request with no path at all.
 */
export function resolveWorkspacePath(root: string, requested?: unknown): string {
  const relative = normalizeWorkspaceRelativePath(requested);
  return relative ? `${root}/${relative}` : root;
}

/**
 * The canonical relative form of a requested path, or a thrown error.
 *
 * Segment rules rather than string prefixes: `..` is rejected as a segment, so
 * a legitimate file named `..config` is not caught by the same check.
 */
export function normalizeWorkspaceRelativePath(requested?: unknown): string {
  if (requested === undefined || requested === null || requested === '') {
    return '';
  }
  if (typeof requested !== 'string') {
    throw new WorkspacePathError('Invalid path');
  }
  if (requested.includes('\0') || requested.length > 4096) {
    throw new WorkspacePathError('Invalid path');
  }
  const segments = requested.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new WorkspacePathError('Path escapes the workspace');
  }
  // A leading slash is the one ambiguity worth resolving instead of refusing:
  // `/src` from a UI that builds paths by joining is plainly `src`, and every
  // way out of the subtree is already gone by this point.
  return segments.join('/');
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/** Directories the file browser never lists. */
const HIDDEN_DIRECTORIES = new Set(['.git']);

interface ContainerFileInfo {
  name: string;
  type: WorkspaceEntryType;
  size: number;
  modifiedAt?: string;
}

/**
 * Shape one directory read into a listing.
 *
 * Directories sort before files and both sort by name, which is the order a
 * file tree is read in. `.git` is dropped: it is thousands of objects nobody
 * browses, and the diff panel already answers everything it would.
 */
export function buildWorkspaceListing(
  relativePath: string,
  files: readonly ContainerFileInfo[]
): WorkspaceListing {
  const visible = files.filter((file) => !HIDDEN_DIRECTORIES.has(file.name));
  const sorted = [...visible].sort((left, right) => {
    const leftIsDirectory = left.type === 'directory';
    const rightIsDirectory = right.type === 'directory';
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
  const truncated = sorted.length > MAX_DIRECTORY_ENTRIES;
  return {
    path: relativePath,
    ...(relativePath ? { parent: parentPath(relativePath) } : {}),
    entries: sorted.slice(0, MAX_DIRECTORY_ENTRIES).map((file) => ({
      name: file.name,
      path: relativePath ? `${relativePath}/${file.name}` : file.name,
      type: file.type,
      size: file.size,
      ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {})
    })),
    truncated
  };
}

export function parentPath(relativePath: string): string {
  const index = relativePath.lastIndexOf('/');
  return index === -1 ? '' : relativePath.slice(0, index);
}

/**
 * Decide what to show for one file's bytes.
 *
 * Binary content is described rather than rendered — a PNG pasted into a `<pre>`
 * is noise, and base64 of it is worse. Text is capped at a size a phone can
 * scroll; the cap is reported so the viewer can say the file continues.
 */
export function buildWorkspaceFile(input: {
  path: string;
  content: string;
  encoding?: 'utf-8' | 'base64';
}): WorkspaceFile {
  if (input.encoding === 'base64') {
    return {
      path: input.path,
      // Base64 is 4 characters per 3 bytes; the exact tail does not matter for
      // a "this file is 2.4 MB of binary" label.
      size: Math.floor((input.content.length * 3) / 4),
      binary: true,
      truncated: false
    };
  }
  const size = utf8Length(input.content);
  if (size <= MAX_VIEWABLE_FILE_BYTES) {
    return { path: input.path, size, content: input.content, binary: false, truncated: false };
  }
  return {
    path: input.path,
    size,
    // Sliced by character rather than byte: the cut must not land inside a
    // multi-byte sequence, and being a little under the cap is harmless.
    content: input.content.slice(0, MAX_VIEWABLE_FILE_BYTES),
    binary: false,
    truncated: true
  };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
