#!/usr/bin/env node
/**
 * End-to-end check of the Docker agent against a real Docker daemon.
 *
 * Deliberately outside `pnpm test`: it builds nothing but it does create a
 * container, a volume and (unless `--no-opencode`) an OpenCode server, so it
 * needs a machine with Docker and the session image on it. `test/agent-docker.test.mjs`
 * is the part that runs in CI.
 *
 *   docker build -f agent/session-image/Dockerfile -t opencode-session:latest .
 *   node agent/e2e.mjs
 *
 * Options:
 *   --image <ref>     session image to run (default opencode-session:latest)
 *   --no-opencode     skip the server start, the proxy and the SSE check
 *   --keep            leave the container and volume behind for inspection
 *
 * The sequence is the site's own wake path in miniature: ensure → exec →
 * write-batch → read/exists/list → opencode/start → proxy → SSE → stop →
 * delete, plus the two things only a volume host can be asked — that a stop
 * keeps the workspace and a delete does not.
 */
import { randomBytes } from 'node:crypto';

import { startAgent } from './server.mjs';

const options = parseArgs(process.argv.slice(2));
const token = randomBytes(24).toString('hex');
const sessionId = `e2e-${randomBytes(4).toString('hex')}`;

const server = await startAgent({
  token,
  image: options.image,
  port: 0,
  host: '127.0.0.1',
  log: (level, message) => {
    if (level === 'error') console.error(`  agent: ${message}`);
  }
});
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
let passes = 0;

try {
  await run();
} finally {
  if (!options.keep) {
    await call('DELETE', `/sessions/${sessionId}`).catch(() => {});
  } else {
    console.log(`\nLeft ${`oc-session-${sessionId}`} and its volume in place.`);
  }
  server.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);

async function run() {
  console.log(`Session ${sessionId} on ${options.image}\n`);

  const health = await call('GET', '/healthz');
  check('healthz reports the docker provider', health.provider === 'docker');
  check('snapshots are not offered', health.capabilities.snapshots === false);
  check('the daemon answered', Boolean(health.runtime?.dockerVersion));

  check(
    'an unauthenticated call is refused',
    (await status('GET', '/healthz', undefined, 'wrong-token')) === 401
  );

  const missing = await call('GET', `/sessions/${sessionId}`);
  check('an unknown session does not exist', missing.exists === false);

  const first = await call('POST', `/sessions/${sessionId}/ensure`, {});
  check('ensure starts the container', first.running === true);
  check('the first ensure is a cold start', first.created === true);
  check('the workspace volume was created', first.workspaceCreated === true);

  const second = await call('POST', `/sessions/${sessionId}/ensure`, {});
  check('ensure is idempotent', second.created === false);
  check('the volume is not recreated', second.workspaceCreated === false);

  const state = await call('GET', `/sessions/${sessionId}`);
  check('state reports it running', state.exists && state.running);
  check('state carries a start time', Boolean(state.startedAt));

  const exec = await call('POST', `/sessions/${sessionId}/exec`, {
    command: 'echo out; echo err >&2; exit 7'
  });
  check('exec reports the exit code', exec.exitCode === 7 && exec.success === false);
  check('stdout and stderr are separate', exec.stdout.trim() === 'out' && exec.stderr.trim() === 'err');

  const tools = await call('POST', `/sessions/${sessionId}/exec`, {
    command: 'command -v git ssh gh node opencode pgrep timeout find'
  });
  check('the image carries every tool the protocol requires', tools.success);

  const timedOut = await status(
    'POST',
    `/sessions/${sessionId}/exec`,
    { command: 'sleep 30', timeoutMs: 1500 },
    token
  );
  check('an over-budget exec is a 408', timedOut === 408);

  const written = await call('POST', `/sessions/${sessionId}/files/write-batch`, {
    files: [
      { path: '/workspace/e2e/hello.txt', content: 'héllo\n' },
      {
        path: '/workspace/e2e/nested/deep/secret',
        content: Buffer.from([0, 1, 2, 255]).toString('base64'),
        encoding: 'base64',
        mode: '600'
      }
    ]
  });
  check('a batch writes every file', written.written === 2);

  const text = await call('POST', `/sessions/${sessionId}/files/read`, {
    path: '/workspace/e2e/hello.txt'
  });
  check('text comes back as utf-8', text.encoding === 'utf-8' && text.content === 'héllo\n');

  const binary = await call('POST', `/sessions/${sessionId}/files/read`, {
    path: '/workspace/e2e/nested/deep/secret'
  });
  check(
    'binary comes back as base64',
    binary.encoding === 'base64' &&
      Buffer.from(binary.content, 'base64').equals(Buffer.from([0, 1, 2, 255]))
  );

  const mode = await call('POST', `/sessions/${sessionId}/exec`, {
    command: 'stat -c %a /workspace/e2e/nested/deep/secret'
  });
  check('the mode was applied', mode.stdout.trim() === '600');

  check(
    'a missing file is a 404',
    (await status('POST', `/sessions/${sessionId}/files/read`, { path: '/workspace/nope' })) === 404
  );

  const exists = await call('POST', `/sessions/${sessionId}/files/exists`, {
    path: '/workspace/e2e/hello.txt'
  });
  check('exists finds a written file', exists.exists === true);

  const listed = await call('POST', `/sessions/${sessionId}/files/list`, {
    path: '/workspace/e2e'
  });
  const names = listed.files.map((file) => file.name).sort();
  check('a listing names its entries', names.join(',') === 'hello.txt,nested');
  check(
    'a listing types and sizes them',
    listed.files.find((file) => file.name === 'nested')?.type === 'directory' &&
      listed.files.find((file) => file.name === 'hello.txt')?.size === 7
  );

  check(
    'a missing directory is a 404',
    (await status('POST', `/sessions/${sessionId}/files/list`, { path: '/workspace/nope' })) === 404
  );

  check(
    'snapshots are refused with 501',
    (await status('POST', `/sessions/${sessionId}/snapshot`, { dir: '/workspace' })) === 501
  );

  if (options.opencode) {
    await opencodeChecks();
  } else {
    console.log('  (skipping the OpenCode server, proxy and SSE checks)');
  }

  const stopped = await call('POST', `/sessions/${sessionId}/stop`, { timeoutSec: 5 });
  check('stop reports the container down', stopped.stopped === true);

  const afterStop = await call('GET', `/sessions/${sessionId}`);
  check('a stopped container still exists', afterStop.exists && !afterStop.running);

  check(
    'a primitive against a stopped container is a 503',
    (await status('POST', `/sessions/${sessionId}/exec`, { command: 'true' })) === 503
  );

  const restarted = await call('POST', `/sessions/${sessionId}/ensure`, {});
  check('a restart is a cold start', restarted.created === true);
  // The whole point of the provider: no snapshot, and the workspace is still
  // there because the volume never went anywhere.
  check('the workspace survived the stop', restarted.workspaceCreated === false);
  const survived = await call('POST', `/sessions/${sessionId}/files/exists`, {
    path: '/workspace/e2e/hello.txt'
  });
  check('the files survived with it', survived.exists === true);

  if (options.keep) return;

  const removed = await call('DELETE', `/sessions/${sessionId}`);
  check('delete removes the session', removed.removed === true);
  check(
    'delete is idempotent',
    (await call('DELETE', `/sessions/${sessionId}`)).removed === true
  );
  const gone = await call('GET', `/sessions/${sessionId}`);
  check('the container is gone', gone.exists === false);

  // Delete takes the workspace with it, which is what makes it purge.
  const volume = await runQuiet('docker', ['volume', 'inspect', `oc-vol-${sessionId}`]);
  check('the workspace volume is gone', volume !== 0);
}

