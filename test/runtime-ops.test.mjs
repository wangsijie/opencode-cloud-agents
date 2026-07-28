import assert from 'node:assert/strict'
import test from 'node:test'

import {
  injectContainerCredentials,
  provisionRepository,
  readSessionChanges,
  resolveDefaultBranch
} from '../src/runtime-ops.ts'

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

test('credentials are one removal, one batch and one config command', async () => {
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

  assert.equal(host.calls.exec.length, 2)
  assert.match(host.calls.exec[0].command, /^rm -rf '\/root\/\.config\/opencode\/skills'/)
  assert.match(host.calls.exec[0].command, /rm -f '\/root\/\.config\/opencode\/AGENTS\.md'/)
  assert.match(host.calls.exec[1].command, /git config --global user\.name 'Bot'/)
  assert.match(host.calls.exec[1].command, /commit\.gpgsign true/)

  assert.equal(host.calls.writeBatch.length, 1)
  const written = host.calls.writeBatch[0]
  assert.deepEqual(
    written.map((file) => file.path),
    [
      '/root/.ssh/id_ed25519',
      '/root/.ssh/id_ed25519.pub',
      '/root/.config/gh/hosts.yml',
      '/root/.config/opencode/skills/review/SKILL.md'
    ]
  )
  // OpenSSH refuses a private key others could read, so the mode travels with
  // the write rather than being a second round trip.
  assert.equal(written[0].mode, '600')
  assert.equal(written[1].mode, '644')
  assert.deepEqual(env, { FOO: 'bar' })
})

test('no credentials at all still clears what a previous wake wrote', async () => {
  const host = stubHost()
  const env = await injectContainerCredentials(host, { env: [], skills: [] }, {})
  assert.equal(host.calls.exec.length, 1)
  assert.equal(host.calls.writeBatch.length, 0)
  assert.deepEqual(env, {})
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
    'diff HEAD': { stdout: 'diff --git a/src/a.ts b/src/a.ts\n' },
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
      'diff HEAD': { success: false, stderr: 'boom' }
    }),
    CHECKOUT
  )
  assert.equal(changes.diff, '')
})
