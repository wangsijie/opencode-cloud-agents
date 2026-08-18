import assert from 'node:assert/strict'
import test from 'node:test'

import {
  imageMimeForPath,
  isPreviewableImage,
  MAX_INLINE_IMAGE_BYTES
} from '../web/src/file-preview.ts'

const file = (path, overrides = {}) => ({
  path,
  size: 1024,
  truncated: false,
  ...overrides
})

test('an image extension names the MIME an <img> needs', () => {
  assert.equal(imageMimeForPath('web/assets/logo.png'), 'image/png')
  assert.equal(imageMimeForPath('shot.JPG'), 'image/jpeg')
  assert.equal(imageMimeForPath('a/b/icon.svg'), 'image/svg+xml')
  assert.equal(imageMimeForPath('anim.webp'), 'image/webp')
})

test('anything else names none', () => {
  assert.equal(imageMimeForPath('src/index.ts'), undefined)
  assert.equal(imageMimeForPath('README'), undefined)
  assert.equal(imageMimeForPath('archive.tar.gz'), undefined)
  // A dotfile is not an extension: `.png` is the whole name.
  assert.equal(imageMimeForPath('.png'), undefined)
  // The directory's extension is not the file's.
  assert.equal(imageMimeForPath('assets.png/notes.txt'), undefined)
})

test('a picture is previewed whether the read called it binary or not', () => {
  // PNG: binary, no content in the read.
  assert.equal(isPreviewableImage(file('logo.png')), true)
  // SVG: text, content already in hand.
  assert.equal(isPreviewableImage(file('icon.svg')), true)
})

test('a capped read is half a file, so it is not rendered as one', () => {
  assert.equal(isPreviewableImage(file('icon.svg', { truncated: true })), false)
})

test('a huge image falls back to the download it already had', () => {
  assert.equal(
    isPreviewableImage(file('poster.png', { size: MAX_INLINE_IMAGE_BYTES })),
    true
  )
  assert.equal(
    isPreviewableImage(file('poster.png', { size: MAX_INLINE_IMAGE_BYTES + 1 })),
    false
  )
})

test('source is never rendered as a picture', () => {
  assert.equal(isPreviewableImage(file('src/index.ts')), false)
})
