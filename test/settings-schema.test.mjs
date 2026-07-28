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
      { name: 'deploy', content: '# doc', repoKey: 'logto' }
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
        { name: 'deploy', content: 'a', repoKey: 'logto' },
        { name: 'deploy', content: 'b', repoKey: 'logto' }
      ])
      .some((error) => error.includes('twice'))
  )
  // A global and a per-repo entry of the same name would shadow one another.
  assert.ok(
    skills
      .validate([
        { name: 'deploy', content: 'a' },
        { name: 'deploy', content: 'b', repoKey: 'logto' }
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
      overrides: [{ owner: 'silverhand-io', name: 'Work', email: 'work@silverhand.io' }]
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
        overrides: [{ owner: 'bad owner!', name: 'Work', email: 'work@silverhand.io' }]
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

test('required settings are exactly the ones the gate blocks on', () => {
  assert.deepEqual(
    SETTING_DESCRIPTORS.filter((descriptor) => descriptor.required).map(
      (descriptor) => descriptor.key
    ),
    ['github.token', 'opencode.config', 'container.ssh-key']
  )
})
