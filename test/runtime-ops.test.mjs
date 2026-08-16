import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { BUILTIN_SKILLS } from '../src/builtin-skills.ts'
import {
  CONTAINER_RUNTIME_ENV,
  OPENCODE_XDG_ENV,
  PLAYWRIGHT_ENV,
  injectContainerCredentials,
  provisionRepository,
  readSessionChanges,
  resolveDefaultBranch,
  sanitizeSeededWorkspace,
  wipeSeededWorkspace
} from '../src/runtime-ops.ts'

/** The built-ins ride every batch; these tests are about the credentials. */
const builtinPaths = new Set(
  BUILTIN_SKILLS.map((skill) => `/root/.config/opencode/skills/${skill.name}/SKILL.md`)
)

/**
 * A host stub. `answers` maps a substring of the command to the exec result it
 * should produce; anything unmatched succeeds with empty output, which is what
 * most of these commands do.
 */
function stubHost(answers = {}, files = {}) {
  const calls = { exec: [], writeBatch: [], exists: [] }
  return {
    calls,
    async exec(command, options) {
      calls.exec.push({ command, options })
      const match = Object.keys(answers).find((key) => command.includes(key))
      const answer = match ? answers[match] : {}
      return {
        success: answer.success ?? true,
        exitCode: answer.exitCode ?? (answer.success === false ? 1 : 0),
        stdout: answer.stdout ?? '',
        stderr: answer.stderr ?? ''
      }
    },
    async writeBatch(written) {
      calls.writeBatch.push(written)
      return { written: written.length }
    },
    async exists(path) {
      calls.exists.push(path)
      return { exists: Boolean(files[path]) }
    }
  }
}

const CHECKOUT = {
  repoKey: 'owner/repo',
  repo: {
    repoKey: 'owner/repo',
    cloneUrl: 'git@github.com:owner/repo.git',
    defaultBranch: 'main'
  },
  directory: '/workspace/owner/repo',
  sessionId: 'lively-otter'
}

test('credentials with no stored MCP auth are one script and one batch', async () => {
  const host = stubHost()
  const env = await injectContainerCredentials(
    host,
    {
      sshKey: { privateKey: 'PRIVATE', publicKey: 'PUBLIC' },
      githubToken: 'gh-token',
      gitIdentity: { name: 'Bot', email: 'bot@example.com' },
      env: [{ name: 'FOO', value: 'bar' }],
      skills: [{ name: 'review', content: '# Review' }]
    },
    CHECKOUT
  )

  // Every command that does not depend on the batch rides in front of it, so
  // the whole injection is two round trips rather than three.
  assert.equal(host.calls.exec.length, 1)
  assert.match(host.calls.exec[0].command, /^rm -rf '\/root\/\.config\/opencode\/skills'/)
  assert.match(host.calls.exec[0].command, /rm -f '\/root\/\.config\/opencode\/AGENTS\.md'/)
  assert.match(host.calls.exec[0].command, /git config --global user\.name 'Bot'/)
  assert.match(host.calls.exec[0].command, /commit\.gpgsign true/)

  assert.equal(host.calls.writeBatch.length, 1)
  const written = host.calls.writeBatch[0]
  assert.deepEqual(
    written.map((file) => file.path).filter((path) => !builtinPaths.has(path)),
    [
      '/root/.ssh/id_ed25519',
      '/root/.ssh/id_ed25519.pub',
      '/root/.config/gh/hosts.yml',
      '/root/.config/opencode/skills/review/SKILL.md',
      '/root/.config/opencode/AGENTS.md'
    ]
  )
  // OpenSSH refuses a private key others could read, so the mode travels with
  // the write rather than being a second round trip.
  assert.equal(written[0].mode, '600')
  assert.equal(written[1].mode, '644')
  assert.deepEqual(env, { FOO: 'bar' })
})

test('the artifacts directory exists from the first wake, and survives a seed', async () => {
  // Created by the leading script, so the agent finds the directory the
  // instructions name and the panel opens on an empty listing rather than an
  // error. No extra round trip: it rides a script that had to run anyway.
  const wake = stubHost()
  await injectContainerCredentials(wake, { env: [], skills: [] }, {})
  assert.equal(wake.calls.exec.length, 1)
  assert.match(wake.calls.exec[0].command, /mkdir -p '\/workspace\/artifacts'/)

  // A prebuild seed carries the donor's artifacts, which belong to whoever ran
  // the prebuild. Both seed paths drop them and put the empty directory back.
  const seeded = stubHost({}, { '/workspace/owner/repo/.git': true })
  await sanitizeSeededWorkspace(seeded, CHECKOUT)
  assert.match(seeded.calls.exec[0].command, /rm -rf '\/workspace\/artifacts'/)
  assert.match(seeded.calls.exec[0].command, /mkdir -p '\/workspace\/artifacts'/)

  const wiped = stubHost()
  await wipeSeededWorkspace(wiped, CHECKOUT)
  assert.match(wiped.calls.exec[0].command, /rm -rf '\/workspace\/artifacts'/)
  assert.match(wiped.calls.exec[0].command, /mkdir -p '\/workspace\/artifacts'/)
})

