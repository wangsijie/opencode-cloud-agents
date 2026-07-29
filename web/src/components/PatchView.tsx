import { useMemo, useState } from 'react';
import type { MessageDiff, MessagePart } from '../api';
import { summarizePatch, type PatchFile } from '../patch-diffs';
import { usePrefersDark } from '../usePrefersDark';
import { FileDiff } from './FileDiff';
import { ChevronRightIcon } from './icons';

/**
 * A file's diff, or the plainest honest thing that can be said instead. The
 * transcript is a column inside a page rather than a review pane, so the diff
 * is always unified: two columns at this width is two unreadable columns.
 */
function FileDiffBody({ file, dark }: { file: PatchFile; dark: boolean }) {
  const source = useMemo(
    () =>
      file.patch
        ? // OpenCode writes these with the whole file as context, so they can
          // be cut down and expanded again.
          { path: file.path, patch: file.patch, wholeFile: true }
        : undefined,
    [file]
  );

  if (!source) {
    return (
      <p className="muted diff-file-note">
        No diff recorded for this file — the turn it belongs to has not been
        summarized yet.
      </p>
    );
  }
  return <FileDiff source={source} dark={dark} />;
}

/**
 * What one step of a turn changed on disk.
 *
 * OpenCode emits this part after every step that wrote files, carrying the
 * paths and a snapshot hash but no content. Collapsed it is the one line the
 * transcript wants — how many files, how much of them — and opened it is the
 * diff, read from the turn summary (see `patch-diffs.ts` for why the two do not
 * come from the same message).
 */
export function PatchView({
  part,
  diffs
}: {
  part: MessagePart;
  diffs?: MessageDiff[];
}) {
  const [open, setOpen] = useState(false);
  const dark = usePrefersDark();
  const summary = useMemo(() => summarizePatch(part, diffs), [part, diffs]);

  if (summary.files.length === 0) {
    return null;
  }

  const hash = typeof part.hash === 'string' ? part.hash : undefined;
  const count = summary.files.length;

  return (
    <div className="part-patch">
      <button
        type="button"
        className={`part-tool patch-summary${open ? ' open' : ''}`}
        aria-expanded={open}
        title={hash ? `Snapshot ${hash}` : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {/* Label first, chevron last, exactly like a tool row: these rows sit
            in a stack with them, and an indent for the arrow would leave every
            other line in the column starting somewhere else. */}
        <span className="tool-name">
          Changed {count} {count === 1 ? 'file' : 'files'}
        </span>
        {summary.hasDiff ? (
          <span className="patch-counts mono">
            <span className="patch-add">+{summary.additions}</span>
            <span className="patch-del">−{summary.deletions}</span>
          </span>
        ) : null}
        <span className="tool-open" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      </button>

      {open ? (
        <div className="patch-files">
          {summary.files.map((file) => (
            <article key={file.path} className="diff-file">
              <header className="diff-file-header">
                {file.status ? (
                  <span className={`file-status status-${file.status}`}>
                    {file.status}
                  </span>
                ) : null}
                <span className="mono diff-file-path">{file.path}</span>
                {file.patch ? (
                  <span className="patch-counts mono">
                    <span className="patch-add">+{file.additions}</span>
                    <span className="patch-del">−{file.deletions}</span>
                  </span>
                ) : null}
              </header>
              <FileDiffBody file={file} dark={dark} />
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
