import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTAINER_SKILLS_ROOT,
  containerEnv,
  credentialFiles,
  gitConfigCommands
} from '../src/container-credentials.ts'

const full = () => ({
  sshKey: {
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
    publicKey: 'ssh-ed25519 AAAAC3 opencode-cloud'
  },
  githubToken: 'ghp_example',
  gitIdentity: { name: 'Op Erator', email: 'op@example.com' },
  env: [
    { name: 'CLOUDFLARE_API_TOKEN', value: 'cf-token' },
    { name: 'OTHER', value: 'x' }
  ],
  skills: [
    { name: 'babysit', content: '# skill' },
    { name: 'review', content: '# other' }
  ]
})

test('every configured credential lands at its container path with its mode', () => {
  const files = credentialFiles(full())
  const byPath = new Map(files.map((file) => [file.path, file]))

  assert.equal(byPath.get('/root/.ssh/id_ed25519').mode, '600')
  assert.ok(byPath.get('/root/.ssh/id_ed25519').content.endsWith('-----END OPENSSH PRIVATE KEY-----\n'))
  assert.equal(byPath.get('/root/.ssh/id_ed25519.pub').mode, '644')

  // The gh login is derived from the shared GitHub token, not stored apart.
  const hosts = byPath.get('/root/.config/gh/hosts.yml')
  assert.equal(hosts.mode, '600')
  assert.ok(hosts.content.includes('oauth_token: ghp_example'))
  assert.ok(hosts.content.includes('git_protocol: ssh'))

  assert.equal(
    byPath.get(`${CONTAINER_SKILLS_ROOT}/babysit/SKILL.md`).content,
    '# skill\n'
  )
  assert.ok(byPath.has(`${CONTAINER_SKILLS_ROOT}/review/SKILL.md`))
  assert.equal(files.length, 5)
})

test('nothing configured writes nothing', () => {
  assert.deepEqual(credentialFiles({ env: [], skills: [] }), [])
  assert.deepEqual(gitConfigCommands({ env: [], skills: [] }), [])
  assert.deepEqual(containerEnv({ env: [], skills: [] }), {})
})

test('git identity and signing are configured only for what exists', () => {
  const commands = gitConfigCommands(full())
  assert.deepEqual(commands, [
    "git config --global user.name 'Op Erator'",
    "git config --global user.email 'op@example.com'",
    'git config --global gpg.format ssh',
    'git config --global user.signingkey /root/.ssh/id_ed25519',
    'git config --global commit.gpgsign true'
  ])

  const identityOnly = gitConfigCommands({ ...full(), sshKey: undefined })
  assert.ok(identityOnly.every((command) => !command.includes('signingkey')))
  assert.equal(identityOnly.length, 2)

  const keyOnly = gitConfigCommands({ ...full(), gitIdentity: undefined })
  assert.ok(keyOnly.every((command) => !command.includes('user.name')))
  assert.equal(keyOnly.length, 3)
})

test('a per-organization override beats the base identity for its owner only', () => {
  const settings = {
    env: [],
    skills: [],
    gitIdentity: {
      name: 'Op Erator',
      email: 'op@example.com',
      overrides: [{ owner: 'Silverhand-io', name: 'Work Me', email: 'work@silverhand.io' }]
    }
  }

  // Owner match is case-insensitive, as GitHub's owner names are.
  assert.deepEqual(gitConfigCommands(settings, 'silverhand-io'), [
    "git config --global user.name 'Work Me'",
    "git config --global user.email 'work@silverhand.io'"
  ])
  // Any other owner — or no owner at all — falls back to the base identity.
  for (const owner of ['logto-io', undefined]) {
    assert.deepEqual(gitConfigCommands(settings, owner), [
      "git config --global user.name 'Op Erator'",
      "git config --global user.email 'op@example.com'"
    ])
  }
})

test('identity values are shell-quoted', () => {
  const commands = gitConfigCommands({
    env: [],
    skills: [],
    gitIdentity: { name: "O'Brien; rm -rf /", email: 'x@example.com' }
  })
  assert.ok(commands[0].includes("'O'\\''Brien; rm -rf /'"))
})

test('the env list becomes the process env map', () => {
  assert.deepEqual(containerEnv(full()), {
    CLOUDFLARE_API_TOKEN: 'cf-token',
    OTHER: 'x'
  })
})
