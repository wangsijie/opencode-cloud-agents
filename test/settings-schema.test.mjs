import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REQUIRED_PERMISSION_KEYS,
  SETTING_DESCRIPTORS,
  findDescriptor,
  validateOpencodeConfig
} from '../src/settings-schema.ts'

const validConfig = () => ({
  model: 'acme/ag/model-a',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    doom_loop: 'allow',
    external_directory: 'allow',
    task: 'allow'
  },
  provider: {
    acme: {
      name: 'Acme',
      options: { apiKey: 'k', baseURL: 'https://example.com/v1' },
      models: {
        'ag/model-a': { name: 'Model A' }
      }
    }
  }
})

test('a complete config passes with no errors', () => {
  const result = validateOpencodeConfig(validConfig())
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.warnings, [])
  assert.ok(result.config)
})

test('every permission must be decided, because nothing can answer an ask', () => {
  // The historical guarantee from the hardcoded config, now enforced at write
  // time: an omitted permission evaluates to `ask` and the session hangs.
  for (const key of REQUIRED_PERMISSION_KEYS) {
    const config = validConfig()
    delete config.permission[key]
    const result = validateOpencodeConfig(config)
    assert.equal(result.config, undefined)
    assert.ok(
      result.errors.some((error) => error.includes(`permission.${key}`)),
      `expected an error about permission.${key}`
    )
  }
})

test('the default model must resolve against the provider map', () => {
  const missing = { ...validConfig(), model: 'acme/nope' }
  assert.ok(
    validateOpencodeConfig(missing).errors.some((error) => error.includes('acme/nope'))
  )
  const unparseable = { ...validConfig(), model: 'no-slash' }
  assert.ok(validateOpencodeConfig(unparseable).errors.length > 0)
})

test('non-objects and empty provider maps are rejected', () => {
  assert.ok(validateOpencodeConfig('[]').errors.length > 0)
  assert.ok(validateOpencodeConfig(null).errors.length > 0)
  assert.ok(
    validateOpencodeConfig({ ...validConfig(), provider: {} }).errors.length > 0
  )
})

test('attachment models without image input modalities warn but store', () => {
  const config = validConfig()
  config.provider.acme.models['ag/model-a'].attachment = true
  const result = validateOpencodeConfig(config)
  assert.ok(result.config)
  assert.ok(result.warnings.some((warning) => warning.includes('modalities.input')))

  config.provider.acme.models['ag/model-a'].modalities = { input: ['text', 'image'] }
  assert.deepEqual(validateOpencodeConfig(config).warnings, [])
})

test('a default provider without an apiKey warns', () => {
  const config = validConfig()
  delete config.provider.acme.options.apiKey
  const result = validateOpencodeConfig(config)
  assert.ok(result.config)
  assert.ok(result.warnings.some((warning) => warning.includes('apiKey')))
})

test('skill names are path segments, listed once', () => {
  const skills = findDescriptor('opencode.skills')
  assert.deepEqual(skills.validate([{ name: 'babysit', content: '# doc' }]), [])
  assert.ok(skills.validate([{ name: '../escape', content: 'x' }]).length > 0)
  assert.ok(skills.validate([{ name: 'UPPER', content: 'x' }]).length > 0)
  assert.ok(skills.validate([{ name: 'ok', content: '  ' }]).length > 0)
  assert.ok(
    skills
      .validate([
        { name: 'twice', content: 'a' },
        { name: 'twice', content: 'b' }
      ])
      .some((error) => error.includes('twice'))
  )
})

test('a skill may be scoped to a repository, once per scope', () => {
  const skills = findDescriptor('opencode.skills')
  assert.deepEqual(
    skills.validate([
      { name: 'deploy', content: '# doc', repoKey: 'opencode-cloud' },
      { name: 'deploy', content: '# doc', repoKey: 'webapp' }
    ]),
    []
  )
  // Repo keys follow the catalog's constraints.
  assert.ok(
    skills.validate([{ name: 'ok', content: 'x', repoKey: '../escape' }]).length > 0
  )
  // The same name for the same repo is a duplicate.
  assert.ok(
    skills
      .validate([
        { name: 'deploy', content: 'a', repoKey: 'webapp' },
        { name: 'deploy', content: 'b', repoKey: 'webapp' }
      ])
      .some((error) => error.includes('twice'))
  )
  // A global and a per-repo entry of the same name would shadow one another.
  assert.ok(
    skills
      .validate([
        { name: 'deploy', content: 'a' },
        { name: 'deploy', content: 'b', repoKey: 'webapp' }
      ])
      .some((error) => error.includes('collide'))
  )
})

test('env names are POSIX', () => {
  const env = findDescriptor('container.env')
  assert.deepEqual(env.validate([{ name: 'CLOUDFLARE_API_TOKEN', value: 't' }]), [])
  assert.ok(env.validate([{ name: '1BAD', value: 'x' }]).length > 0)
  assert.ok(env.validate([{ name: 'EMPTY', value: '' }]).length > 0)
  assert.ok(
    env
      .validate([
        { name: 'DUP', value: 'a' },
        { name: 'DUP', value: 'b' }
      ])
      .some((error) => error.includes('twice'))
  )
})

