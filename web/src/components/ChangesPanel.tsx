import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchChanges,
  wakeSession,
  type ChangedFile,
  type ChangesScope,
  type SessionChanges
} from '../api';
import { usePrefersDark } from '../usePrefersDark';
import { FileDiff, type DiffMode } from './FileDiff';
import {
  BranchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshIcon,
  SplitDiffIcon,
  UnifiedDiffIcon,
  WorkingTreeIcon
} from './icons';

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
const SCOPE_KEY = 'hub.diffScope';

// The working tree is the default because it is the answer to "what did the
// agent just do"; the branch scope is the answer to "what would a pull request
// contain", which is a question asked later and less often.
function readScope(): ChangesScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === 'branch' ? 'branch' : 'head';
  } catch {
    return 'head';
  }
}

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
  additions: number;
  deletions: number;
}

/**
 * The +/- counts GitHub puts on every file row. Read off the block rather than
 * asked of the server: the diff is already here, and a line starting with `+`
 * or `-` that is not one of the two file headers is a changed line.
 */
function countLines(block: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of block.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      additions += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

/**
 * One card per changed file, ordered by path.
 *
 * Git hands the files back grouped by how it found them — tracked changes
 * first, untracked appended — which puts two edits in the same directory at
 * opposite ends of the panel. GitHub sorts a pull request by path and mixes
 * the statuses in, so a reader scrolls the tree they already have in their
 * head; the tree above this list is sorted the same way, so anything else
 * would make clicking a row jump backwards.
 */
function buildSections(changes: SessionChanges): FileSection[] {
  const byPath = splitRawDiff(changes.diff);
  return changes.files
    .map((file) => {
      const block = byPath.get(file.path);
      if (!block) {
        return { file, binary: false, hasHunks: false, additions: 0, deletions: 0 };
      }
      return {
        file,
        block,
        binary: /^(Binary files |GIT binary patch)/m.test(block),
        hasHunks: /^@@ /m.test(block),
        ...countLines(block)
      };
    })
    .sort((a, b) => a.file.path.localeCompare(b.file.path));
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

  // A new file is diffed against nothing, so it has a block like any other. It
  // only falls back to the note when the server left it out — too many new
  // files, or a path git quoted.
  if (file.status === 'untracked' && !block) {
    return (
      <p className="muted diff-file-note">
        New file — no diff was read for it.
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
  cleaned = false,
  onWoke
}: {
  sessionId: string;
  attached: boolean;
  /** The container was removed by the idle sweep; there is no diff left. */
  cleaned?: boolean;
  /** Let the page re-read the session, so the wake shows everywhere at once. */
  onWoke?: () => void;
}) {
  const [changes, setChanges] = useState<SessionChanges>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [waking, setWaking] = useState(false);
  const [mode, setMode] = useState<DiffMode>(readMode);
  // What the diff is measured against. A preference and not a reading position:
  // somebody who works in branch scope wants it on the next session too.
  const [scope, setScope] = useState<ChangesScope>(readScope);
  // Which files are folded shut. Deliberately component state and nothing
  // else: it is a reading position, not a preference, and a stale one restored
  // over a diff that has moved on since would hide changes the reader never
  // chose to hide. Losing it on unmount or reload is the correct behaviour.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const dark = usePrefersDark();
  const sectionRefs = useRef(new Map<string, HTMLElement>());
  /** The session and scope this mount has already asked for. */
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
        setChanges(await fetchChanges(sessionId, scope));
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
  }, [sessionId, scope]);

  // Reading a diff must never wake a container, so this is the button that
  // says the reader meant to. Nothing is loaded here: the wake moves the
  // session's lifecycle, the page's poll sees it, `attached` flips, and the
  // effect below does the read it always does.
  const wake = useCallback(async () => {
    setWaking(true);
    setError(undefined);
    try {
      await wakeSession(sessionId);
      onWoke?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWaking(false);
    }
  }, [sessionId, onWoke]);

  // Another session is another workspace: nothing read here survives the
  // switch, including a failure that must not suppress the next read.
  useEffect(() => {
    setChanges(undefined);
    setError(undefined);
    setCollapsed(new Set());
    setWaking(false);
    requested.current = undefined;
  }, [sessionId]);

  // Choosing the tab is the request to read; a sleeping container has nothing
  // to read and must not be woken by a panel being opened. One read per
  // session and scope — `changes` cannot be the guard, because a failed read
  // leaves it empty and the effect would fire again the moment it settled.
  // Switching the scope is a different read, so it is part of the key.
  useEffect(() => {
    const key = `${sessionId}:${scope}`;
    if (!attached || requested.current === key) {
      return;
    }
    requested.current = key;
    void load();
  }, [attached, sessionId, scope, load]);

  const setDiffMode = useCallback((next: DiffMode) => {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      // Storage can be unavailable; the choice just resets next visit.
    }
  }, []);

  // The old diff is dropped rather than left on screen under the new label: it
  // is a different set of files, and showing it beside the other scope's header
  // would misreport what is being looked at.
  const setDiffScope = useCallback((next: ChangesScope) => {
    setScope(next);
    setChanges(undefined);
    setCollapsed(new Set());
    try {
      localStorage.setItem(SCOPE_KEY, next);
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

  const toggleFile = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Clicking a file in the tree is a request to read it, so a folded target
  // unfolds on the way — scrolling to a collapsed header would look like the
  // link did nothing.
  const scrollToFile = useCallback((path: string) => {
    setCollapsed((current) => {
      if (!current.has(path)) {
        return current;
      }
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    sectionRefs.current
      .get(path)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const allCollapsed =
    sections.length > 0 && sections.every((s) => collapsed.has(s.file.path));

  const toggleAll = useCallback(() => {
    setCollapsed(
      allCollapsed ? new Set() : new Set(sections.map((s) => s.file.path))
    );
  }, [allCollapsed, sections]);

  return (
    <section className="changes-panel">
      {attached ? (
        <header className="changes-header">
          {changes ? (
            <p className="changes-summary muted mono">
              {changes.branch}
              {changes.onDefaultBranch ? ' (default branch)' : ''}
              {/* Which base produced this list, since the two scopes differ by
                  exactly the commits the session has not pushed. */}
              {changes.scope === 'branch'
                ? ` vs origin/${changes.defaultBranch}`
                : ' (uncommitted)'}{' '}
              · {changes.files.length} files
              {changes.unpushedCommits > 0
                ? ` · ${changes.unpushedCommits} unpushed commits`
                : ''}
            </p>
          ) : (
            <span />
          )}
          <div className="changes-actions">
            {/* What the diff is measured against. Left of the layout toggle
                because it decides which changes exist at all, where the other
                only decides how they are drawn. */}
            <div
              className="diff-mode-toggle"
              role="group"
              aria-label="Diff base"
            >
              <button
                className={`icon-button${scope === 'head' ? ' active' : ''}`}
                type="button"
                aria-pressed={scope === 'head'}
                aria-label="Uncommitted changes"
                title="Uncommitted changes (working tree)"
                onClick={() => setDiffScope('head')}
              >
                <WorkingTreeIcon />
              </button>
              <button
                className={`icon-button${scope === 'branch' ? ' active' : ''}`}
                type="button"
                aria-pressed={scope === 'branch'}
                aria-label="All changes on this branch"
                title={`All changes on this branch, including unpushed commits, against origin/${
                  changes?.defaultBranch ?? 'the default branch'
                }`}
                onClick={() => setDiffScope('branch')}
              >
                <BranchIcon />
              </button>
            </div>
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
            {sections.length > 0 ? (
              <button
                className="icon-button"
                type="button"
                aria-expanded={!allCollapsed}
                aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                onClick={toggleAll}
              >
                {allCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </button>
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
        cleaned ? (
          <p className="muted">
            This session was cleaned up, so its workspace and changes no longer
            exist.
          </p>
        ) : (
          <>
            <p className="muted">
              This session is asleep. Wake the container to read its changes —
              this starts it and nothing else; the agent is not sent anything.
            </p>
            <div className="actions">
              <button
                className="button"
                type="button"
                disabled={waking}
                onClick={() => void wake()}
              >
                {waking ? 'Waking…' : 'Wake container'}
              </button>
            </div>
            {error ? (
              <p className="banner error" role="alert">
                {error}
              </p>
            ) : null}
          </>
        )
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
              ) : changes.scope === 'branch' ? (
                <p className="muted">
                  Nothing on this branch yet — it matches origin/
                  {changes.defaultBranch}.
                </p>
              ) : (
                <p className="muted">Working tree is clean — nothing uncommitted.</p>
              )}
              {/* Asked for the branch and got the working tree: the checkout has
                  no `origin/<default>` to measure from, which is a fact about
                  the clone and not something a retry fixes. */}
              {scope === 'branch' && changes.scope === 'head' ? (
                <p className="muted">
                  No origin/{changes.defaultBranch} in this checkout, so only
                  uncommitted changes are shown.
                </p>
              ) : null}
              {sections.map((section) => {
                const path = section.file.path;
                const open = !collapsed.has(path);
                return (
                  <article
                    key={path}
                    className={`diff-file${open ? '' : ' collapsed'}`}
                    ref={(el) => {
                      if (el) {
                        sectionRefs.current.set(path, el);
                      } else {
                        sectionRefs.current.delete(path);
                      }
                    }}
                  >
                    {/* The whole header is the toggle, as it is on GitHub: a
                        12px chevron is a hard target on a phone, and there is
                        nothing else in the row to click. */}
                    <button
                      className="diff-file-header"
                      type="button"
                      aria-expanded={open}
                      onClick={() => toggleFile(path)}
                    >
                      <span className="diff-file-chevron" aria-hidden="true">
                        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
                      </span>
                      <span className={`file-status status-${section.file.status}`}>
                        {STATUS_LABELS[section.file.status] ??
                          section.file.status}
                      </span>
                      <span className="mono diff-file-path">
                        {section.file.renamedFrom
                          ? `${section.file.renamedFrom} → `
                          : ''}
                        {path}
                      </span>
                      {section.additions > 0 || section.deletions > 0 ? (
                        <span className="diff-file-stat mono">
                          {section.additions > 0 ? (
                            <span className="stat-add">+{section.additions}</span>
                          ) : null}
                          {section.deletions > 0 ? (
                            <span className="stat-del">−{section.deletions}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                    {open ? (
                      <FileDiffBody section={section} mode={mode} dark={dark} />
                    ) : null}
                  </article>
                );
              })}
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
