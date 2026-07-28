import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildWorkspaceFile,
  buildWorkspaceListing,
  MAX_VIEWABLE_FILE_BYTES,
  normalizeWorkspaceRelativePath,
  parentPath,
  resolveWorkspacePath,
  workspaceDownloadBytes,
  workspaceDownloadDisposition,
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

test('recovers download bytes from either encoding', () => {
  const binary = workspaceDownloadBytes({
    path: 'logo.png',
    content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    encoding: 'base64',
  })
  assert.deepEqual([...binary], [0x89, 0x50, 0x4e, 0x47])

  const text = workspaceDownloadBytes({ path: 'a.txt', content: 'héllo', encoding: 'utf-8' })
  assert.equal(Buffer.from(text).toString('utf-8'), 'héllo')
})

test('names downloads after the file, with an escaped form when needed', () => {
  assert.equal(
    workspaceDownloadDisposition('src/logo.png'),
    'attachment; filename="logo.png"',
  )
  // Non-ASCII names keep an ASCII fallback and ride whole in filename*.
  assert.equal(
    workspaceDownloadDisposition('docs/说明.pdf'),
    `attachment; filename="__.pdf"; filename*=UTF-8''%E8%AF%B4%E6%98%8E.pdf`,
  )
  // A quote would end the quoted-string early, so it is replaced.
  assert.equal(
    workspaceDownloadDisposition('a"b.txt'),
    `attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`,
  )
})

test('caps text files and reports the cut', () => {
  const small = buildWorkspaceFile({ path: 'a.txt', content: 'héllo world' })
  assert.equal(small.binary, false)
  assert.equal(small.truncated, false)
  // Multi-byte characters count as bytes, not characters.
  assert.equal(small.size, Buffer.byteLength('héllo world'))

  const large = buildWorkspaceFile({
    path: 'big.txt',
    content: 'x'.repeat(MAX_VIEWABLE_FILE_BYTES + 100),
  })
  assert.equal(large.truncated, true)
  assert.equal(large.content.length, MAX_VIEWABLE_FILE_BYTES)
})
