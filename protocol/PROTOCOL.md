# Sandbox Host Protocol (v1)

One HTTP API, implemented by every sandbox host. A *host* runs session
containers and exposes primitives — start/stop, exec, file I/O, HTTP proxy —
and nothing else: no session state, no credentials at rest, no business logic.

Two implementations exist:

| Host | Transport from the site worker | Auth | `capabilities.snapshots` |
|---|---|---|---|
| Cloudflare host worker (`host/`) | Service binding `fetch` (never public) | none (binding is private) | `true` (R2 via the sandbox SDK) |
| Docker agent (`agent/`) on a Mac mini / Linux box | Public HTTPS | `Authorization: Bearer <token>` | `false` (named volume persists) |

The site worker holds the single protocol client and chooses the transport per
session. Everything below is identical across transports.

Shared TypeScript shapes live in [`types.ts`](./types.ts); route builders and
the dispatch table in [`routes.ts`](./routes.ts). The agent is dependency-free
JavaScript and mirrors this document.

## Design grounding (verified against `@cloudflare/sandbox@0.12.3`)

- **Snapshot handles are self-contained.** The SDK's `createBackup()` returns a
  serializable `DirectoryBackup` (`{id, dir, localBucket?}`) whose R2 keys are
  derived from `id`; `restoreBackup(handle)` takes it back explicitly and the
  SDK keeps no hidden Durable Object storage about backups. The docs say to
  store the handle "anywhere (KV, D1, DO storage)". Hence snapshot endpoints
  pass handles opaquely and the ledger stays with the caller.
- **OpenCode server env derivation** (replicated by the client, passed to hosts
  as a plain env map): `OPENCODE_CONFIG_CONTENT = JSON.stringify(config)`; for
  each `config.provider[id]` except `cloudflare-ai-gateway`, an
  `options.apiKey ?? apiKey` string becomes `${id.toUpperCase()}_API_KEY`; the
  `cloudflare-ai-gateway` options map to `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_GATEWAY_ID`, `CLOUDFLARE_API_TOKEN`. Custom env is merged last
  and wins. The serve command is
  `cd <directory> && opencode serve --port <port> --hostname 0.0.0.0`, and
  readiness is `GET /path` on the serve port returning 200 within 180 s.
- **Streaming crosses both transports.** workerd streams `Response` bodies
  between workers over service bindings, and the site already pipes SSE
  responses across Durable Object RPC boundaries; the agent must likewise pipe
  proxy bodies unbuffered.

## Conventions

- **Session ids** appear as path segments and must match
  `^[A-Za-z0-9_-]{1,64}$`. Hosts reject anything else with 400
  `INVALID_REQUEST` before touching Docker or a container.
- **Requests and responses are JSON** (`content-type: application/json`)
  except the proxy route, which is verbatim HTTP.
- **Errors**: every non-2xx response carries
  `{ "code": "<HostErrorCode>", "message": "<human text>" }`. Codes:
  `UNAUTHORIZED` 401 · `INVALID_REQUEST` 400 · `SESSION_NOT_FOUND` 404 ·
  `FILE_NOT_FOUND` 404 · `DIR_NOT_FOUND` 404 · `CONTAINER_NOT_RUNNING` 503 ·
  `EXEC_TIMEOUT` 408 · `OPENCODE_START_FAILED` 502 ·
  `SNAPSHOT_UNSUPPORTED` 501 · `SNAPSHOT_NOT_FOUND` 404 · `HOST_ERROR` 500.
- **Auth**: remote hosts require `Authorization: Bearer <token>` on every
  route including `/healthz`, compared in constant time. The Cloudflare host
  worker has no public route; the service binding is the auth boundary and the
  header is omitted.
- **Idempotency**: `ensure`, `stop`, and `DELETE` are safe to repeat. `stop`
  on a stopped container returns `{stopped: true}`; `DELETE` of nothing
  returns `{removed: true}`.
- **Timeouts are the caller's problem beyond the documented host budgets.**
  Hosts bound `exec` by `timeoutMs` and `opencode/start` by 180 s; the client
  races everything else itself.

## Routes

### `GET /healthz`

Liveness + identity. → `HealthzResponse`:

```json
{
  "ok": true,
  "protocolVersion": 1,
  "provider": "docker",
  "capabilities": { "snapshots": false },
  "runtime": { "dockerVersion": "27.4.0" }
}
```

### `POST /sessions/:id/ensure` — body `EnsureRequest`

Bring the session's container to *running*, creating whatever is missing.
Idempotent. Docker host: create the named volume `oc-vol-<id>` and container
`oc-session-<id>` if absent, start if stopped. Cloudflare host: boot the bound
container. → `EnsureResponse { running, created, workspaceCreated }` —
`workspaceCreated: true` on a volume-persistent host means the volume did not
exist before this call (the caller treats that as workspace loss after the
first wake). Ephemeral hosts mirror `created`.

### `GET /sessions/:id`

Platform truth for the poll beat. → `SessionStateResponse
{ exists, running, startedAt?, changedAt?, exitCode? }`. Never boots anything.

