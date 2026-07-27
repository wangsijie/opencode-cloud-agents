import { useMemo, useState } from 'react';
import { DiffFile, DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import type { MessageDiff, MessagePart } from '../api';
import { summarizePatch, type PatchFile } from '../patch-diffs';
import { usePrefersDark } from '../usePrefersDark';
import { ChevronRightIcon } from './icons';

/**
 * The transcript is a column inside a page, not a review pane, so the diff is
 * always unified: two columns at this width is two unreadable columns.
 */
const MODE = DiffModeEnum.Unified;

/**
 * A file's diff, or the plainest honest thing that can be said instead.
 *
 * The parser throws from inside the viewer's own effect, too late to catch, so
 * every block is probed here first — a patch it refuses is still a patch a
 * person can read.
 */
function FileDiffBody({ file, dark }: { file: PatchFile; dark: boolean }) {
  const data = useMemo(() => {
    if (!file.patch) {
      return undefined;
    }
    const value = {
      oldFile: { fileName: file.path },
      newFile: { fileName: file.path },
      hunks: [file.patch]
    };
    try {
      const probe = DiffFile.createInstance(value);
      probe.initRaw();
      probe.clear();
      return value;
    } catch {
      return undefined;
    }
  }, [file]);

  if (!file.patch) {
    return (
      <p className="muted diff-file-note">
        No diff recorded for this file — the turn it belongs to has not been
        summarized yet.
      </p>
    );
  }
  if (!data) {
    return <pre className="diff-raw mono">{file.patch}</pre>;
  }
  return (
    <DiffView
      data={data}
      diffViewMode={MODE}
      diffViewTheme={dark ? 'dark' : 'light'}
      diffViewHighlight
      diffViewWrap
      diffViewFontSize={12}
    />
  );
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
        <span className="tool-open" aria-hidden="true">
          <ChevronRightIcon />
        </span>
        <span className="tool-name">
          Changed {count} {count === 1 ? 'file' : 'files'}
        </span>
        {summary.hasDiff ? (
          <span className="patch-counts mono">
            <span className="patch-add">+{summary.additions}</span>
            <span className="patch-del">−{summary.deletions}</span>
          </span>
        ) : null}
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
