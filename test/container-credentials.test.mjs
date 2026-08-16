import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILTIN_SKILLS } from '../src/builtin-skills.ts'
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
  // Plus AGENTS.md, which is written on every wake whatever the settings say.
  assert.equal(files.length, 6 + BUILTIN_SKILLS.length)
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

  const agentsFile = (files) => files.find((file) => file.path === CONTAINER_AGENTS_MD_PATH)

  const merged = agentsFile(credentialFiles(settings, 'opencode-cloud'))
  assert.equal(merged.mode, '644')
  // Global first, the repo addition after, one blank line between.
  assert.ok(merged.content.startsWith('# House rules\n\nUse pnpm.\n\n'))

  // A session on another repo — or none — gets only the global block.
  for (const repoKey of ['other-repo', undefined]) {
    assert.ok(
      agentsFile(credentialFiles(settings, repoKey)).content.startsWith('# House rules\n\n')
    )
  }
})

test('the artifacts directory is described to every container', () => {
  // Appended to the operator's own instructions rather than merged into the
  // setting, so it cannot be edited away and is written even when nothing is
  // configured at all.
  for (const settings of [
    { env: [], skills: [] },
    { env: [], skills: [], agentsMd: { global: '# House rules' } }
  ]) {
    const agents = credentialFiles(settings).find(
      (file) => file.path === CONTAINER_AGENTS_MD_PATH
    )
    assert.equal(agents.mode, '644')
    assert.ok(agents.content.includes('/workspace/artifacts'))
    assert.ok(agents.content.endsWith('\n'))
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
  for (const name of ['babysit', 'deploy']) {
    assert.ok(paths.includes(`${CONTAINER_SKILLS_ROOT}/${name}/SKILL.md`))
  }

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

test('nothing configured writes only the built-in skills and the standing instructions', () => {
  assert.deepEqual(
    credentialFiles({ env: [], skills: [] }).map((file) => file.path),
    [
      ...BUILTIN_SKILLS.map((skill) => `${CONTAINER_SKILLS_ROOT}/${skill.name}/SKILL.md`),
      CONTAINER_AGENTS_MD_PATH
    ]
  )
  assert.deepEqual(gitConfigCommands({ env: [], skills: [] }), [])
  assert.deepEqual(containerEnv({ env: [], skills: [] }), {})
})

test('built-in skills reach every container; a same-name settings skill replaces one', () => {
  const builtinPath = `${CONTAINER_SKILLS_ROOT}/expose-dev-server/SKILL.md`

  const stock = credentialFiles({ env: [], skills: [] })
  const builtin = stock.find((file) => file.path === builtinPath)
  assert.equal(builtin.mode, '644')
  assert.ok(builtin.content.includes('cloudflared tunnel --protocol http2 --url'))
  assert.ok(builtin.content.includes('only when the user has explicitly asked'))

  const overridden = credentialFiles({
    env: [],
    skills: [{ name: 'expose-dev-server', content: '# mine' }]
  })
  const replacements = overridden.filter((file) => file.path === builtinPath)
  assert.deepEqual(replacements, [{ path: builtinPath, content: '# mine\n', mode: '644' }])
})

test('browse-web tells the agent the things the image would otherwise teach the hard way', () => {
  const skill = credentialFiles({ env: [], skills: [] }).find(
    (file) => file.path === `${CONTAINER_SKILLS_ROOT}/browse-web/SKILL.md`
  )

  // Preinstalled, so the agent must not reach for a download: `playwright
  // install` would fetch 344 MB into the snapshotted workspace, per session.
  assert.ok(skill.content.includes('preinstalled'))
  assert.ok(skill.content.includes('playwright install'))

  // Only the headless shell is baked in (Dockerfile: `--only-shell`), so
  // `headless: false` and `channel: 'chrome'` both fail with a misleading
  // "Executable doesn't exist" unless the skill says so first.
  assert.ok(skill.content.includes('headless: false'))
  assert.ok(skill.content.includes("channel: 'chrome'"))
  assert.ok(skill.content.includes("Executable doesn't exist"))

  // A screenshot nobody reads is wasted work, and one left in the checkout
  // looks like a change the user asked for.
  assert.ok(skill.content.includes('/tmp/page.png'))
  assert.ok(skill.content.includes('await browser.close()'))
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
      overrides: [{ owner: 'Acme-Labs', name: 'Work Me', email: 'work@example.com' }]
    }
  }

  // Owner match is case-insensitive, as GitHub's owner names are.
  assert.deepEqual(gitConfigCommands(settings, 'acme-labs'), [
    "git config --global user.name 'Work Me'",
    "git config --global user.email 'work@example.com'"
  ])
  // Any other owner — or no owner at all — falls back to the base identity.
  for (const owner of ['acme-io', undefined]) {
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
  const staged = files.find((file) => file.path === MCP_AUTH_STAGING)
  assert.equal(staged.mode, '600')
  assert.equal(staged.content, '{"figma":{"access":"tok"}}\n')
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
