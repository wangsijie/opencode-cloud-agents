import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listDockerHosts,
  listSessionProviderOptions,
  listSessionProviders,
  resolveDockerHost,
  resolveLifecycleIdleTimeoutMs
} from '../src/sandbox-providers.ts'
import { createSettingsEnv } from './helpers/d1.mjs'

/**
 * A real database with these settings stored. This used to be a stub that
 * answered one hand-written SELECT; it is a migrated SQLite database now, so
 * the query the code actually issues is the one under test.
 */
const envWith = (settings) => createSettingsEnv(settings)

const mini = {
  id: 'mini',
  label: 'Mac mini',
  baseUrl: 'https://sandbox.example.com',
  token: 'tok'
}

const configured = { 'docker.hosts': [mini] }

test('with nothing stored only cloudflare is on offer', async () => {
  const env = envWith({})
  assert.deepEqual(await listDockerHosts(env), [])
  assert.deepEqual(await listSessionProviders(env), ['cloudflare'])
  assert.equal(await resolveDockerHost(env, 'docker'), undefined)
})

test('both halves of the agent address are needed', async () => {
  // A URL with no token would only ever get a 401 back, so the entry is
  // dropped rather than offered.
  const urlOnly = envWith({ 'docker.hosts': [{ id: 'mini', baseUrl: mini.baseUrl }] })
  assert.deepEqual(await listDockerHosts(urlOnly), [])
  const tokenOnly = envWith({ 'docker.hosts': [{ id: 'mini', token: 'tok' }] })
  assert.deepEqual(await listDockerHosts(tokenOnly), [])
  const blank = envWith({ 'docker.hosts': [{ ...mini, token: '   ' }] })
  assert.deepEqual(await listDockerHosts(blank), [])
})

test('a configured host adds its provider, defaulting image and timeout', async () => {
  const env = envWith(configured)
  assert.deepEqual(await listDockerHosts(env), [
    {
      id: 'mini',
      provider: 'docker:mini',
      label: 'Mac mini',
      baseUrl: 'https://sandbox.example.com',
      token: 'tok',
      image: 'opencode-session:latest',
      idleTimeoutMinutes: 30
    }
  ])
  assert.deepEqual(await listSessionProviders(env), ['docker:mini', 'cloudflare'])
})

test('every host is offered, in stored order, named', async () => {
  const env = envWith({
    'docker.hosts': [
      mini,
      { id: 'shop', baseUrl: 'https://shop.example.com', token: 'tok2' }
    ]
  })
  // Stored order is preference order: the first host is where a session with
  // no explicit provider lands.
  assert.deepEqual(await listSessionProviders(env), [
    'docker:mini',
    'docker:shop',
    'cloudflare'
  ])
  // A host with no label falls back to its id rather than a bare "Docker",
  // which would be indistinguishable from the others in a picker.
  assert.deepEqual(await listSessionProviderOptions(env), [
    { provider: 'docker:mini', label: 'Mac mini' },
    { provider: 'docker:shop', label: 'shop' },
    { provider: 'cloudflare', label: 'Cloudflare' }
  ])
})

test('a duplicate id is dropped rather than shadowing the first', async () => {
  const env = envWith({
    'docker.hosts': [mini, { ...mini, baseUrl: 'https://other.example.com' }]
  })
  const hosts = await listDockerHosts(env)
  assert.equal(hosts.length, 1)
  assert.equal(hosts[0].baseUrl, 'https://sandbox.example.com')
})

test('the provider names which host; bare docker means the first', async () => {
  const env = envWith({
    'docker.hosts': [
      mini,
      { id: 'shop', baseUrl: 'https://shop.example.com', token: 'tok2' }
    ]
  })
  assert.equal((await resolveDockerHost(env, 'docker:shop')).id, 'shop')
  // The pre-multi-host spelling, still on every session created then.
  assert.equal((await resolveDockerHost(env, 'docker')).id, 'mini')
  // A host that left settings resolves to nothing, which is what the wake
  // reports as "not configured".
  assert.equal(await resolveDockerHost(env, 'docker:gone'), undefined)
  assert.equal(await resolveDockerHost(env, 'cloudflare'), undefined)
})

test('the base URL loses its trailing slashes, the image is taken as stored', async () => {
  const env = envWith({
    'docker.hosts': [
      {
        ...mini,
        baseUrl: 'https://sandbox.example.com/',
        image: 'ghcr.io/acme/opencode-session:v1'
      }
    ]
  })
  const [host] = await listDockerHosts(env)
  assert.equal(host.baseUrl, 'https://sandbox.example.com')
  assert.equal(host.image, 'ghcr.io/acme/opencode-session:v1')
})

test('cloudflare idle timeout stays at ten minutes', async () => {
  const env = envWith({ 'docker.hosts': [{ ...mini, idleTimeoutMinutes: 60 }] })
  assert.equal(await resolveLifecycleIdleTimeoutMs(env, 'cloudflare'), 10 * 60_000)
})

test('each docker host carries its own idle timeout, defaulting to thirty', async () => {
  assert.equal(
    await resolveLifecycleIdleTimeoutMs(envWith(configured), 'docker:mini'),
    30 * 60_000
  )
  const env = envWith({
    'docker.hosts': [
      { ...mini, idleTimeoutMinutes: 45 },
      { id: 'shop', baseUrl: 'https://shop.example.com', token: 'tok2' }
    ]
  })
  assert.equal(await resolveLifecycleIdleTimeoutMs(env, 'docker:mini'), 45 * 60_000)
  assert.equal(await resolveLifecycleIdleTimeoutMs(env, 'docker:shop'), 30 * 60_000)
  // Out-of-range stored values fall back rather than poison the deadline.
  assert.equal(
    await resolveLifecycleIdleTimeoutMs(
      envWith({ 'docker.hosts': [{ ...mini, idleTimeoutMinutes: 0 }] }),
      'docker:mini'
    ),
    30 * 60_000
  )
  // A deadline for a host that is gone is still a deadline; the wake is where
  // the missing host is reported.
  assert.equal(
    await resolveLifecycleIdleTimeoutMs(envWith(configured), 'docker:gone'),
    30 * 60_000
  )
})