test('no credentials at all still clears what a previous wake wrote', async () => {
  const host = stubHost()
  const env = await injectContainerCredentials(host, { env: [], skills: [] }, {})
  assert.equal(host.calls.exec.length, 1)
  assert.match(host.calls.exec[0].command, /^rm -rf/)
  // No stored MCP auth: a store seeded by an earlier wake is removed, one
  // OpenCode created on its own is left alone — the marker decides. Nothing
  // about that clear waits on the batch, so it rides the leading script.
  assert.match(
    host.calls.exec[0].command,
    / && if \[ -e '\/workspace\/\.opencode-state\/data\/opencode\/\.mcp-auth\.seeded' \]/
  )
  // The built-in skills and the standing instructions still ride the batch —
  // they are not credentials.
  assert.equal(host.calls.writeBatch.length, 1)
  assert.ok(
    host.calls.writeBatch[0].every((file) =>
      file.path.startsWith('/root/.config/opencode/')
    )
  )
  assert.deepEqual(env, {})
})

test('a stored MCP auth store is staged in the batch and installed by the guarded script', async () => {
  const host = stubHost()
  await injectContainerCredentials(
    host,
    {
      env: [],
      skills: [],
      mcpAuth: { content: '{"figma":{}}', token: '2026-07-29T00:00:00Z' }
    },
    {}
  )

  assert.equal(host.calls.writeBatch.length, 1)
  const staged = host.calls.writeBatch[0].find(
    (file) => file.path === '/root/.mcp-auth.pending.json'
  )
  assert.equal(staged.mode, '600')

  // The seed is the one command that has to wait for the batch that stages the
  // store, so it — and only it — is a second round trip.
  assert.equal(host.calls.exec.length, 2)
  assert.match(host.calls.exec[0].command, /^rm -rf/)
  const script = host.calls.exec[1].command
  assert.ok(script.includes(`!= '2026-07-29T00:00:00Z'`))
  assert.ok(
    script.includes(
      `mv '/root/.mcp-auth.pending.json' '/workspace/.opencode-state/data/opencode/mcp-auth.json'`
    )
  )
  // The store rides the batch, never a command line.
  assert.ok(!script.includes('figma'))
})

test('a fresh workspace is cloned at the pinned default branch', async () => {
  const host = stubHost()
  const { fetching } = await provisionRepository(host, CHECKOUT)
  assert.equal(fetching, undefined)
  assert.deepEqual(host.calls.exists, ['/workspace/owner/repo/.git'])
  assert.match(
    host.calls.exec[0].command,
    /^git clone --depth 1 --branch 'main' 'git@github.com:owner\/repo\.git' '\/workspace\/owner\/repo'$/
  )
})

test('onClone fires before a clone and never for a restored checkout', async () => {
  // The caller used to answer this with an `exists` of its own, which is a
  // second round trip for a question this function already asks.
  const fresh = stubHost()
  const order = []
  await provisionRepository(fresh, CHECKOUT, {
    onClone: async () => {
      order.push(`hook after ${fresh.calls.exec.length} exec`)
    }
  })
  assert.deepEqual(order, ['hook after 0 exec'])
  assert.equal(fresh.calls.exists.length, 1)

  const restored = stubHost({}, { '/workspace/owner/repo/.git': true })
  let fired = false
  const { fetching } = await provisionRepository(restored, CHECKOUT, {
    onClone: async () => {
      fired = true
    }
  })
  await fetching
  assert.equal(fired, false)
})

test('a restored checkout is fetched, and the fetch is handed back unawaited', async () => {
  const host = stubHost({}, { '/workspace/owner/repo/.git': true })
  const { fetching } = await provisionRepository(host, CHECKOUT)
  assert.ok(fetching instanceof Promise)
  await fetching
  assert.match(host.calls.exec[0].command, /fetch origin --prune$/)
})

test('a fetch that fails does not fail the wake', async () => {
  const host = stubHost(
    { fetch: { success: false, stderr: 'host key mismatch' } },
    { '/workspace/owner/repo/.git': true }
  )
  await (await provisionRepository(host, CHECKOUT)).fetching
})

test('a session with no repository provisions nothing', async () => {
  const host = stubHost()
  assert.deepEqual(
    await provisionRepository(host, { directory: '/workspace', sessionId: 's' }),
    {}
  )
  assert.equal(host.calls.exec.length, 0)
  assert.equal(host.calls.exists.length, 0)
})

