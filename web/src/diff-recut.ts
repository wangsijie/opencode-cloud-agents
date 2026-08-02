/**
 * Cutting a whole-file patch down to the lines that changed.
 *
 * OpenCode writes its turn summaries with the entire file as context — one hunk
 * from line 1 to the end — so a two-line edit to a long file arrives as the
 * long file. Git's own diffs come pre-cut with three lines of context, and that
 * is the shape a reader expects, so a patch like OpenCode's is re-cut to match.
 *
 * The gain is not only length. A patch that carries every line also carries
 * both versions of the file in full, so the recut hands the viewer the file
 * contents alongside the shortened hunks — which is what lets the collapsed
 * regions be expanded again, the way they are on a pull request.
 */

/** Lines of context kept around each run of changes, as git does by default. */
const CONTEXT = 3;

export interface RecutPatch {
  /** The patch, re-cut to `CONTEXT` lines around each change. */
  patch: string;
  oldContent: string;
  newContent: string;
}

interface Hunk {
  oldStart: number;
  header: string;
  body: string[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function splitHunks(patch: string): { preamble: string[]; hunks: Hunk[] } {
  const preamble: string[] = [];
  const hunks: Hunk[] = [];
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      hunks.push({ oldStart: Number(header[1]), header: line, body: [] });
      continue;
    }
    if (hunks.length === 0) {
      preamble.push(line);
      continue;
    }
    hunks[hunks.length - 1]!.body.push(line);
  }
  return { preamble, hunks };
}

/**
 * The file's two versions, if this patch holds all of both.
 *
 * Only a single hunk that starts at line 1 can be trusted to: anything else has
 * lines the patch never mentions, and reconstructing from it would invent a
 * file that is missing its middle.
 */
export function recutPatch(
  patch: string,
  context: number = CONTEXT
): RecutPatch | undefined {
  const { preamble, hunks } = splitHunks(patch);
  const hunk = hunks[0];
  if (hunks.length !== 1 || !hunk || hunk.oldStart !== 1) {
    return undefined;
  }

  const lines = hunk.body.filter(
    // `\ No newline at end of file` annotates the line before it; the recut
    // drops it, which costs a marker and keeps the line arithmetic honest.
    (line) => line.length > 0 && !line.startsWith('\\')
  );
  if (lines.length === 0 || lines.every((line) => line.startsWith(' '))) {
    return undefined;
  }

  const oldLines: string[] = [];
  const newLines: string[] = [];
  // Where each patch line lands in each version, so a hunk header can be
  // written for any starting point.
  const oldNumbers: number[] = [];
  const newNumbers: number[] = [];
  for (const line of lines) {
    const text = line.slice(1);
    oldNumbers.push(oldLines.length + 1);
    newNumbers.push(newLines.length + 1);
    if (line.startsWith('-')) {
      oldLines.push(text);
    } else if (line.startsWith('+')) {
      newLines.push(text);
    } else {
      oldLines.push(text);
      newLines.push(text);
    }
  }

  // Every line within `context` of a change survives the cut; the rest is the
  // gap the viewer collapses.
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.startsWith(' ')) {
      return;
    }
    for (
      let near = Math.max(0, index - context);
      near <= Math.min(lines.length - 1, index + context);
      near++
    ) {
      keep[near] = true;
    }
  });

  const body: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!keep[index]) {
      continue;
    }
    const start = index;
    while (index + 1 < lines.length && keep[index + 1]) {
      index++;
    }
    const span = lines.slice(start, index + 1);
    const oldCount = span.filter((line) => !line.startsWith('+')).length;
    const newCount = span.filter((line) => !line.startsWith('-')).length;
    // A hunk that adds to one side without taking from the other starts at the
    // line before the insertion, which git spells as line zero at a file's top.
    const oldStart = oldCount === 0 ? oldNumbers[start]! - 1 : oldNumbers[start]!;
    const newStart = newCount === 0 ? newNumbers[start]! - 1 : newNumbers[start]!;
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...span);
  }

  return {
    patch: [...preamble, ...body].join('\n'),
    oldContent: oldLines.join('\n'),
    newContent: newLines.join('\n')
  };
}
