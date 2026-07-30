import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimAttachmentUploads,
  handleUploadsApi,
  sweepOrphanUploads
} from '../src/api-uploads.ts'
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  attachmentUploadKey
} from '../src/sessions.ts'

/**
 * An in-memory stand-in for the R2 binding, covering exactly the surface the
 * uploads module touches: put/head/delete and a paged list.
 */
function fakeBucket() {
  const objects = new Map()
  return {
    objects,
    async put(key, bytes, options) {
      objects.set(key, {
        key,
        size: bytes.byteLength,
        uploaded: new Date(),
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata
      })
    },
    async head(key) {
      return objects.get(key) ?? null
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        objects.delete(key)
      }
    },
    async list({ prefix }) {
      return {
        objects: [...objects.values()].filter((object) =>
          object.key.startsWith(prefix)
        ),
        truncated: false
      }
    }
  }
}

const env = () => ({ SESSION_BUCKET: fakeBucket() })

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function pngBytes(size = 32) {
  const bytes = new Uint8Array(Math.max(size, PNG_HEADER.length))
  bytes.set(PNG_HEADER)
  return bytes
}

function uploadRequest(bytes, mime = 'image/png', filename = undefined) {
  return new Request('https://hub.test/api/uploads', {
    method: 'POST',
    headers: {
      'content-type': mime,
      ...(filename ? { 'x-upload-filename': filename } : {})
    },
    body: bytes
  })
}

// The Worker's outer router turns a thrown HttpError into the JSON error
// response; these tests call the handler directly, so the turn happens here.
async function upload(testEnv, bytes, mime, filename) {
  const url = new URL('https://hub.test/api/uploads')
  try {
    return await handleUploadsApi(
      uploadRequest(bytes, mime, filename),
      testEnv,
      url
    )
  } catch (error) {
    if (typeof error?.status === 'number') {
      return Response.json({ error: error.message }, { status: error.status })
    }
    throw error
  }
}

test('an upload lands in R2 under a mintable key', async () => {
  const testEnv = env()
  const response = await upload(testEnv, pngBytes(), 'image/png', 'shot.png')
  assert.equal(response.status, 201)
  const ref = await response.json()
  assert.match(ref.key, /^uploads\//)
  assert.equal(ref.mime, 'image/png')
  assert.equal(ref.filename, 'shot.png')
  assert.equal(ref.size, 32)
  assert.ok(testEnv.SESSION_BUCKET.objects.has(ref.key))
})

test('uploads must be images, non-empty and bounded', async () => {
  const testEnv = env()
  assert.equal((await upload(testEnv, pngBytes(), 'text/html')).status, 415)
  assert.equal(
    (await upload(testEnv, new Uint8Array(0), 'image/png')).status,
    400
  )
  assert.equal(
    (
      await upload(
        testEnv,
        pngBytes(MAX_SESSION_ATTACHMENT_BYTES + 1),
        'image/png'
      )
    ).status,
    413
  )
  assert.equal(testEnv.SESSION_BUCKET.objects.size, 0)
})

test('the declared type must agree with the leading bytes', async () => {
  const testEnv = env()
  // PNG bytes declared as JPEG: the declaration is the lie.
  assert.equal((await upload(testEnv, pngBytes(), 'image/jpeg')).status, 400)
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  assert.equal((await upload(testEnv, jpeg, 'image/jpeg')).status, 201)
  const gif = new TextEncoder().encode('GIF89a-and-so-on')
  assert.equal((await upload(testEnv, gif, 'image/gif')).status, 201)
  const webp = new Uint8Array(16)
  webp.set([0x52, 0x49, 0x46, 0x46])
  webp.set([0x57, 0x45, 0x42, 0x50], 8)
  assert.equal((await upload(testEnv, webp, 'image/webp')).status, 201)
})

test('deleting an upload removes the object', async () => {
  const testEnv = env()
  const ref = await (await upload(testEnv, pngBytes())).json()
  const id = ref.key.slice('uploads/'.length)
  const url = new URL(`https://hub.test/api/uploads/${id}`)
  const response = await handleUploadsApi(
    new Request(url, { method: 'DELETE' }),
    testEnv,
    url
  )
  assert.equal(response.status, 200)
  assert.equal(testEnv.SESSION_BUCKET.objects.size, 0)
})

test('claims resolve everything from storage, nothing from the client', async () => {
  const testEnv = env()
  const ref = await (
    await upload(testEnv, pngBytes(48), 'image/png', 'shot.png')
  ).json()
  const [claimed] = await claimAttachmentUploads(testEnv, [ref.key])
  assert.deepEqual(claimed, {
    key: ref.key,
    mime: 'image/png',
    filename: 'shot.png',
    size: 48
  })
})

test('claims refuse foreign keys and missing uploads', async () => {
  const testEnv = env()
  await assert.rejects(
    () => claimAttachmentUploads(testEnv, ['sessions/x/transcript']),
    /Invalid attachment/
  )
  await assert.rejects(
    () => claimAttachmentUploads(testEnv, [attachmentUploadKey(crypto.randomUUID())]),
    /no longer available/
  )
})

test('claims enforce the per-message total', async () => {
  const testEnv = env()
  // Three uploads that each pass the per-image cap but together exceed 10MB.
  const keys = []
  for (let i = 0; i < 3; i += 1) {
    const ref = await (
      await upload(testEnv, pngBytes(4 * 1024 * 1024), 'image/png')
    ).json()
    keys.push(ref.key)
  }
  await assert.rejects(
    () => claimAttachmentUploads(testEnv, keys),
    /total up to 10MB/
  )
  assert.equal((await claimAttachmentUploads(testEnv, keys.slice(0, 2))).length, 2)
})

test('the sweep removes only aged uploads, and only uploads', async () => {
  const testEnv = env()
  const fresh = await (await upload(testEnv, pngBytes())).json()
  const stale = await (await upload(testEnv, pngBytes())).json()
  testEnv.SESSION_BUCKET.objects.get(stale.key).uploaded = new Date(
    Date.now() - 8 * 24 * 60 * 60 * 1000
  )
  // A non-upload object must never be a candidate, whatever its age.
  testEnv.SESSION_BUCKET.objects.set('sessions/x/transcript', {
    key: 'sessions/x/transcript',
    size: 1,
    uploaded: new Date(0)
  })
  const deleted = await sweepOrphanUploads(testEnv)
  assert.equal(deleted, 1)
  assert.ok(testEnv.SESSION_BUCKET.objects.has(fresh.key))
  assert.ok(!testEnv.SESSION_BUCKET.objects.has(stale.key))
  assert.ok(testEnv.SESSION_BUCKET.objects.has('sessions/x/transcript'))
})