test('a checkout with no clone url and no checkout refuses the wake', async () => {
  const host = stubHost()
  await assert.rejects(
    provisionRepository(host, { ...CHECKOUT, repo: undefined }),
    /no checkout and no pinned repository/
  )
})

test('the default branch comes from origin/HEAD, falling back to the pin', async () => {
  assert.equal(
    await resolveDefaultBranch(
      stubHost({ 'symbolic-ref': { stdout: 'origin/trunk\n' } }),
      '/workspace/owner/repo',
      CHECKOUT.repo
    ),
    'trunk'
  )
  assert.equal(
    await resolveDefaultBranch(
      stubHost({ 'symbolic-ref': { success: false } }),
      '/workspace/owner/repo',
      CHECKOUT.repo
    ),
    'main'
  )
})

test('the working-tree read reports the branch, files and diff', async () => {
  const status = Buffer.from('1 .M N... 100644 100644 100644 aa bb src/a.ts\0').toString(
    'base64'
  )
  const host = stubHost({
    'symbolic-ref': { stdout: 'origin/main\n' },
    'rev-parse --abbrev-ref HEAD': { stdout: 'opencode/lively-otter\n' },
    "log -1": { stdout: 'abc123\tFix the thing\n' },
    'status --porcelain': { stdout: status },
    "diff 'HEAD'": { stdout: 'diff --git a/src/a.ts b/src/a.ts\n' },
    'branch --remotes': { stdout: '  origin/main\n  origin/opencode/lively-otter\n' },
    'rev-list --count': { stdout: '3\n' }
  })
  const changes = await readSessionChanges(host, CHECKOUT)
  assert.equal(changes.branch, 'opencode/lively-otter')
  assert.equal(changes.defaultBranch, 'main')
  assert.equal(changes.onDefaultBranch, false)
  assert.deepEqual(changes.head, { sha: 'abc123', subject: 'Fix the thing' })
  assert.equal(changes.unpushedCommits, 3)
  assert.ok(changes.diff.includes('diff --git'))
  assert.equal(changes.scope, 'head')
  assert.equal(changes.baseRef, undefined)
  // The default scope must not spend a merge-base round trip.
  assert.ok(
    !host.calls.exec.some((call) => call.command.includes('merge-base'))
  )
})

test('the branch scope diffs from the merge base, never from origin itself', async () => {
  const status = Buffer.from(' M src/a.ts\0').toString('base64')
  const committed = Buffer.from('A\0src/b.ts\0M\0src/a.ts\0').toString('base64')
  const host = stubHost({
    'symbolic-ref': { stdout: 'origin/main\n' },
    'rev-parse --abbrev-ref HEAD': { stdout: 'opencode/lively-otter\n' },
    'status --porcelain': { stdout: status },
    'merge-base': { stdout: 'base0ff\n' },
    'diff --name-status': { stdout: committed },
    "diff 'base0ff'": { stdout: 'diff --git a/src/b.ts b/src/b.ts\n' }
  })
  const changes = await readSessionChanges(host, CHECKOUT, 'branch')
  assert.equal(changes.scope, 'branch')
  assert.equal(changes.baseRef, 'base0ff')
  // A commit-only file joins the working tree's, and the file touched by both
  // appears once with the status it has against the base.
  assert.deepEqual(changes.files, [
    { path: 'src/b.ts', status: 'added' },
    { path: 'src/a.ts', status: 'modified' }
  ])

  const commands = host.calls.exec.map((call) => call.command)
  // The merge base is what stops commits pushed to origin since this session
  // started from turning up as reverts inside its diff.
  assert.ok(commands.some((command) => command.includes("merge-base 'origin/main' HEAD")))
  assert.ok(commands.some((command) => command.includes("diff 'base0ff' --no-color")))
  // And a branch read still never reaches the network.
  assert.ok(!commands.some((command) => /\bgit .*\b(fetch|pull|remote update)\b/.test(command)))
})

test('a branch read with no origin ref falls back to the working tree and says so', async () => {
  const host = stubHost({
    'rev-parse --abbrev-ref HEAD': { stdout: 'work\n' },
    'merge-base': { success: false, stderr: 'Not a valid object name' },
    "diff 'HEAD'": { stdout: 'diff --git a/src/a.ts b/src/a.ts\n' }
  })
  const changes = await readSessionChanges(host, CHECKOUT, 'branch')
  // The scope in the answer is what was measured, not what was asked for.
  assert.equal(changes.scope, 'head')
  assert.equal(changes.baseRef, undefined)
  assert.ok(
    !host.calls.exec.some((call) => call.command.includes('diff --name-status'))
  )
})

