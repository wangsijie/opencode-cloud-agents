import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchChanges, type ChangedFile, type SessionChanges } from '../api';
import { usePrefersDark } from '../usePrefersDark';
import { FileDiff, type DiffMode } from './FileDiff';
import { RefreshIcon, SplitDiffIcon, UnifiedDiffIcon } from './icons';

/** How many times one request to read the diff may be tried before it stops. */
const LOAD_ATTEMPTS = 3;
/** Grows with the attempt: 1s, then 2s. */
const RETRY_DELAY_MS = 1000;

const STATUS_LABELS: Record<string, string> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  untracked: 'untracked',
  conflicted: 'conflicted'
};

// One letter in the tree, the full word in the section header: the tree is a
// map, and a map has no room for the word "modified" on every row.
const STATUS_CODES: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C'
};

const MODE_KEY = 'hub.diffViewMode';

// Unified is the default because the sidebar starts at 380px, and two columns
// in that width is two unreadable columns.
function readMode(): DiffMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

/**
 * The server hands over `git diff HEAD` verbatim: every file in one string.
 * The viewer parses one file at a time, so the string is cut at each
 * `diff --git` header and keyed by the new-side path — the same path the
 * status list uses, which is what lets the two agree on renames.
 *
 * Git quotes paths with special characters, which these regexes do not chase;
 * such a file simply keeps its place in the tree with no diff attached.
 */
function splitRawDiff(diff: string): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const block of diff.split(/^(?=diff --git )/m)) {
    if (!block.startsWith('diff --git ')) {
      continue;
    }
    const path =
      /^\+\+\+ b\/(.+)$/m.exec(block)?.[1] ??
      /^rename to (.+)$/m.exec(block)?.[1] ??
      // Deleted files have `+++ /dev/null`; their name is on the old side.
      /^--- a\/(.+)$/m.exec(block)?.[1];
    if (path) {
      byPath.set(path, block);
    }
  }
  return byPath;
}

interface FileSection {
  file: ChangedFile;
  block?: string;
  binary: boolean;
  hasHunks: boolean;
}

function buildSections(changes: SessionChanges): FileSection[] {
  const byPath = splitRawDiff(changes.diff);
  return changes.files.map((file) => {
    const block = byPath.get(file.path);
    if (!block) {
      return { file, binary: false, hasHunks: false };
    }
    return {
      file,
      block,
      binary: /^(Binary files |GIT binary patch)/m.test(block),
      hasHunks: /^@@ /m.test(block)
    };
  });
}

interface TreeDir {
  name: string;
  dirs: TreeDir[];
  files: ChangedFile[];
}

interface BuildNode {
  dirs: Map<string, BuildNode>;
  files: ChangedFile[];
}

function buildTree(files: ChangedFile[]): TreeDir {
  const root: BuildNode = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  // Chains of lone directories collapse into one row (`web/src/components`):
  // a tree of changes is almost always deep and narrow, and a rail of
  // single-child folders is depth with no information in it.
  const convert = (name: string, node: BuildNode): TreeDir => {
    let label = name;
    let current = node;
    while (current.files.length === 0 && current.dirs.size === 1) {
      const [childName, child] = [...current.dirs][0];
      label = `${label}/${childName}`;
      current = child;
    }
    return {
      name: label,
      dirs: [...current.dirs]
        .map(([childName, child]) => convert(childName, child))
        .sort((a, b) => a.name.localeCompare(b.name)),
      files: [...current.files].sort((a, b) => a.path.localeCompare(b.path))
    };
  };
  const converted = [...root.dirs]
    .map(([name, node]) => convert(name, node))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    name: '',
    dirs: converted,
    files: [...root.files].sort((a, b) => a.path.localeCompare(b.path))
  };
}

const basename = (path: string) => path.split('/').pop() ?? path;

