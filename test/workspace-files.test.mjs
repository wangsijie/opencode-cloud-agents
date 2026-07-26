import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkspaceFile,
  buildWorkspaceListing,
  MAX_VIEWABLE_FILE_BYTES,
  normalizeWorkspaceRelativePath,
  parentPath,
  resolveWorkspacePath,
} from '../src/workspace-files.ts'

test('normalizes browser-supplied paths to a relative form', () => {
  assert.equal(normalizeWorkspaceRelativePath(undefined), '')
  assert.equal(normalizeWorkspaceRelativePath(''), '')
  assert.equal(normalizeWorkspaceRelativePath('src/index.ts'), 'src/index.ts')
  assert.equal(normalizeWorkspaceRelativePath('/src//index.ts'), 'src/index.ts')
  assert.equal(normalizeWorkspaceRelativePath('./src/./index.ts'), 'src/index.ts')
  // A dotted name is not a traversal: only a whole `..` segment is.
  assert.equal(normalizeWorkspaceRelativePath('..config/env'), '..config/env')
})

test('refuses paths that leave the checkout', () => {
  for (const value of ['..', '../etc/passwd', 'src/../../etc', 'a/../../b']) {
    assert.throws(() => normalizeWorkspaceRelativePath(value), /escapes the workspace/)
  }
  assert.throws(() => normalizeWorkspaceRelativePath('src/\0/x'), /Invalid path/)
  assert.throws(() => normalizeWorkspaceRelativePath(42), /Invalid path/)
  assert.throws(() => normalizeWorkspaceRelativePath('a'.repeat(5000)), /Invalid path/)
})

test('resolves against the session checkout', () => {
  assert.equal(resolveWorkspacePath('/workspace/cloud'), '/workspace/cloud')
  assert.equal(resolveWorkspacePath('/workspace/cloud', ''), '/workspace/cloud')
  assert.equal(
    resolveWorkspacePath('/workspace/cloud', 'src/index.ts'),
    '/workspace/cloud/src/index.ts',
  )
})

test('lists directories first, drops .git, and reports the parent', () => {
  const listing = buildWorkspaceListing('src', [
    { name: 'index.ts', type: 'file', size: 10, modifiedAt: '2026-07-26T00:00:00.000Z' },
    { name: 'components', type: 'directory', size: 0 },
    { name: '.git', type: 'directory', size: 0 },
    { name: 'App.tsx', type: 'file', size: 20 },
  ])
  assert.equal(listing.path, 'src')
  assert.equal(listing.parent, '')
  assert.equal(listing.truncated, false)
  assert.deepEqual(
    listing.entries.map((entry) => entry.name),
    ['components', 'App.tsx', 'index.ts'],
  )
  assert.deepEqual(
    listing.entries.map((entry) => entry.path),
    ['src/components', 'src/App.tsx', 'src/index.ts'],
  )
})

test('the checkout root has no parent', () => {
  const listing = buildWorkspaceListing('', [{ name: 'src', type: 'directory', size: 0 }])
  assert.equal('parent' in listing, false)
  assert.equal(listing.entries[0].path, 'src')
  assert.equal(parentPath('a/b/c'), 'a/b')
  assert.equal(parentPath('a'), '')
})

test('truncates oversized directories rather than refusing them', () => {
  const files = Array.from({ length: 2100 }, (_, index) => ({
    name: `f${String(index).padStart(5, '0')}`,
    type: 'file',
    size: 1,
  }))
  const listing = buildWorkspaceListing('', files)
  assert.equal(listing.entries.length, 2000)
  assert.equal(listing.truncated, true)
})

test('describes binary files instead of rendering them', () => {
  const file = buildWorkspaceFile({
    path: 'logo.png',
    content: 'AAAABBBB',
    encoding: 'base64',
  })
  assert.equal(file.binary, true)
  assert.equal(file.content, undefined)
  assert.equal(file.size, 6)
})

test('caps text files and reports the cut', () => {
  const small = buildWorkspaceFile({ path: 'a.txt', content: '你好 world' })
  assert.equal(small.binary, false)
  assert.equal(small.truncated, false)
  // Multi-byte characters count as bytes, not characters.
  assert.equal(small.size, Buffer.byteLength('你好 world'))

  const large = buildWorkspaceFile({
    path: 'big.txt',
    content: 'x'.repeat(MAX_VIEWABLE_FILE_BYTES + 100),
  })
  assert.equal(large.truncated, true)
  assert.equal(large.content.length, MAX_VIEWABLE_FILE_BYTES)
})
