import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HostClient,
  HostError,
  isContainerNotRunning,
  opencodeServerEnv,
  remoteTransport,
  serviceBindingTransport
} from '../src/host-client.ts'

/** A transport that records what it was asked for and answers from a script. */
function recordingTransport(handler) {
  const calls = []
  return {
    calls,
    fetch(path, init = {}) {
      calls.push({ path, ...init })
      return Promise.resolve(handler(path, init))
    }
  }
}

function jsonOk(value) {
  return new Response(JSON.stringify(value), { status: 200 })
}

function client(handler) {
  const transport = recordingTransport(handler)
  return {
    transport,
    host: new HostClient(transport, 'sess-1', { snapshots: true })
  }
}

test('every operation maps to its protocol route', async () => {
  const { host, transport } = client(() => jsonOk({ ok: true }))
  await host.ensure()
  await host.state()
  await host.stop(0)
  await host.remove()
  await host.exec('true')
  await host.writeBatch([{ path: '/a', content: 'x' }])
  await host.readFile('/a')
  await host.exists('/a')
  await host.listFiles('/dir')
  await host.opencodeStart({ port: 4096, env: {} })
  await host.snapshot({ dir: '/workspace' })
  await host.snapshotRestore({ id: 'b1', dir: '/workspace' })
  assert.deepEqual(
    transport.calls.map((call) => `${call.method} ${call.path}`),
    [
      'POST /sessions/sess-1/ensure',
      'GET /sessions/sess-1',
      'POST /sessions/sess-1/stop',
      'DELETE /sessions/sess-1',
      'POST /sessions/sess-1/exec',
      'POST /sessions/sess-1/files/write-batch',
      'POST /sessions/sess-1/files/read',
      'POST /sessions/sess-1/files/exists',
      'POST /sessions/sess-1/files/list',
      'POST /sessions/sess-1/opencode/start',
      'POST /sessions/sess-1/snapshot',
      'POST /sessions/sess-1/snapshot/restore'
    ]
  )
})

test('a session id that could escape its path segment is refused', () => {
  assert.throws(
    () => new HostClient(recordingTransport(() => jsonOk({})), '../x', {
      snapshots: false
    }),
    /Invalid session id/
  )
})

test('bodies are sent as JSON and answers are parsed', async () => {
  const { host, transport } = client(() => jsonOk({ exists: true }))
  const result = await host.exists('/workspace/.git')
  assert.deepEqual(result, { exists: true })
  assert.equal(
    transport.calls[0].headers['content-type'],
    'application/json'
  )
  assert.deepEqual(JSON.parse(transport.calls[0].body), {
    path: '/workspace/.git'
  })
})

test('a protocol error keeps its code so callers can branch on it', async () => {
  const { host } = client(
    () =>
      new Response(
        JSON.stringify({
          code: 'CONTAINER_NOT_RUNNING',
          message: 'The session container is not running'
        }),
        { status: 503 }
      )
  )
  const error = await host.exec('true').then(
    () => undefined,
    (thrown) => thrown
  )
  assert.ok(error instanceof HostError)
  assert.equal(error.code, 'CONTAINER_NOT_RUNNING')
  assert.equal(error.status, 503)
  assert.ok(isContainerNotRunning(error))
})

test('a non-protocol failure still becomes a typed error', async () => {
  const { host } = client(() => new Response('<html>gateway</html>', { status: 502 }))
  const error = await host.state().then(
    () => undefined,
    (thrown) => thrown
  )
  assert.ok(error instanceof HostError)
  assert.equal(error.code, 'HOST_ERROR')
  assert.equal(error.status, 502)
})

test('a 503 without a body is read as a stopped container', async () => {
  const { host } = client(() => new Response('', { status: 503 }))
  const error = await host.state().then(
    () => undefined,
    (thrown) => thrown
  )
  assert.ok(isContainerNotRunning(error))
})

test('the proxy keeps path and query and drops the runtime epoch header', async () => {
  const { host, transport } = client(() => jsonOk({}))
  await host.proxyFetch(
    new Request('http://localhost:4096/event?directory=%2Fworkspace', {
      headers: {
        accept: 'text/event-stream',
        'x-opencode-hub-runtime': 'epoch-1'
      }
    })
  )
  const call = transport.calls[0]
  assert.equal(call.path, '/sessions/sess-1/proxy/event?directory=%2Fworkspace')
  assert.equal(call.headers.get('accept'), 'text/event-stream')
  assert.equal(call.headers.get('x-opencode-hub-runtime'), null)
})

test('the service binding transport carries no credentials', async () => {
  const seen = []
  const transport = serviceBindingTransport({
    fetch(url, init) {
      seen.push({ url, init })
      return Promise.resolve(jsonOk({ ok: true }))
    }
  })
  await transport.fetch('/healthz', { method: 'GET' })
  assert.equal(seen[0].url, 'http://sandbox-host/healthz')
  assert.equal(seen[0].init.headers, undefined)
})

test('the remote transport bearers every request and never doubles the slash', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    seen.push({ url, init })
    return Promise.resolve(jsonOk({ ok: true }))
  }
  try {
    const transport = remoteTransport('https://mini.example.com/', 'tok-123')
    await transport.fetch('/healthz')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen[0].url, 'https://mini.example.com/healthz')
  assert.equal(seen[0].init.headers.get('authorization'), 'Bearer tok-123')
})

test('the server environment carries the config and one key per provider', () => {
  const env = opencodeServerEnv({
    model: 'anthropic/claude',
    provider: {
      anthropic: { options: { apiKey: 'sk-ant' } },
      openai: { apiKey: 'sk-openai' },
      unkeyed: { models: {} }
    }
  })
  assert.equal(
    env.OPENCODE_CONFIG_CONTENT,
    JSON.stringify({
      model: 'anthropic/claude',
      provider: {
        anthropic: { options: { apiKey: 'sk-ant' } },
        openai: { apiKey: 'sk-openai' },
        unkeyed: { models: {} }
      }
    })
  )
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant')
  assert.equal(env.OPENAI_API_KEY, 'sk-openai')
  assert.equal('UNKEYED_API_KEY' in env, false)
})

test('the AI gateway becomes its three variables, not a key', () => {
  const env = opencodeServerEnv({
    provider: {
      'cloudflare-ai-gateway': {
        options: {
          accountId: 'acct',
          gatewayId: 'gw',
          apiToken: 'tok'
        }
      }
    }
  })
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acct')
  assert.equal(env.CLOUDFLARE_GATEWAY_ID, 'gw')
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'tok')
  assert.equal('CLOUDFLARE-AI-GATEWAY_API_KEY' in env, false)
})

test('extra variables are merged last and win', () => {
  const env = opencodeServerEnv(
    { provider: { anthropic: { options: { apiKey: 'from-config' } } } },
    { ANTHROPIC_API_KEY: 'from-operator', XDG_DATA_HOME: '/workspace/x' }
  )
  assert.equal(env.ANTHROPIC_API_KEY, 'from-operator')
  assert.equal(env.XDG_DATA_HOME, '/workspace/x')
})

test('a config without providers still carries itself', () => {
  const env = opencodeServerEnv({ model: 'a/b' })
  assert.deepEqual(Object.keys(env), ['OPENCODE_CONFIG_CONTENT'])
})
