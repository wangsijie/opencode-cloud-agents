/**
 * Image uploads: the one part of a message that becomes durable before the
 * message does.
 *
 * The composer uploads each image as it is picked or pasted, while the user is
 * still typing, and sends only the resulting keys. That is what keeps sending a
 * message — and creating a session — a small request with a single point of
 * failure: by the time Enter is pressed the bytes are already in R2, so a
 * dropped connection can no longer take a 10MB body and a half-made session
 * with it. It also puts the failure where the user can act on it, on the chip
 * for that one image, instead of on a send that has to be repeated in full.
 *
 * Uploads are keyed by an id of their own rather than by session, because
 * neither the session nor the prompt exists yet when they arrive. Three things
 * reclaim them: the dispatch path deletes an image once its prompt has been
 * delivered, deleting a session deletes what its queue still holds, and the
 * daily sweep here removes what nobody ever sent.
 */
import { HttpError, json, methodNotAllowed } from './http.ts';
import {
  attachmentUploadKey,
  CLEANUP_IDLE_DAYS,
  isAttachmentUploadKey,
  isSessionAttachmentMime,
  MAX_SESSION_ATTACHMENTS,
  MAX_SESSION_ATTACHMENT_BYTES,
  MAX_SESSION_ATTACHMENT_TOTAL_BYTES,
  normalizeAttachmentFilename,
  UPLOADS_PREFIX,
  type SessionAttachmentRef
} from './sessions.ts';

/** Carries the original filename, which R2 has nowhere else to put. */
const FILENAME_HEADER = 'x-upload-filename';

/**
 * How long an unsent upload is kept.
 *
 * The same window the idle sweep uses, and for the same reason: a prompt that
 * has been sitting undelivered for a week belongs to a session nobody came back
 * to. Its images going away is not a loss anyone will notice, and keeping them
 * for ever would mean every abandoned draft is permanent.
 */
const ORPHAN_UPLOAD_TTL_MS = CLEANUP_IDLE_DAYS * 24 * 60 * 60 * 1000;

export async function handleUploadsApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  if (url.pathname === '/api/uploads') {
    if (request.method === 'POST') {
      return await createUpload(request, env);
    }
    return methodNotAllowed('POST');
  }

  const match = /^\/api\/uploads\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'Upload API route not found');
  }
  if (request.method !== 'DELETE') {
    return methodNotAllowed('DELETE');
  }
  return await deleteUpload(env, match[1]);
}

/**
 * Take one image.
 *
 * The bytes arrive as the raw body: base64 in JSON would inflate every image by
 * a third and then have to be decoded a byte at a time. Nothing the client says
 * about the image is taken on trust — the size is what actually arrived, and the
 * declared type has to agree with the first few bytes, so a key can never come
 * to name something that is not the image it claims to be.
 */
async function createUpload(request: Request, env: Env): Promise<Response> {
  const mime = (request.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!isSessionAttachmentMime(mime)) {
    throw new HttpError(
      415,
      'Attachments must be a png, jpeg, webp or gif image'
    );
  }
  // Read before measuring: `Content-Length` is the client's claim, and a body
  // this size is well inside a Worker's memory either way.
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new HttpError(400, 'The image is empty');
  }
  if (bytes.byteLength > MAX_SESSION_ATTACHMENT_BYTES) {
    throw new HttpError(413, 'Each image can be up to 5MB');
  }
  if (!looksLikeImage(mime, bytes)) {
    throw new HttpError(400, `The file is not a valid ${mime} image`);
  }

  const filename = normalizeAttachmentFilename(
    request.headers.get(FILENAME_HEADER)
  );
  const key = attachmentUploadKey(crypto.randomUUID());
  await env.SESSION_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: mime },
    ...(filename ? { customMetadata: { filename } } : {})
  });
  const ref: SessionAttachmentRef = {
    key,
    mime,
    ...(filename ? { filename } : {}),
    size: bytes.byteLength
  };
  return json(ref, 201);
}

/**
 * Drop an upload the user removed from the composer.
 *
 * Best-effort by design: the client fires this and moves on, and the sweep is
 * what makes it unnecessary to have worked.
 */
async function deleteUpload(env: Env, uploadId: string): Promise<Response> {
  const key = attachmentUploadKey(uploadId);
  if (!isAttachmentUploadKey(key)) {
    throw new HttpError(400, 'Invalid upload id');
  }
  await env.SESSION_BUCKET.delete(key);
  return json({ deleted: true });
}

/**
 * Turn the keys a client submitted into attachment references.
 *
 * The client is the wrong source for everything except which uploads it means:
 * the key shape is checked so it cannot name anything else in the bucket, and
 * the type, size and filename are read back from R2. This is also where the
 * per-message limits land — an individual upload was checked when it arrived,
 * but only a claim knows how many are being sent together.
 */
export async function claimAttachmentUploads(
  env: Env,
  keys: string[]
): Promise<SessionAttachmentRef[]> {
  if (keys.length > MAX_SESSION_ATTACHMENTS) {
    throw new HttpError(400, 'Up to 4 images per message');
  }
  const refs: SessionAttachmentRef[] = [];
  let totalBytes = 0;
  for (const key of keys) {
    if (!isAttachmentUploadKey(key)) {
      throw new HttpError(400, 'Invalid attachment');
    }
    const object = await env.SESSION_BUCKET.head(key);
    if (!object) {
      // Either it was never uploaded, or it has already been sent and deleted.
      throw new HttpError(
        400,
        'One of the attached images is no longer available; attach it again'
      );
    }
    const mime = object.httpMetadata?.contentType;
    if (!isSessionAttachmentMime(mime)) {
      throw new HttpError(400, 'Invalid attachment');
    }
    totalBytes += object.size;
    if (
      object.size > MAX_SESSION_ATTACHMENT_BYTES ||
      totalBytes > MAX_SESSION_ATTACHMENT_TOTAL_BYTES
    ) {
      throw new HttpError(400, 'Images can total up to 10MB per message');
    }
    const filename = normalizeAttachmentFilename(
      object.customMetadata?.filename
    );
    refs.push({
      key,
      mime,
      ...(filename ? { filename } : {}),
      size: object.size
    });
  }
  return refs;
}

/**
 * Remove uploads nobody sent.
 *
 * Runs on the daily cron next to the idle-session sweep. Deleting by age is
 * safe because an upload's whole life is short: it is either attached to a
 * prompt and deleted on delivery, or it was picked in a composer that was
 * closed.
 */
export async function sweepOrphanUploads(
  env: Env,
  now = new Date()
): Promise<number> {
  const cutoff = now.getTime() - ORPHAN_UPLOAD_TTL_MS;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await env.SESSION_BUCKET.list({
      prefix: UPLOADS_PREFIX,
      ...(cursor ? { cursor } : {})
    });
    const stale = page.objects
      .filter((object) => object.uploaded.getTime() < cutoff)
      .map((object) => object.key);
    if (stale.length > 0) {
      await env.SESSION_BUCKET.delete(stale);
      deleted += stale.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

/**
 * Whether the bytes start the way the declared type promises.
 *
 * Only the container's model ever looks at these, so this is not a decoder — it
 * is the cheap check that an upload is the kind of thing it says it is.
 */
function looksLikeImage(mime: string, bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  switch (mime) {
    case 'image/png':
      return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return starts(0xff, 0xd8, 0xff);
    case 'image/gif':
      return starts(0x47, 0x49, 0x46, 0x38);
    case 'image/webp':
      // "RIFF" ... "WEBP": the form type sits after the 4-byte length.
      return (
        starts(0x52, 0x49, 0x46, 0x46) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}
