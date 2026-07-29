import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTAINER_AGENTS_MD_PATH,
  CONTAINER_SKILLS_ROOT,
  MCP_AUTH_MARKER,
  MCP_AUTH_PATH,
  MCP_AUTH_STAGING,
  containerEnv,
  credentialFiles,
  gitConfigCommands,
  mcpAuthClearCommand,
  mcpAuthSeedCommand,
  resolveAgentsMd,
  resolveSkills
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

test('the merged AGENTS.md lands at the global config path', () => {
  const settings = {
    env: [],
    skills: [],
    agentsMd: {
      global: '# House rules',
      repos: [{ repoKey: 'opencode-cloud', content: 'Use pnpm.' }]
    }
  }

  const files = credentialFiles(settings, 'opencode-cloud')
  assert.equal(files.length, 1)
  assert.equal(files[0].path, CONTAINER_AGENTS_MD_PATH)
  assert.equal(files[0].mode, '644')
  // Global first, the repo addition after, one blank line between.
  assert.equal(files[0].content, '# House rules\n\nUse pnpm.\n')

  // A session on another repo — or none — gets only the global block.
  for (const repoKey of ['other-repo', undefined]) {
    const globalOnly = credentialFiles(settings, repoKey)
    assert.equal(globalOnly[0].content, '# House rules\n')
  }
})

test('a repo-scoped skill reaches only that repository, at the global path', () => {
  const settings = {
    env: [],
    skills: [
      { name: 'babysit', content: '# global' },
      { name: 'deploy', content: '# scoped', repoKey: 'Opencode-Cloud' }
    ]
  }

  // Repo keys compare case-insensitively, like the catalog's lowercasing.
  const matching = credentialFiles(settings, 'opencode-cloud')
  const paths = matching.map((file) => file.path)
  assert.deepEqual(paths, [
    `${CONTAINER_SKILLS_ROOT}/babysit/SKILL.md`,
    `${CONTAINER_SKILLS_ROOT}/deploy/SKILL.md`
  ])

  // A session on another repo — or none — gets only the global skill.
  for (const repoKey of ['other-repo', undefined]) {
    assert.deepEqual(
      resolveSkills(settings.skills, repoKey),
      [{ name: 'babysit', content: '# global' }]
    )
  }
})

test('resolveAgentsMd merges what exists and yields nothing for nothing', () => {
  // Repo keys compare case-insensitively, like the catalog's lowercasing.
  assert.equal(
    resolveAgentsMd(
      { repos: [{ repoKey: 'Opencode-Cloud', content: 'Use pnpm.' }] },
      'opencode-cloud'
    ),
    'Use pnpm.'
  )
  assert.equal(resolveAgentsMd(undefined, 'opencode-cloud'), undefined)
  assert.equal(resolveAgentsMd({}, 'opencode-cloud'), undefined)
  assert.equal(
    resolveAgentsMd(
      { global: '  ', repos: [{ repoKey: 'other', content: 'x' }] },
      'opencode-cloud'
    ),
    undefined
  )
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

test('a pasted MCP auth store is staged outside the snapshot, mode 600', () => {
  const files = credentialFiles({
    env: [],
    skills: [],
    mcpAuth: { content: '{"figma":{"access":"tok"}}', token: '2026-07-29T00:00:00Z' }
  })
  assert.equal(files.length, 1)
  assert.equal(files[0].path, MCP_AUTH_STAGING)
  assert.equal(files[0].mode, '600')
  assert.equal(files[0].content, '{"figma":{"access":"tok"}}\n')
})

test('the seed command is guarded by the revision marker and never carries the store', () => {
  const command = mcpAuthSeedCommand('2026-07-29T00:00:00Z')
  assert.ok(command.includes(MCP_AUTH_MARKER))
  assert.ok(command.includes(MCP_AUTH_PATH))
  assert.ok(command.includes(MCP_AUTH_STAGING))
  assert.ok(command.includes(`'2026-07-29T00:00:00Z'`))
  // An unchanged revision discards the staged copy instead of installing it —
  // OpenCode's refreshed tokens in the workspace must win.
  assert.ok(command.includes(`else rm -f`))
  assert.ok(!command.includes('access'))
})

test('the clear command removes only a store this Worker seeded', () => {
  const command = mcpAuthClearCommand()
  assert.ok(command.startsWith(`if [ -e '${MCP_AUTH_MARKER}' ]`))
  assert.ok(command.includes(`rm -f '${MCP_AUTH_PATH}' '${MCP_AUTH_MARKER}'`))
})

test('the env list becomes the process env map', () => {
  assert.deepEqual(containerEnv(full()), {
    CLOUDFLARE_API_TOKEN: 'cf-token',
    OTHER: 'x'
  })
})