test('git identity overrides need a valid owner, no duplicates, and full identities', () => {
  const identity = findDescriptor('git.identity')
  assert.deepEqual(identity.validate({ name: 'Op', email: 'op@example.com' }), [])
  assert.deepEqual(
    identity.validate({
      name: 'Op',
      email: 'op@example.com',
      overrides: [{ owner: 'acme-labs', name: 'Work', email: 'work@example.com' }]
    }),
    []
  )
  assert.ok(
    identity.validate({ name: 'Op', email: 'op@example.com', overrides: 'nope' })
      .length > 0
  )
  assert.ok(
    identity
      .validate({
        name: 'Op',
        email: 'op@example.com',
        overrides: [{ owner: 'bad owner!', name: 'Work', email: 'work@example.com' }]
      })
      .some((error) => error.includes('organization name'))
  )
  // Owners are GitHub's, so a duplicate differing only in case is a duplicate.
  assert.ok(
    identity
      .validate({
        name: 'Op',
        email: 'op@example.com',
        overrides: [
          { owner: 'acme', name: 'A', email: 'a@example.com' },
          { owner: 'ACME', name: 'B', email: 'b@example.com' }
        ]
      })
      .some((error) => error.includes('two overrides'))
  )
  assert.ok(
    identity
      .validate({
        name: 'Op',
        email: 'op@example.com',
        overrides: [{ owner: 'acme', name: '', email: 'not-an-email' }]
      })
      .length >= 2
  )
})

test('the AGENTS.md setting wants safe repo keys, no duplicates, and real content', () => {
  const agentsMd = findDescriptor('opencode.agents-md')
  assert.deepEqual(agentsMd.validate({ global: '# Rules' }), [])
  assert.deepEqual(
    agentsMd.validate({ repos: [{ repoKey: 'opencode-cloud', content: 'Use pnpm.' }] }),
    []
  )
  assert.deepEqual(
    agentsMd.validate({
      global: '# Rules',
      repos: [{ repoKey: 'opencode-cloud', content: 'Use pnpm.' }]
    }),
    []
  )
  // Repo keys become container paths, so the same constraint applies here.
  assert.ok(
    agentsMd
      .validate({ repos: [{ repoKey: '../escape', content: 'x' }] })
      .some((error) => error.includes('repository key'))
  )
  assert.ok(
    agentsMd
      .validate({
        repos: [
          { repoKey: 'twice', content: 'a' },
          { repoKey: 'twice', content: 'b' }
        ]
      })
      .some((error) => error.includes('two entries'))
  )
  assert.ok(
    agentsMd
      .validate({ repos: [{ repoKey: 'opencode-cloud', content: '  ' }] })
      .some((error) => error.includes('no content'))
  )
  // Nothing to store: the UI clears the setting instead.
  assert.ok(agentsMd.validate({}).length > 0)
  assert.ok(agentsMd.validate({ global: '   ' }).length > 0)
  assert.ok(agentsMd.validate('nope').length > 0)
  assert.ok(agentsMd.validate({ repos: 'nope' }).length > 0)
})

test('the ssh key descriptor wants an OpenSSH pair', () => {
  const ssh = findDescriptor('container.ssh-key')
  assert.deepEqual(
    ssh.validate({
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
      publicKey: 'ssh-ed25519 AAAAC3 comment'
    }),
    []
  )
  assert.ok(ssh.validate({ privateKey: 'not a key', publicKey: 'nope' }).length > 0)
  assert.ok(ssh.validate('string').length > 0)
})

const host = (overrides = {}) => ({
  id: 'mini',
  baseUrl: 'https://sandbox.example.com',
  token: 's3cret-token',
  ...overrides
})

const hosts = () => findDescriptor('docker.hosts')

test('a docker host needs an id, an https origin and a token', () => {
  assert.deepEqual(hosts().validate([host()]), [])
  assert.deepEqual(
    hosts().validate([host({ label: 'Mac mini', image: 'ghcr.io/acme/s:v1', idleTimeoutMinutes: 90 })]),
    []
  )
  // Both halves of the address, or the agent would only ever 401.
  assert.ok(hosts().validate([host({ token: '' })]).length > 0)
  assert.ok(hosts().validate([host({ baseUrl: '' })]).length > 0)
  // An empty list is not a value: clearing the setting removes the provider.
  assert.ok(hosts().validate([]).length > 0)
  assert.ok(hosts().validate({}).length > 0)
  assert.ok(hosts().validate(['nope']).length > 0)
})

