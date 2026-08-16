import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXEC_OUTPUT_LIMIT_BYTES,
  TIMEOUT_EXIT_CODES,
  assertSessionId,
  capOutput,
  containerName,
  decodeFileContent,
  detachedExecArgs,
  execArgs,
  existsScript,
  inspectArgs,
  isNoSuchObject,
  listFilesScript,
  parentDirectory,
  parseInspect,
  parseListing,
  parsePublishedPort,
  readFileScript,
  runArgs,
  serverAliveScript,
  serverEnvFileContent,
  shellQuote,
  startServerScript,
  volumeName,
  writeFileScript
} from '../agent/docker.mjs'
import { matchSessionRoute as agentMatch } from '../agent/server.mjs'
import { matchSessionRoute as protocolMatch } from '../protocol/routes.ts'

test('names are derived from the session id, and bad ids never reach docker', () => {
  assert.equal(containerName('abc_123-XYZ'), 'oc-session-abc_123-XYZ')
  assert.equal(volumeName('abc_123-XYZ'), 'oc-vol-abc_123-XYZ')
  for (const bad of ['', 'has space', 'semi;colon', '../escape', 'a'.repeat(65)]) {
    assert.throws(() => assertSessionId(bad), /Invalid session id/)
  }
})

test('run publishes to loopback, mounts the volume and idles at PID 1', () => {
  const args = runArgs({ sessionId: 's1', image: 'opencode-session:latest' })
  assert.deepEqual(args.slice(-3), ['opencode-session:latest', 'sleep', 'infinity'])
  assert.ok(args.includes('--init'))
  // macOS cannot route to a container IP, so the port has to be published — and
  // to loopback only, because the box is fronted by Caddy, not exposed.
  assert.ok(args.includes('127.0.0.1:0:4096'))
  assert.ok(args.includes('oc-vol-s1:/workspace'))
  assert.deepEqual(
    args.slice(args.indexOf('--restart'), args.indexOf('--restart') + 2),
    ['--restart', 'unless-stopped']
  )
  assert.throws(() => runArgs({ sessionId: 's1', image: '  ' }), /image is required/)
})

test('exec bounds the command inside the container, not the CLI', () => {
  const args = execArgs({ sessionId: 's1', command: 'git status', timeoutMs: 2500 })
  assert.equal(args[0], 'exec')
  // Killing the docker CLI would sever the pipe and leave the command running
  // inside the container; `timeout` signals the process group instead. Partial
  // seconds round up, so a budget is never silently shortened. SIGTERM with a
  // kill behind it, because `--signal=KILL` exits 137 rather than the 124 that
  // means "timed out".
  assert.deepEqual(args, [
    'exec',
    'oc-session-s1',
    'timeout',
    '--kill-after=5',
    '3',
    'sh',
    '-lc',
    'git status'
  ])
  assert.ok(TIMEOUT_EXIT_CODES.has(124) && TIMEOUT_EXIT_CODES.has(137))
  assert.ok(!args.includes('--interactive'))
})

test('exec carries cwd and env, and helpers do not use a login shell', () => {
  const args = execArgs({
    sessionId: 's1',
    command: 'true',
    cwd: '/workspace/repo',
    env: { FOO: 'bar' },
    interactive: true,
    login: false
  })
  assert.ok(args.includes('--interactive'))
  assert.deepEqual(
    args.slice(args.indexOf('--workdir'), args.indexOf('--workdir') + 2),
    ['--workdir', '/workspace/repo']
  )
  assert.deepEqual(args.slice(args.indexOf('--env'), args.indexOf('--env') + 2), [
    '--env',
    'FOO=bar'
  ])
  // A login shell may print /etc/profile output, which would be concatenated
  // onto a file's contents.
  assert.ok(args.includes('-c'))
  assert.ok(!args.includes('-lc'))
})

test('detached exec and inspect address the session container', () => {
  assert.deepEqual(detachedExecArgs({ sessionId: 's1', command: 'true' }), [
    'exec',
    '--detach',
    'oc-session-s1',
    'sh',
    '-c',
    'true'
  ])
  assert.equal(inspectArgs('s1').at(-1), 'oc-session-s1')
})

