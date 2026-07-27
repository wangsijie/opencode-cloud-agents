import { memo, useMemo } from 'react';
import { DiffFile, DiffModeEnum, DiffView } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import { recutPatch } from '../diff-recut';

export type DiffMode = 'unified' | 'split';

export interface DiffSource {
  /** The file as it is now, which is also what the header shows. */
  path: string;
  /** Set only for a rename, where the two sides have different names. */
  oldPath?: string;
  /** One file's unified diff, header lines included. */
  patch: string;
  /**
   * Set when the patch carries the file entire — every line, changed or not.
   * It cannot be inferred: a git hunk that happens to start at line 1 looks
   * exactly the same, and treating it as the whole file would offer to expand
   * a file that is mostly missing.
   */
  wholeFile?: boolean;
}

/**
 * The data the viewer needs, or nothing if it would refuse the patch.
 *
 * A whole-file patch is re-cut so the untouched middle collapses, and because
 * that patch also holds both versions of the file, the collapsed regions stay
 * expandable — the viewer only offers that when it was given content rather
 * than a diff alone. A patch that is already cut (git's own, three lines of
 * context) is passed through as it is: the gaps are already gaps, they just
 * cannot be opened.
 *
 * The parser throws from inside the viewer's own effect, too late to catch
 * there, so every block is probed here first.
 */
function buildDiffData(source: DiffSource) {
  const oldName = source.oldPath ?? source.path;
  const recut = source.wholeFile ? recutPatch(source.patch) : undefined;
  const data = recut
    ? {
        oldFile: { fileName: oldName, content: recut.oldContent },
        newFile: { fileName: source.path, content: recut.newContent },
        hunks: [recut.patch]
      }
    : {
        oldFile: { fileName: oldName },
        newFile: { fileName: source.path },
        hunks: [source.patch]
      };
  try {
    const probe = DiffFile.createInstance(data);
    probe.initRaw();
    probe.clear();
    return data;
  } catch {
    return undefined;
  }
}

/**
 * One file's diff, wherever a diff is shown.
 *
 * Both callers — the changes panel and a transcript's patch row — render the
 * same thing from the same kind of input, so the collapsing, the expanding and
 * the fallback for an unparseable block live here rather than twice.
 *
 * Memoized because the viewer parses and highlights on mount: a poll that
 * refreshes unrelated state must not re-render every file's diff.
 */
export const FileDiff = memo(function FileDiff({
  source,
  mode = 'unified',
  dark
}: {
  source: DiffSource;
  mode?: DiffMode;
  dark: boolean;
}) {
  const data = useMemo(() => buildDiffData(source), [source]);

  if (!data) {
    // A block the parser refuses (usually a truncated tail) is still a diff
    // someone can read.
    return <pre className="diff-raw mono">{source.patch}</pre>;
  }
  return (
    <DiffView
      data={data}
      diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
      diffViewTheme={dark ? 'dark' : 'light'}
      diffViewHighlight
      diffViewWrap
      diffViewFontSize={12}
    />
  );
});
