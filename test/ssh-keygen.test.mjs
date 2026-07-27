import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { assembleKeyPair, generateSshKeyPair } from '../src/ssh-keygen.ts'

const readUint32 = (bytes, offset) =>
  (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]

const readString = (bytes, offset) => {
  const length = readUint32(bytes, offset)
  return {
    value: bytes.subarray(offset + 4, offset + 4 + length),
    next: offset + 4 + length
  }
}

test('assembleKeyPair emits the openssh-key-v1 container, deterministically', () => {
  const publicKey = new Uint8Array(32).fill(7)
  const seed = new Uint8Array(32).fill(3)
  const pair = assembleKeyPair(publicKey, seed, 'opencode-cloud', 0xdeadbeef)
  const again = assembleKeyPair(publicKey, seed, 'opencode-cloud', 0xdeadbeef)
  assert.deepEqual(pair, again)

  assert.match(pair.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ opencode-cloud$/)
  assert.ok(pair.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n'))
  assert.ok(pair.privateKey.endsWith('-----END OPENSSH PRIVATE KEY-----\n'))

  // The public line's blob is `string "ssh-ed25519" || string key`.
  const publicBlob = Buffer.from(pair.publicKey.split(' ')[1], 'base64')
  const type = readString(publicBlob, 0)
  assert.equal(Buffer.from(type.value).toString(), 'ssh-ed25519')
  const key = readString(publicBlob, type.next)
  assert.deepEqual(new Uint8Array(key.value), publicKey)

  // Walk the private container: magic, "none" cipher and kdf, one key, the
  // same public blob, then the padded private section carrying the checkint
  // twice and the 64-byte seed||public pair.
  const container = Buffer.from(
    pair.privateKey
      .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
      .replace('-----END OPENSSH PRIVATE KEY-----', '')
      .replaceAll('\n', ''),
    'base64'
  )
  const magic = Buffer.from('openssh-key-v1\0')
  assert.deepEqual(container.subarray(0, magic.length), magic)
  let offset = magic.length
  const cipher = readString(container, offset)
  assert.equal(Buffer.from(cipher.value).toString(), 'none')
  const kdf = readString(container, cipher.next)
  assert.equal(Buffer.from(kdf.value).toString(), 'none')
  const kdfOptions = readString(container, kdf.next)
  assert.equal(kdfOptions.value.length, 0)
  assert.equal(readUint32(container, kdfOptions.next), 1)
  const embeddedPublic = readString(container, kdfOptions.next + 4)
  assert.deepEqual(Buffer.from(embeddedPublic.value), publicBlob)

  const privateSection = readString(container, embeddedPublic.next)
  assert.equal(privateSection.next, container.length)
  assert.equal(privateSection.value.length % 8, 0)
  const body = privateSection.value
  assert.equal(readUint32(body, 0) >>> 0, 0xdeadbeef)
  assert.equal(readUint32(body, 4) >>> 0, 0xdeadbeef)
  const bodyType = readString(body, 8)
  assert.equal(Buffer.from(bodyType.value).toString(), 'ssh-ed25519')
  const bodyPublic = readString(body, bodyType.next)
  assert.deepEqual(new Uint8Array(bodyPublic.value), publicKey)
  const bodyPrivate = readString(body, bodyPublic.next)
  assert.equal(bodyPrivate.value.length, 64)
  assert.deepEqual(new Uint8Array(bodyPrivate.value.subarray(0, 32)), seed)
  assert.deepEqual(new Uint8Array(bodyPrivate.value.subarray(32)), publicKey)
  const comment = readString(body, bodyPrivate.next)
  assert.equal(Buffer.from(comment.value).toString(), 'opencode-cloud')
})

test('rejects byte lengths that are not an Ed25519 pair', () => {
  assert.throws(() => assembleKeyPair(new Uint8Array(31), new Uint8Array(32), 'c', 1))
  assert.throws(() => assembleKeyPair(new Uint8Array(32), new Uint8Array(33), 'c', 1))
})

test('generateSshKeyPair produces a pair whose halves agree', async () => {
  const pair = await generateSshKeyPair()
  assert.match(pair.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ opencode-cloud$/)
  // The private container embeds the same public blob the public line carries.
  const container = Buffer.from(
    pair.privateKey
      .replace('-----BEGIN OPENSSH PRIVATE KEY-----', '')
      .replace('-----END OPENSSH PRIVATE KEY-----', '')
      .replaceAll('\n', ''),
    'base64'
  )
  const publicBlob = pair.publicKey.split(' ')[1]
  assert.ok(container.toString('base64').length > 0)
  assert.ok(
    container.includes(Buffer.from(publicBlob, 'base64')),
    'the private container must embed the public key blob'
  )
})
