import assert from 'node:assert/strict'
import test from 'node:test'

import {
  constantTimeEquals,
  generatePassword,
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword
} from '../src/password.ts'

test('a password verifies against its own record and no other', async () => {
  // Small iteration count: the test proves the round trip, not the work factor.
  const record = await hashPassword('correct horse battery', 1_000)
  assert.equal(record.algorithm, 'pbkdf2-sha256')
  assert.equal(record.iterations, 1_000)
  assert.ok(await verifyPassword(record, 'correct horse battery'))
  assert.equal(await verifyPassword(record, 'wrong horse'), false)
  assert.equal(await verifyPassword(record, ''), false)
})

test('two records of the same password differ by salt', async () => {
  const first = await hashPassword('same password', 1_000)
  const second = await hashPassword('same password', 1_000)
  assert.notEqual(first.salt, second.salt)
  assert.notEqual(first.hash, second.hash)
})

test('generated passwords have the xxxxx-xxxxx-xxxxx-xxxxx shape', () => {
  for (let round = 0; round < 20; round += 1) {
    assert.match(generatePassword(), /^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/)
  }
  assert.notEqual(generatePassword(), generatePassword())
})

test('session tokens are url-safe and unique, and only their hash is stored', async () => {
  const token = generateSessionToken()
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/)
  assert.notEqual(token, generateSessionToken())
  const digest = await hashToken(token)
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(digest, await hashToken(token))
  assert.notEqual(digest, await hashToken(generateSessionToken()))
})

test('constant-time comparison is still a comparison', () => {
  assert.ok(constantTimeEquals('abc', 'abc'))
  assert.equal(constantTimeEquals('abc', 'abd'), false)
  assert.equal(constantTimeEquals('abc', 'ab'), false)
})
