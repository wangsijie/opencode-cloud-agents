/**
 * What the file viewer can show inline beyond text.
 *
 * The Hub classifies a file as "valid UTF-8 or not" and nothing else — no MIME
 * sniffing anywhere on the path — so the decision of what an image is belongs
 * here, on the name, where it costs no round trip. Getting it wrong is cheap in
 * both directions: a misnamed image renders as text or falls back to the
 * download button, and neither loses the file.
 */

/** Extension → MIME, for the formats a browser renders in an `<img>`. */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  apng: 'image/apng',
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp'
};

/**
 * The ceiling on an inline preview.
 *
 * The bytes cross the wire as an attachment and then live in memory as a blob,
 * so a 200 MB render is a tab that dies rather than a picture. Past this the
 * viewer offers the download it already had.
 */
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;

/** The image MIME a path's extension names, or undefined if it names none. */
export function imageMimeForPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()];
}

/** Whether this read should be rendered as a picture rather than as source. */
export function isPreviewableImage(file: {
  path: string;
  size: number;
  truncated: boolean;
}): boolean {
  return (
    imageMimeForPath(file.path) !== undefined &&
    // A truncated read is half a file: as text that is still readable, as an
    // image it is a broken one.
    !file.truncated &&
    file.size <= MAX_INLINE_IMAGE_BYTES
  );
}