async function opencodeChecks() {
  const started = await call('POST', `/sessions/${sessionId}/opencode/start`, {
    port: 4096,
    directory: '/workspace',
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json'
      }),
      XDG_DATA_HOME: '/workspace/.opencode-state/data',
      XDG_STATE_HOME: '/workspace/.opencode-state/state',
      XDG_CACHE_HOME: '/workspace/.opencode-state/cache'
    }
  });
  check('the server starts', started.started === true);
  check('the first start is not a reuse', started.reused === false);

  const again = await call('POST', `/sessions/${sessionId}/opencode/start`, {
    port: 4096,
    directory: '/workspace',
    env: { OPENCODE_CONFIG_CONTENT: '{}' }
  });
  check('a second start adopts the live server', again.reused === true);

  const path = await fetch(`${base}/sessions/${sessionId}/proxy/path`, {
    headers: { authorization: `Bearer ${token}` }
  });
  check('the proxy reaches OpenCode', path.status === 200);

  // The one thing a buffering proxy would break: a frame has to arrive while
  // the stream is still open, not when it closes.
  const controller = new AbortController();
  const events = await fetch(`${base}/sessions/${sessionId}/proxy/event`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal
  });
  check(
    'the event stream is SSE',
    events.status === 200 &&
      (events.headers.get('content-type') ?? '').includes('text/event-stream')
  );
  const frame = await Promise.race([
    events.body.getReader().read(),
    new Promise((resolve) => setTimeout(() => resolve({ value: undefined }), 10_000))
  ]);
  check(
    'a frame arrives before the stream ends',
    events.status === 200 && Boolean(frame.value?.length)
  );
  controller.abort();
}

// --- harness ---------------------------------------------------------------

function check(what, ok) {
  if (ok) {
    passes += 1;
    console.log(`  ok    ${what}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${what}`);
  }
}

async function call(method, path, body) {
  const response = await request(method, path, body, token);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function status(method, path, body, bearer = token) {
  const response = await request(method, path, body, bearer);
  await response.text();
  return response.status;
}

function request(method, path, body, bearer) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

async function runQuiet(bin, args) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

function parseArgs(argv) {
  const parsed = {
    image: process.env.OC_AGENT_IMAGE ?? 'opencode-session:latest',
    opencode: true,
    keep: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--image') {
      parsed.image = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--no-opencode') {
      parsed.opencode = false;
    } else if (argv[index] === '--keep') {
      parsed.keep = true;
    } else {
      console.error(`Unknown option: ${argv[index]}`);
      process.exit(2);
    }
  }
  return parsed;
}