test('a written file is created atomically, with its mode before the move', () => {
  const script = writeFileScript("/root/.ssh/id_ed25519", '600')
  assert.match(script, /mkdir -p '\/root\/\.ssh'/)
  assert.match(script, /cat > "\$tmp"/)
  const chmodAt = script.indexOf('chmod 600')
  const moveAt = script.indexOf('mv -f')
  assert.ok(chmodAt > 0 && chmodAt < moveAt, 'chmod must precede the move')
  // OpenSSH refuses a key that was readable by others, even briefly.
  assert.match(script, /mv -f "\$tmp" '\/root\/\.ssh\/id_ed25519'/)
  assert.ok(!writeFileScript('/tmp/plain').includes('chmod'))
})

test('paths with quotes cannot break out of the script', () => {
  const script = writeFileScript("/tmp/it's here/file", '644')
  assert.match(script, /'\/tmp\/it'\\''s here'/)
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  assert.equal(parentDirectory('/a/b/c'), '/a/b')
  assert.equal(parentDirectory('/top'), '/')
})

test('read and list report a missing target with exit 3', () => {
  assert.match(readFileScript('/x'), /test -f '\/x' \|\| exit 3/)
  assert.match(listFilesScript('/x'), /test -d '\/x' \|\| exit 3/)
  assert.match(existsScript('/x'), /^test -e '\/x'$/)
  // NUL-separated records: a newline is legal in a file name.
  assert.match(listFilesScript('/x'), /%f\\0/)
})

test('the liveness pattern does not match the shell that carries it', () => {
  const script = serverAliveScript(4096)
  const pattern = /opencode s\[e\]rve --port 4096/.exec(script)
  assert.ok(pattern, 'the bracket form is what keeps pgrep from finding itself')
  const asRegExp = new RegExp('opencode s[e]rve --port 4096')
  assert.ok(asRegExp.test('/usr/local/bin/opencode serve --port 4096 --hostname 0.0.0.0'))
  assert.ok(!asRegExp.test(script))
})

test('the server environment is sourced, not put on the command line', () => {
  const content = serverEnvFileContent({
    OPENCODE_CONFIG_CONTENT: '{"a":1}',
    ANTHROPIC_API_KEY: "sk-'quoted"
  })
  assert.equal(
    content,
    `OPENCODE_CONFIG_CONTENT='{"a":1}'\nANTHROPIC_API_KEY='sk-'\\''quoted'\n`
  )
  const script = startServerScript({ port: 4096, directory: '/workspace/repo' })
  assert.match(script, /^set -a\n\. '\/root\/\.opencode-server\.env'\nset \+a/)
  assert.match(script, /cd '\/workspace\/repo'/)
  // --hostname 0.0.0.0, or the published loopback port reaches nothing.
  assert.match(script, /exec opencode serve --port 4096 --hostname 0\.0\.0\.0/)
})

test('output is capped in bytes, keeping the head', () => {
  const small = capOutput(Buffer.from('hello'))
  assert.deepEqual(small, { text: 'hello', truncated: false })

  const large = capOutput(Buffer.alloc(EXEC_OUTPUT_LIMIT_BYTES + 10, 0x61))
  assert.equal(large.truncated, true)
  assert.equal(Buffer.byteLength(large.text), EXEC_OUTPUT_LIMIT_BYTES)
  assert.ok(large.text.startsWith('aaa'))
})

test('file contents are text only when they round-trip as UTF-8', () => {
  assert.deepEqual(decodeFileContent(Buffer.from('héllo\n', 'utf8')), {
    content: 'héllo\n',
    encoding: 'utf-8'
  })
  // A NUL is the cheap tell...
  const withNul = Buffer.from([0x61, 0x00, 0x62])
  assert.equal(decodeFileContent(withNul).encoding, 'base64')
  assert.equal(
    Buffer.from(decodeFileContent(withNul).content, 'base64').equals(withNul),
    true
  )
  // ...and a lone continuation byte is the one toString would silently repair.
  const invalid = Buffer.from([0x66, 0x6f, 0x6f, 0x80])
  assert.equal(decodeFileContent(invalid).encoding, 'base64')
  assert.equal(
    Buffer.from(decodeFileContent(invalid).content, 'base64').equals(invalid),
    true
  )
})

test('a listing survives names containing tabs, and hides dotfiles on request', () => {
  const epoch = 1753689600
  const stdout = [
    `d\t4096\t${epoch}\tsrc\0`,
    `f\t12\t${epoch}.5\tread\tme.txt\0`,
    `l\t7\t${epoch}\tlink\0`,
    `f\t3\t${epoch}\t.env\0`,
    `p\t0\t${epoch}\tfifo\0`
  ].join('')

  const all = parseListing(stdout, true)
  assert.deepEqual(
    all.map((file) => file.name),
    ['.env', 'fifo', 'link', 'read\tme.txt', 'src']
  )
  assert.deepEqual(
    all.map((file) => file.type),
    ['file', 'other', 'symlink', 'file', 'directory']
  )
  assert.equal(all.find((file) => file.name === 'src').size, 4096)
  assert.equal(
    all.find((file) => file.name === 'src').modifiedAt,
    new Date(epoch * 1000).toISOString()
  )

  const visible = parseListing(stdout, false)
  assert.ok(!visible.some((file) => file.name === '.env'))
})

test('inspect maps docker state onto the protocol, dropping the zero time', () => {
  const running = parseInspect(
    'running\ttrue\t2026-07-28T09:00:00.5Z\t0001-01-01T00:00:00Z\t0\topencode-session:latest'
  )
  assert.equal(running.exists, true)
  assert.equal(running.running, true)
  assert.equal(running.startedAt, '2026-07-28T09:00:00.500Z')
  assert.equal(running.changedAt, '2026-07-28T09:00:00.500Z')
  assert.equal(running.exitCode, undefined)
  assert.equal(running.image, 'opencode-session:latest')

  const stopped = parseInspect(
    'exited\tfalse\t2026-07-28T09:00:00Z\t2026-07-28T09:45:59Z\t137\topencode-session:v2'
  )
  assert.equal(stopped.running, false)
  assert.equal(stopped.startedAt, undefined)
  assert.equal(stopped.changedAt, '2026-07-28T09:45:59.000Z')
  assert.equal(stopped.exitCode, 137)

  const created = parseInspect(
    'created\tfalse\t0001-01-01T00:00:00Z\t0001-01-01T00:00:00Z\t0\timg'
  )
  assert.equal(created.changedAt, undefined)
})

test('the published loopback port is read from either docker port form', () => {
  assert.equal(parsePublishedPort('127.0.0.1:49154\n'), 49154)
  assert.equal(parsePublishedPort('4096/tcp -> 127.0.0.1:49154\n'), 49154)
  assert.equal(parsePublishedPort('0.0.0.0:8080\n'), 8080)
  // IPv6 bindings are skipped rather than parsed: the agent connects over IPv4.
  assert.equal(parsePublishedPort('4096/tcp -> [::1]:49154\n'), undefined)
  assert.equal(parsePublishedPort(''), undefined)
})

test('docker says "no such container" in more than one way', () => {
  assert.ok(isNoSuchObject('Error: No such container: oc-session-x'))
  assert.ok(isNoSuchObject('Error response from daemon: Container x is not running'))
  assert.ok(isNoSuchObject('Error: No such volume: oc-vol-x'))
  assert.ok(!isNoSuchObject('fatal: not a git repository'))
  // This decides whether a non-zero exit becomes a 503, and a command inside a
  // healthy container is free to print the same words.
  assert.ok(!isNoSuchObject('grep: no such container: matched 0 lines'))
})

test('the agent routes exactly as the protocol table does', () => {
  const cases = [
    ['GET', '/sessions/s1'],
    ['DELETE', '/sessions/s1'],
    ['POST', '/sessions/s1/ensure'],
    ['POST', '/sessions/s1/stop'],
    ['POST', '/sessions/s1/exec'],
    ['POST', '/sessions/s1/files/write-batch'],
    ['POST', '/sessions/s1/files/read'],
    ['POST', '/sessions/s1/files/exists'],
    ['POST', '/sessions/s1/files/list'],
    ['POST', '/sessions/s1/opencode/start'],
    ['POST', '/sessions/s1/snapshot'],
    ['POST', '/sessions/s1/snapshot/restore'],
    ['GET', '/sessions/s1/proxy/event'],
    ['POST', '/sessions/s1/proxy/session/abc/message'],
    ['GET', '/sessions/s1/proxy'],
    ['POST', '/sessions/s1/nope'],
    ['GET', '/sessions'],
    ['GET', '/sessions/not valid/exec'],
    ['PUT', '/sessions/s1/ensure']
  ]
  for (const [method, path] of cases) {
    assert.deepEqual(
      agentMatch(method, path),
      protocolMatch(method, path),
      `${method} ${path}`
    )
  }
})