test('new files are diffed against /dev/null without touching the index', async () => {
  const status = Buffer.from('?? docs/new.md\0?? docs/it\x27s here.md\0').toString(
    'base64'
  )
  const newDiff =
    'diff --git a/docs/new.md b/docs/new.md\n--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1 @@\n+hello\n'
  const host = stubHost({
    'rev-parse --abbrev-ref HEAD': { stdout: 'work\n' },
    'status --porcelain': { stdout: status },
    'diff --no-index': { stdout: newDiff }
  })
  const changes = await readSessionChanges(host, CHECKOUT)
  assert.deepEqual(
    changes.files.map((file) => file.status),
    ['untracked', 'untracked']
  )
  assert.ok(changes.diff.includes('+++ b/docs/new.md'))

  const commands = host.calls.exec.map((call) => call.command)
  assert.ok(commands.some((command) => command.includes('status --porcelain=v1 -z -uall')))
  const noIndex = commands.find((command) => command.includes('diff --no-index'))
  assert.ok(noIndex.includes(`-- /dev/null 'docs/new.md'`))
  // A quote in a path stays inside the quoting rather than ending it.
  assert.ok(noIndex.includes(`'docs/it'\\''s here.md'`))
  assert.ok(!commands.some((command) => /\badd\b/.test(command)))
})

test('a failed status read is an error, a failed diff is an empty diff', async () => {
  await assert.rejects(
    readSessionChanges(
      stubHost({
        'rev-parse --abbrev-ref HEAD': { stdout: 'main\n' },
        'status --porcelain': { success: false, stderr: 'not a repository' }
      }),
      CHECKOUT
    ),
    /git status failed/
  )
  const changes = await readSessionChanges(
    stubHost({
      'rev-parse --abbrev-ref HEAD': { stdout: 'work\n' },
      "diff 'HEAD'": { success: false, stderr: 'boom' }
    }),
    CHECKOUT
  )
  assert.equal(changes.diff, '')
})

// Regression: the marker restoreWorkspace writes for THIS session is written
// before sanitize runs, so a sanitize that removed it would make the next wake
// read a healthy volume as a lost workspace (inst-14d65198, 2026-07-31).
test('sanitizing a seed removes donor state but never the persistence marker', async () => {
  const host = stubHost({}, { '/workspace/owner/repo/.git': true })
  await sanitizeSeededWorkspace(host, CHECKOUT)
  const removal = host.calls.exec.find((call) => call.command.includes('rm -rf'))
  assert.ok(removal, 'sanitize removes donor state')
  assert.match(removal.command, /\.opencode-state\/data\/opencode/)
  assert.match(removal.command, /\.opencode-state\/state/)
  for (const call of host.calls.exec) {
    assert.ok(
      !call.command.includes('.opencode-persistence-ready'),
      `sanitize must not touch the marker: ${call.command}`
    )
  }
})

test('wiping a failed seed spares the persistence marker too', async () => {
  const host = stubHost()
  await wipeSeededWorkspace(host, CHECKOUT)
  for (const call of host.calls.exec) {
    assert.ok(
      !call.command.includes('.opencode-persistence-ready'),
      `wipe must not touch the marker: ${call.command}`
    )
  }
})

test('the runtime environment points Playwright out of the workspace it redirects everything else into', () => {
  // XDG_CACHE_HOME lands in the snapshotted workspace on purpose — that is what
  // keeps a warm pnpm store across wakes. Playwright resolves its browsers to
  // `$XDG_CACHE_HOME/ms-playwright`, so left alone it would look inside the
  // workspace, miss the 344 MB the image baked, and re-download them per
  // session (and snapshot the result). The pin is the whole preinstall.
  assert.match(OPENCODE_XDG_ENV.XDG_CACHE_HOME, /^\/workspace\//)
  assert.ok(!PLAYWRIGHT_ENV.PLAYWRIGHT_BROWSERS_PATH.startsWith('/workspace'))
  assert.equal(
    CONTAINER_RUNTIME_ENV.PLAYWRIGHT_BROWSERS_PATH,
    PLAYWRIGHT_ENV.PLAYWRIGHT_BROWSERS_PATH
  )

  // Whatever the images install to has to be exactly this path, so the two
  // Dockerfiles are read rather than trusted.
  for (const dockerfile of ['Dockerfile', 'agent/session-image/Dockerfile']) {
    const content = readFileSync(new URL(`../${dockerfile}`, import.meta.url), 'utf8')
    assert.ok(
      content.includes(`ENV PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_ENV.PLAYWRIGHT_BROWSERS_PATH}`),
      `${dockerfile} must install browsers where the runtime looks for them`
    )
  }

  // The XDG redirects still travel with it: a wake that dropped them would put
  // OpenCode's own database outside the snapshot and lose conversations.
  for (const [key, value] of Object.entries(OPENCODE_XDG_ENV)) {
    assert.equal(CONTAINER_RUNTIME_ENV[key], value)
  }
})
