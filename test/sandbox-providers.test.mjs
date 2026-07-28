import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isDockerProviderConfigured,
  listSessionProviders,
  readDockerProviderConfig,
  resolveLifecycleIdleTimeoutMs
} from '../src/sandbox-providers.ts'

/** Just enough D1 to answer `SELECT value FROM settings WHERE key = ?1`. */
const envWith = (settings) => ({
  DB: {
    prepare: () => ({
      bind: (key) => ({
        first: async () =>
          key in settings ? { value: JSON.stringify(settings[key]) } : null
      })
    })
  }
})

const configured = {
  'docker.agent-url': 'https://sandbox.example.com',
  'docker.agent-token': 'tok'
}

test('with nothing stored only cloudflare is on offer', async () => {
  const env = envWith({})
  assert.equal(await readDockerProviderConfig(env), undefined)
  assert.equal(await isDockerProviderConfigured(env), false)
  assert.deepEqual(await listSessionProviders(env), ['cloudflare'])
})

test('both halves of the agent address are needed', async () => {
  // A URL with no token would only ever get a 401 back.
  const urlOnly = envWith({ 'docker.agent-url': 'https://sandbox.example.com' })
  assert.equal(await isDockerProviderConfigured(urlOnly), false)
  const tokenOnly = envWith({ 'docker.agent-token': 'tok' })
  assert.equal(await isDockerProviderConfigured(tokenOnly), false)
  const blank = envWith({ ...configured, 'docker.agent-token': '   ' })
  assert.equal(await isDockerProviderConfigured(blank), false)
})

test('a configured agent adds docker, defaulting the image', async () => {
  const env = envWith(configured)
  assert.deepEqual(await readDockerProviderConfig(env), {
    baseUrl: 'https://sandbox.example.com',
    token: 'tok',
    image: 'opencode-session:latest'
  })
  assert.deepEqual(await listSessionProviders(env), ['docker', 'cloudflare'])
})

test('the base URL loses its trailing slashes, the image is taken as stored', async () => {
  const env = envWith({
    ...configured,
    'docker.agent-url': 'https://sandbox.example.com/',
    'docker.image': 'ghcr.io/acme/opencode-session:v1'
  })
  const config = await readDockerProviderConfig(env)
  assert.equal(config.baseUrl, 'https://sandbox.example.com')
  assert.equal(config.image, 'ghcr.io/acme/opencode-session:v1')
})

test('cloudflare idle timeout stays at ten minutes', async () => {
  const env = envWith({ 'docker.idle-timeout-minutes': 60 })
  assert.equal(await resolveLifecycleIdleTimeoutMs(env, 'cloudflare'), 10 * 60_000)
})

test('docker idle timeout defaults to thirty minutes and accepts the setting', async () => {
  assert.equal(
    await resolveLifecycleIdleTimeoutMs(envWith({}), 'docker'),
    30 * 60_000
  )
  assert.equal(
    await resolveLifecycleIdleTimeoutMs(
      envWith({ 'docker.idle-timeout-minutes': 45 }),
      'docker'
    ),
    45 * 60_000
  )
  // Out-of-range stored values fall back rather than poison the deadline.
  assert.equal(
    await resolveLifecycleIdleTimeoutMs(
      envWith({ 'docker.idle-timeout-minutes': 0 }),
      'docker'
    ),
    30 * 60_000
  )
})