### `POST /sessions/:id/stop` — body `StopRequest { timeoutSec? }`

Bounded stop: graceful for `timeoutSec` (default 5), then SIGKILL. →
`StopResponse { stopped }`; `stopped: false` means termination is still
pending and the caller will retry. Workspace storage is untouched.

### `DELETE /sessions/:id`

Destroy the container **and** its workspace storage (Docker: `rm -f` the
container, remove the volume). → `RemoveResponse { removed: true }` — including
when nothing was there. `removed: false` means termination is still pending and
the caller retries, as with `stop`.

### `POST /sessions/:id/exec` — body `ExecRequest`

Run `["sh", "-lc", command]` inside the container — multi-line scripts are the
intended use, so orchestration batches many steps into one round trip. `cwd`
and `env` apply to the shell. Output is captured up to 2 MiB per stream, then
truncated with `truncated` set. → `ExecResponse
{ success, exitCode, stdout, stderr, truncated? }` (the shape site code
already consumes). A hit of `timeoutMs` kills the shell and returns 408
`EXEC_TIMEOUT`. Requires a running container (503 `CONTAINER_NOT_RUNNING`).

### `POST /sessions/:id/files/write-batch` — body `WriteBatchRequest`

Write N files in one round trip. For each entry: create parent directories,
write `content` (decode base64 when `encoding: "base64"`), then `chmod mode`
when given. Atomic per file, not per batch; the first failure aborts with the
error and `written` reflects completed files only on success responses. →
`WriteBatchResponse { written }`.

### `POST /sessions/:id/files/read` — body `ReadFileRequest { path }`

→ `ReadFileResponse { content, encoding }` — `utf-8` for valid text (host
checks for NUL/invalid sequences), else base64. Missing file → 404
`FILE_NOT_FOUND`.

### `POST /sessions/:id/files/exists` — body `ExistsRequest { path }`

→ `ExistsResponse { exists }`.

### `POST /sessions/:id/files/list` — body `ListFilesRequest { path, includeHidden? }`

Single directory read (no recursion). → `ListFilesResponse { files:
HostFileInfo[] }` with `type ∈ file|directory|symlink|other`, byte `size`,
optional ISO `modifiedAt`. Missing directory → 404 `DIR_NOT_FOUND`.

### `POST /sessions/:id/opencode/start` — body `OpencodeStartRequest`

Start the OpenCode server: if a process matching
`opencode serve --port <port>` is already alive, reuse it; otherwise spawn
`cd <directory> && opencode serve --port <port> --hostname 0.0.0.0` detached
with exactly the given `env`. Then poll `GET /path` on that port until 200
(budget 180 s). → `OpencodeStartResponse { started, reused }`. On failure →
502 `OPENCODE_START_FAILED` with captured stderr in `message`.

The budget is the only timing this protocol fixes; the *pacing* is the host's,
and it is worth getting right. `opencode serve` binds its port roughly a second
before it answers `/path`, so a probe that lands in that window connects and
then hangs — and it hangs for the probe's own timeout, not the server's
remaining startup. A host polling with one flat multi-second socket timeout
therefore reports a server that was ready at 1.6 s as a start of 6.6 s. Probe
cheaply and often, and lengthen the timeout only for a probe that actually hung.

### `ANY /sessions/:id/proxy/<path>?<query>`

Reverse proxy to the container's OpenCode port. Method, request body, query
string, and headers are forwarded verbatim — minus transport headers
(`Authorization`, `Host`). Response bodies stream unbuffered; SSE
(`text/event-stream`) must flow chunk-by-chunk with no idle timeout on the
host or any fronting proxy. Container not running → 503
`CONTAINER_NOT_RUNNING` (the JSON error, never a hang).

### `POST /sessions/:id/snapshot` — body `SnapshotRequest` *(snapshots hosts only)*

Archive `dir` to durable storage and return an opaque, serializable
`SnapshotHandle`. The caller owns the ledger of handles; the host stores
nothing. Hosts without the capability → 501 `SNAPSHOT_UNSUPPORTED`.

### `POST /sessions/:id/snapshot/restore` — body `SnapshotRestoreRequest { handle }`

Restore a previously returned handle into its directory. Handle's objects
gone → 404 `SNAPSHOT_NOT_FOUND`. Hosts without the capability → 501.

Snapshot *deletion* is not part of the protocol: the archive bucket is owned
by the operator, and the site worker (which holds the ledger and the same R2
binding) deletes objects directly during purge.

## Container contract

Whatever image a host runs must provide: `sh`, `git`, `openssh-client`, `gh`,
`node`/`npm`, and `opencode` on PATH; a writable `/workspace`; outbound
network. OpenCode serves HTTP on the port given to `opencode/start` (the site
uses 4096). The Docker host publishes that port to loopback
(`-p 127.0.0.1:0:4096`) and proxies via the published port, because macOS
cannot reach container IPs from the host.

## Versioning

`protocolVersion` in `/healthz` is bumped only for breaking changes; additive
fields and routes are not breaking. Client and hosts are assumed deployed in
lockstep or backward-compatible.
