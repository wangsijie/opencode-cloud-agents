import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HostRequestError,
  capOutput,
  errorToResponse,
  forwardedHeaders,
  hostErrorResponse,
  hostErrorStatus,
  isExecTimeout,
  parentDirectory,
  parseWriteBatch,
  proxyTargetUrl,
  readJsonBody,
  shellQuote,
  stringMap
} from '../host/support.ts'
import { EXEC_OUTPUT_LIMIT_BYTES } from '../protocol/types.ts'

async function body(response) {
  return JSON.parse(await response.text())
}

test('every error code answers with its documented status', () => {
  assert.equal(hostErrorStatus('UNAUTHORIZED'), 401)
  assert.equal(hostErrorStatus('INVALID_REQUEST'), 400)
  assert.equal(hostErrorStatus('CONTAINER_NOT_RUNNING'), 503)
  assert.equal(hostErrorStatus('EXEC_TIMEOUT'), 408)
  assert.equal(hostErrorStatus('OPENCODE_START_FAILED'), 502)
  assert.equal(hostErrorStatus('SNAPSHOT_UNSUPPORTED'), 501)
  assert.equal(hostErrorStatus('HOST_ERROR'), 500)
})

test('error responses carry the protocol body', async () => {
  const response = hostErrorResponse('FILE_NOT_FOUND', 'no such file')
  assert.equal(response.status, 404)
  assert.equal(
    response.headers.get('content-type'),
    'application/json; charset=utf-8'
  )
  assert.deepEqual(await body(response), {
    code: 'FILE_NOT_FOUND',
    message: 'no such file'
  })
})

test('SDK error codes become protocol codes', async () => {
  const missing = Object.assign(new Error('gone'), { code: 'FILE_NOT_FOUND' })
  const response = errorToResponse(missing)
  assert.equal(response.status, 404)
  assert.equal((await body(response)).code, 'FILE_NOT_FOUND')

  const unavailable = Object.assign(new Error('down'), {
    code: 'CONTAINER_UNAVAILABLE'
  })
  assert.equal(errorToResponse(unavailable).status, 503)

  const backup = Object.assign(new Error('expired'), {
    code: 'BACKUP_EXPIRED'
  })
  assert.equal((await body(errorToResponse(backup))).code, 'SNAPSHOT_NOT_FOUND')
})

test('a route override reinterprets a missing path', async () => {
  const missing = Object.assign(new Error('gone'), { code: 'FILE_NOT_FOUND' })
  const response = errorToResponse(missing, { FILE_NOT_FOUND: 'DIR_NOT_FOUND' })
  assert.equal((await body(response)).code, 'DIR_NOT_FOUND')
})

test('an unmapped failure is a HOST_ERROR, not a leak', async () => {
  const response = errorToResponse(new Error('boom'))
  assert.equal(response.status, 500)
  assert.deepEqual(await body(response), {
    code: 'HOST_ERROR',
    message: 'boom'
  })
})

test('a HostRequestError keeps its own code', async () => {
  const response = errorToResponse(
    new HostRequestError('CONTAINER_NOT_RUNNING', 'not running')
  )
  assert.equal(response.status, 503)
  assert.equal((await body(response)).code, 'CONTAINER_NOT_RUNNING')
})

test('exec timeouts are recognised from the message', () => {
  assert.equal(isExecTimeout(new Error('Command timed out after 5000ms')), true)
  assert.equal(isExecTimeout(new Error('The operation was aborted')), true)
  assert.equal(isExecTimeout(new Error('exit status 1')), false)
})

test('an empty body is an empty object, and garbage is INVALID_REQUEST', async () => {
  assert.deepEqual(await readJsonBody(new Request('http://h/', {
    method: 'POST',
    body: ''
  })), {})
  await assert.rejects(
    readJsonBody(new Request('http://h/', { method: 'POST', body: 'nope' })),
    (error) => error instanceof HostRequestError && error.code === 'INVALID_REQUEST'
  )
  await assert.rejects(
    readJsonBody(new Request('http://h/', { method: 'POST', body: '[1]' })),
    (error) => error.code === 'INVALID_REQUEST'
  )
})

test('env maps must be flat strings', () => {
  assert.deepEqual(stringMap({ env: { A: '1' } }, 'env'), { A: '1' })
  assert.equal(stringMap({}, 'env'), undefined)
  assert.throws(() => stringMap({ env: { A: 1 } }, 'env'), {
    code: 'INVALID_REQUEST'
  })
})

test('write batches are validated before anything is written', () => {
  assert.deepEqual(
    parseWriteBatch({
      files: [
        { path: '/root/.ssh/id_ed25519', content: 'key', mode: '600' },
        { path: '/workspace/a.bin', content: 'AA==', encoding: 'base64' }
      ]
    }),
    [
      {
        path: '/root/.ssh/id_ed25519',
        content: 'key',
        encoding: 'utf-8',
        mode: '600'
      },
      { path: '/workspace/a.bin', content: 'AA==', encoding: 'base64' }
    ]
  )
  assert.throws(() => parseWriteBatch({ files: [] }), {
    code: 'INVALID_REQUEST'
  })
  assert.throws(() => parseWriteBatch({ files: [{ path: 'rel', content: '' }] }), {
    code: 'INVALID_REQUEST'
  })
  assert.throws(
    () => parseWriteBatch({ files: [{ path: '/a', content: '', mode: 'rwx' }] }),
    { code: 'INVALID_REQUEST' }
  )
  assert.throws(
    () => parseWriteBatch({ files: [{ path: '/a', content: '', encoding: 'hex' }] }),
    { code: 'INVALID_REQUEST' }
  )
})

test('shell quoting survives a single quote', () => {
  assert.equal(shellQuote('/workspace/it is'), `'/workspace/it is'`)
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
})

test('parent directories stop at the root', () => {
  assert.equal(parentDirectory('/root/.ssh/config'), '/root/.ssh')
  assert.equal(parentDirectory('/config'), undefined)
})

test('output over the cap is cut, and under it is untouched', () => {
  const small = capOutput('hello')
  assert.deepEqual(small, { text: 'hello', truncated: false })
  const big = capOutput('x'.repeat(EXEC_OUTPUT_LIMIT_BYTES + 10))
  assert.equal(big.truncated, true)
  assert.equal(big.text.length, EXEC_OUTPUT_LIMIT_BYTES)
})

test('the proxy target keeps the path and the query verbatim', () => {
  assert.equal(
    proxyTargetUrl(
      'https://host.invalid/sessions/s1/proxy/event?directory=%2Fworkspace%2Frepo',
      '/event',
      4096
    ),
    'http://container:4096/event?directory=%2Fworkspace%2Frepo'
  )
  assert.equal(
    proxyTargetUrl('https://host.invalid/sessions/s1/proxy/', '/', 4096),
    'http://container:4096/'
  )
})

test('the bearer token and host header never reach the container', () => {
  const forwarded = forwardedHeaders(
    new Headers({
      authorization: 'Bearer secret',
      host: 'host.invalid',
      accept: 'text/event-stream'
    })
  )
  assert.equal(forwarded.get('authorization'), null)
  assert.equal(forwarded.get('host'), null)
  assert.equal(forwarded.get('accept'), 'text/event-stream')
})