function TreeLevel({
  node,
  onSelect
}: {
  node: TreeDir;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="file-tree" role="group">
      {node.dirs.map((dir) => (
        <li key={dir.name}>
          <details open>
            <summary className="file-tree-dir mono">{dir.name}/</summary>
            <TreeLevel node={dir} onSelect={onSelect} />
          </details>
        </li>
      ))}
      {node.files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            className="file-tree-file"
            title={
              file.renamedFrom
                ? `${file.renamedFrom} → ${file.path}`
                : file.path
            }
            onClick={() => onSelect(file.path)}
          >
            <span className={`tree-status status-${file.status}`}>
              {STATUS_CODES[file.status] ?? '?'}
            </span>
            <span className="mono file-tree-name">{basename(file.path)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function FileDiffBody({
  section,
  mode,
  dark
}: {
  section: FileSection;
  mode: DiffMode;
  dark: boolean;
}) {
  const { file, block, binary, hasHunks } = section;
  const source = useMemo(
    () =>
      block
        ? {
            path: file.path,
            ...(file.renamedFrom ? { oldPath: file.renamedFrom } : {}),
            patch: block
          }
        : undefined,
    [file, block]
  );

  if (file.status === 'untracked') {
    return (
      <p className="muted diff-file-note">
        New file — not yet tracked, so there is no diff against HEAD.
      </p>
    );
  }
  if (!block) {
    return <p className="muted diff-file-note">No diff for this file.</p>;
  }
  if (binary) {
    return <p className="muted diff-file-note">Binary file — no text diff.</p>;
  }
  if (!hasHunks || !source) {
    return <p className="muted diff-file-note">No content changes.</p>;
  }
  return <FileDiff source={source} mode={mode} dark={dark} />;
}

/**
 * What the agent changed, read-only.
 *
 * The file list and diff come from git in the checkout; committing and pushing
 * belong to the agent, so this panel only shows. It is a tab in the details
 * sidebar, and it reads the workspace when it is mounted rather than with the
 * session page. Reading a diff runs commands in the container, so paying for
 * it on every session view — and on every poll — would make looking at a
 * conversation more expensive than having one.
 */
export function ChangesPanel({
  sessionId,
  attached,
  cleaned = false
}: {
  sessionId: string;
  attached: boolean;
  /** The container was removed by the idle sweep; there is no diff left. */
  cleaned?: boolean;
}) {
  const [changes, setChanges] = useState<SessionChanges>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<DiffMode>(readMode);
  const dark = usePrefersDark();
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  /** The session whose diff this mount has already asked for. */
  const requested = useRef<string | undefined>(undefined);

  // Reading a diff runs git in a container that is often still busy with the
  // turn that produced it, so a first attempt can legitimately fail. A few
  // spaced retries absorb that; an unbounded one would turn every failure into
  // a request storm against the very container that could not answer.
  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt += 1) {
      try {
        setChanges(await fetchChanges(sessionId));
        setError(undefined);
        setLoading(false);
        return;
      } catch (cause) {
        setChanges(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
        if (attempt + 1 < LOAD_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1))
          );
        }
      }
    }
    // The banner keeps the host's own message, and the refresh button is the
    // retry from here on.
    setLoading(false);
  }, [sessionId]);

  // Another session is another workspace: nothing read here survives the
  // switch, including a failure that must not suppress the next read.
  useEffect(() => {
    setChanges(undefined);
    setError(undefined);
    requested.current = undefined;
  }, [sessionId]);

  // Choosing the tab is the request to read; a sleeping container has nothing
  // to read and must not be woken by a panel being opened. One read per
  // session — `changes` cannot be the guard, because a failed read leaves it
  // empty and the effect would fire again the moment it settled.
  useEffect(() => {
    if (!attached || requested.current === sessionId) {
      return;
    }
    requested.current = sessionId;
    void load();
  }, [attached, sessionId, load]);

  const setDiffMode = useCallback((next: DiffMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Storage can be unavailable; the choice just resets next visit.
    }
  }, []);

  const sections = useMemo(
    () => (changes ? buildSections(changes) : []),
    [changes]
  );
  const tree = useMemo(
    () => (changes ? buildTree(changes.files) : undefined),
    [changes]
  );

  const scrollToFile = useCallback((path: string) => {
    sectionRefs.current
      .get(path)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  return (
    <section className="changes-panel">
      {attached ? (
        <header className="changes-header">
          {changes ? (
            <p className="changes-summary muted mono">
              {changes.branch}
              {changes.onDefaultBranch ? ' (default branch)' : ''} ·{' '}
              {changes.files.length} files
              {changes.unpushedCommits > 0
                ? ` · ${changes.unpushedCommits} unpushed commits`
                : ''}
            </p>
          ) : (
            <span />
          )}
          <div className="changes-actions">
            {changes && changes.files.length > 0 ? (
              <div
                className="diff-mode-toggle"
                role="group"
                aria-label="Diff layout"
              >
                <button
                  className={`icon-button${mode === 'unified' ? ' active' : ''}`}
                  type="button"
                  aria-pressed={mode === 'unified'}
                  aria-label="Unified diff"
                  title="Unified diff"
                  onClick={() => setDiffMode('unified')}
                >
                  <UnifiedDiffIcon />
                </button>
                <button
                  className={`icon-button${mode === 'split' ? ' active' : ''}`}
                  type="button"
                  aria-pressed={mode === 'split'}
                  aria-label="Split diff"
                  title="Split diff"
                  onClick={() => setDiffMode('split')}
                >
                  <SplitDiffIcon />
                </button>
              </div>
            ) : null}
            <button
              className="icon-button"
              type="button"
              disabled={loading}
              aria-label="Refresh changes"
              title="Refresh changes"
              onClick={() => void load()}
            >
              <RefreshIcon />
            </button>
          </div>
        </header>
      ) : null}

      {!attached ? (
        <p className="muted">
          {cleaned
            ? 'This session was cleaned up, so its workspace and changes no longer exist.'
            : 'This session is asleep. Send a message to wake the container, then the changes show up here.'}
        </p>
      ) : loading && !changes ? (
        <p className="muted">Reading the workspace…</p>
      ) : (
        <>
          {changes ? (
            <>
              {changes.files.length > 0 && tree ? (
                <nav className="file-tree-root" aria-label="Changed files">
                  <TreeLevel node={tree} onSelect={scrollToFile} />
                </nav>
              ) : (
                <p className="muted">Working tree is clean — nothing uncommitted.</p>
              )}
              {sections.map((section) => (
                <article
                  key={section.file.path}
                  className="diff-file"
                  ref={(el) => {
                    if (el) {
                      sectionRefs.current.set(section.file.path, el);
                    } else {
                      sectionRefs.current.delete(section.file.path);
                    }
                  }}
                >
                  <header className="diff-file-header">
                    <span
                      className={`file-status status-${section.file.status}`}
                    >
                      {STATUS_LABELS[section.file.status] ??
                        section.file.status}
                    </span>
                    <span className="mono diff-file-path">
                      {section.file.renamedFrom
                        ? `${section.file.renamedFrom} → `
                        : ''}
                      {section.file.path}
                    </span>
                  </header>
                  <FileDiffBody section={section} mode={mode} dark={dark} />
                </article>
              ))}
              {changes.diffTruncated ? (
                <p className="muted">
                  Diff was too long and got truncated; ask the agent to run git
                  diff for the full text.
                </p>
              ) : null}
            </>
          ) : null}

          {error ? (
            <p className="banner error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