test('a host id is a short lowercase slug, and unique within the list', () => {
  assert.deepEqual(hosts().validate([host({ id: 'mac-mini-2' })]), [])
  assert.ok(hosts().validate([host({ id: 'Mac Mini' })]).length > 0)
  assert.ok(hosts().validate([host({ id: '-leading' })]).length > 0)
  assert.ok(hosts().validate([host({ id: '' })]).length > 0)
  assert.ok(hosts().validate([host({ id: 'a'.repeat(33) })]).length > 0)
  // Two hosts under one id would make `docker:<id>` ambiguous, and a session
  // has no other way back to its host.
  assert.ok(
    hosts()
      .validate([host(), host({ baseUrl: 'https://other.example.com' })])
      .some((error) => error.includes('unique'))
  )
})

test('the docker agent URL is an https origin with nothing appended', () => {
  assert.deepEqual(hosts().validate([host({ baseUrl: 'https://sandbox.example.com/' })]), [])
  assert.deepEqual(hosts().validate([host({ baseUrl: 'https://sandbox.example.com:8443' })]), [])
  // The bearer token rides on every call, so plaintext is out.
  assert.ok(
    hosts()
      .validate([host({ baseUrl: 'http://sandbox.example.com' })])
      .some((error) => error.includes('https'))
  )
  // A path would be dropped once the client appends its own routes.
  assert.ok(
    hosts()
      .validate([host({ baseUrl: 'https://sandbox.example.com/agent' })])
      .some((error) => error.includes('origin'))
  )
  assert.ok(hosts().validate([host({ baseUrl: 'https://sandbox.example.com?a=1' })]).length > 0)
  assert.ok(hosts().validate([host({ baseUrl: 'https://user:pw@sandbox.example.com' })]).length > 0)
  assert.ok(hosts().validate([host({ baseUrl: 'not a url' })]).length > 0)
  assert.ok(hosts().validate([host({ baseUrl: null })]).length > 0)
})

test('the docker agent token is a non-empty untrimmed-free string', () => {
  assert.ok(hosts().validate([host({ token: ' s3cret ' })]).length > 0)
  assert.ok(hosts().validate([host({ token: 42 })]).length > 0)
})

test('the docker image is a Docker reference', () => {
  assert.deepEqual(hosts().validate([host({ image: 'opencode-session:latest' })]), [])
  assert.deepEqual(hosts().validate([host({ image: 'ghcr.io/acme/opencode-session:v1.2.3' })]), [])
  assert.deepEqual(
    hosts().validate([
      host({ image: 'ghcr.io/acme/opencode-session@sha256:' + 'a'.repeat(64) })
    ]),
    []
  )
  // Nothing that would read as a flag or a shell word.
  assert.ok(hosts().validate([host({ image: '-rm' })]).length > 0)
  assert.ok(hosts().validate([host({ image: 'image latest' })]).length > 0)
  assert.ok(hosts().validate([host({ image: 'image;rm -rf /' })]).length > 0)
  assert.ok(hosts().validate([host({ image: '' })]).length > 0)
})

test('the docker idle timeout is whole minutes in 1–1440', () => {
  assert.deepEqual(hosts().validate([host({ idleTimeoutMinutes: 30 })]), [])
  assert.deepEqual(hosts().validate([host({ idleTimeoutMinutes: 1 })]), [])
  assert.deepEqual(hosts().validate([host({ idleTimeoutMinutes: 1440 })]), [])
  assert.ok(hosts().validate([host({ idleTimeoutMinutes: 0 })]).length > 0)
  assert.ok(hosts().validate([host({ idleTimeoutMinutes: 1441 })]).length > 0)
  assert.ok(hosts().validate([host({ idleTimeoutMinutes: 30.5 })]).length > 0)
  assert.ok(hosts().validate([host({ idleTimeoutMinutes: '30' })]).length > 0)
})

test('the docker host list is optional and reads back without its tokens', () => {
  assert.equal(hosts().group, 'docker')
  assert.equal(hosts().required, false)
  // Partial: the list is editable, each token is not.
  assert.equal(hosts().exposure, 'partial')
})

test('the MCP auth store is an optional write-only object of objects', () => {
  const descriptor = findDescriptor('opencode.mcp-auth')
  assert.equal(descriptor.group, 'opencode')
  assert.equal(descriptor.required, false)
  // OAuth access and refresh tokens: never read back.
  assert.equal(descriptor.exposure, 'secret')

  assert.deepEqual(descriptor.validate({}), [])
  assert.deepEqual(
    descriptor.validate({
      figma: { access: 'a', refresh: 'r', expires: 123 }
    }),
    []
  )
  for (const bad of [null, [], 'text', 42]) {
    assert.equal(descriptor.validate(bad).length, 1)
  }
  const errors = descriptor.validate({ figma: 'not-an-object' })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /figma/)
})

test('required settings are exactly the ones the gate blocks on', () => {
  assert.deepEqual(
    SETTING_DESCRIPTORS.filter((descriptor) => descriptor.required).map(
      (descriptor) => descriptor.key
    ),
    ['github.token', 'opencode.config', 'container.ssh-key']
  )
})
