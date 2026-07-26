# opencode-cloud

An OpenCode Hub on Cloudflare Workers, Durable Objects, Containers, and R2. One
Worker hostname serves a session dashboard and routes traffic to any number of
independently sleeping OpenCode containers.

The container integration follows Cloudflare's
[`sandbox-sdk/examples/opencode`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)
example. This repository pins Sandbox SDK/container image `0.12.3` and OpenCode
`1.18.4` together.

## Hub architecture

- `/` is the Hub dashboard, a self-built SPA (`web/`, Vite + React) served from
  the same Worker on the same origin. Its composer starts a session from a
  repository, a model and a prompt; below it, the dashboard lists every session
  with one status badge and its last activity.
- `/sessions/:id` is the conversation view: the transcript is read once and then
  kept current by that session's event stream, and the composer continues the
  thread (optionally on a different model) or interrupts a running agent. A
  sleeping session still shows its full history, read from the R2 transcript
  mirror rather than from a container. A running container keeps that mirror
  within seconds of the live conversation: the Sandbox subscribes to OpenCode's
  own event stream and re-exports a few seconds after each burst, so a container
  that dies without quiescing loses seconds rather than a probe interval. The
  page also shows what the agent changed — branch, changed files, diff — and
  commits, pushes and opens a pull request from there. The stock OpenCode IDE
  remains one click away for terminals and file browsing until the self-built UI
  covers them.
- The `Hub` Durable Object is the strongly consistent session and instance
  registry.
- Every session has a `SessionAgent` Durable Object. Its alarm owns the
  start-work sequence and survives restarts and transient failures.
- Every instance also has a `LifecycleCoordinator` Durable Object. Its alarm
  polls OpenCode execution state and owns the semantic 10-minute idle deadline;
  browser HTTP, SSE, and WebSocket traffic never renews that deadline.
- Every immutable instance ID maps to its own Sandbox Durable Object and
  therefore its own container. Display names such as `amber-otter-4f2a` are
  generated randomly.
- Instances are provisioned lazily: creating a session records a stopped logical
  instance immediately, and its container starts on the first explicit wake.

### Why the single-domain router is path based

The stock OpenCode SPA cannot be mounted transparently below
`/instances/<id>`: it uses root-relative assets, root SPA routes, and
`location.origin` as its default server. The Hub therefore separates UI and
server routing:

- `POST /api/instances/<id>/wake` is the only external operation that may
  start a stopped runtime. It returns a launch URL containing a fresh runtime
  epoch.
- `/?_hub=<id>&_runtime=<epoch>` loads that instance's OpenCode UI shell.
- `/ui/<id>/<epoch>/__hub-v<version>/*` serves a versioned UI asset graph from the
  selected instance. Versioning the path, rather than only the entry module's
  query string, keeps lazy ESM chunks and their shared context providers in one
  browser module graph.
- `/gateway/<id>/<epoch>/*` is the OpenCode server base URL. The Worker strips the
  prefix and streams HTTP, SSE, and terminal WebSocket traffic to that
  instance's port 4096.

The small bootstrap loaded with the UI selects the path-based gateway as
OpenCode's default server and keeps the instance marker on SPA history URLs.
This avoids cookies, so separate tabs do not use a cookie to decide which
instance receives API traffic.

The Worker and Sandbox both validate the runtime epoch before forwarding. Once
the coordinator begins shutdown, old tabs receive HTTP 410; reconnecting an
event stream or keeping the UI open cannot restart the container.

Wildcard subdomains would be simpler if they become available: the Worker
could route `<instance>.example.com` directly and stock OpenCode could use that
origin without UI adaptation. The current design works with one exact hostname.

## Workspaces and repository provisioning

There is one container image. It installs OpenCode, `gh`, Wrangler, and the
bundled credentials, and leaves `/workspace` empty; repositories are never baked
into the image.

GitHub is the only source for the catalog a session can be started from: the Hub
lists every repository the token can push to, sorted by recent activity, and
caches the answer for ten minutes. Archived and read-only repositories are left
out — a session that cannot push its work cannot finish. A failed refresh serves
the last good answer; with nothing cached the dashboard shows the error rather
than an empty picker, and no session can be started until it is fixed. The
composer's *刷新仓库* button skips the cache (`GET /api/catalog?refresh=1`) for a
repository created a minute ago.

The token is committed in `src/github-catalog.ts` alongside this image's other
bundled credentials, and is only ever used for `GET /user/repos`. Setting a
`GITHUB_TOKEN` secret overrides it, which is where this should end up:

```bash
pnpm wrangler secret put GITHUB_TOKEN
```

The repository chosen for a session is copied onto the session, the instance and
the Sandbox at creation, and everything afterwards asks the checkout rather than
the catalog — its directory is `/workspace/<repoKey>`, its remote and default
branch come from git. So a session survives its repository being renamed, leaving
the account, or GitHub being unreachable; only *starting* one needs the catalog.

The first wake shallow-clones into `/workspace/<repoKey>` before the OpenCode
server starts; later wakes restore the workspace snapshot and run a best-effort
`git fetch origin` without touching the working tree. A clone failure fails the
wake; a fetch failure only logs a warning.

Every entry clones over SSH regardless of where the catalog came from, so the
bundled image key must be authorized for it on GitHub — public repositories
included. The token decides what is *offered*; the key decides what can be
*cloned*.

All instances use `/workspace` as the OpenCode working directory and persist
that complete directory in instance snapshots.

## Sessions

A session is the product-level unit of work: one repository, one model, one
prompt thread, one container. Creating a session from the Hub composer needs no
further interaction — submitting the form returns immediately and the work
starts inside the container:

1. The Hub creates the session and its instance (session id = instance id) and
   hands the prompt to that session's `SessionAgent` Durable Object.
2. The agent's alarm wakes the runtime through the normal explicit-intent path,
   which restores the workspace snapshot and provisions the repository.
3. It takes a short work lease, creates the OpenCode session bound to
   `/workspace/<repoKey>`, and calls `session.promptAsync`.
4. `promptAsync` returns as soon as the container accepts the task, so nothing
   holds a connection while the agent works. The semantic activity probe sees
   the run as busy and the usual 10-minute idle stop follows completion.

Continuing a session takes the same path, whether or not its container is still
running. `POST /api/sessions/<id>/messages` puts the prompt on the agent's
durable queue and answers 202; if the container is asleep the agent wakes it,
restores the workspace and continues the *same* OpenCode session, so the whole
conversation is still there. The session page renders that wait as progress
instead of asking the user to press a wake button first.

Several messages sent during a wake are delivered in order and none twice. Two
mechanisms do that: prompts leave the queue one at a time and a `promptId` a
client resends is recognised whether it is still queued or already delivered;
and the agent waits for the first prompt of a batch to make the session busy
before handing over the next, because prompts arriving at an *idle* session
simultaneously race, while prompts arriving at a busy one join OpenCode's own
ordered queue. That queue may answer several messages in one agent turn — the
order is guaranteed, one turn per message is not.

Dispatch failures (a repository that cannot be cloned, a runtime that will not
wake) are retried three times with backoff, then the session stays `failed` with
the underlying error on the record and a retry button in the dashboard.

Model choices come from the provider catalog in `src/opencode-config.ts`; a
session stores the `providerID/modelID` reference and unknown references are
rejected at the API boundary.

Session state (`queued` / `starting` / `working` / `failed`) describes dispatch
only. Container state stays in the instance runtime status, so a `working`
session may be busy, idle, or already asleep.

Because those are two state machines, the API also returns a single `status` the
UI renders as one badge: deletion and dispatch failures outrank everything, an
unfinished dispatch describes the session better than the container it is waking
does, and once every prompt has been handed over the container is what the badge
follows.

## Prerequisites

- Docker is running locally.
- Node.js and pnpm are installed.
- Deploying Containers requires a Cloudflare Workers Paid plan.

## Production access control

The Hub exposes a terminal inside an image that contains deployment credentials,
so production requests fail closed unless they carry a valid Cloudflare Access
application JWT. Put the one Hub hostname behind an Access self-hosted
application, then configure the exact team issuer and application Audience tag:

```bash
# Example issuer value: https://your-team.cloudflareaccess.com
pnpm wrangler secret put ACCESS_TEAM_DOMAIN
pnpm wrangler secret put ACCESS_POLICY_AUD
```

The Worker validates the `Cf-Access-Jwt-Assertion` signature, issuer, and
audience against Access's rotating JWKS. Keep the default `workers.dev` route
disabled or protect it with the same policy so it cannot become a second entry
point. Local Wrangler requests are exempt only when
`PERSISTENCE_LOCAL_BUCKET=true` and the hostname is loopback.

## Run locally

```bash
git clone git@github.com:wangsijie/opencode-cloud.git
cd opencode-cloud
pnpm install
pnpm dev
```

Open <http://localhost:8787>. Building the container image for the first time
can take several minutes. Local development uses Wrangler's local R2 store via
`PERSISTENCE_LOCAL_BUCKET=true`.

If `HTTP_PROXY`/`HTTPS_PROXY` are set in the shell, Wrangler hangs after
"Preparing container image(s)": the image builds, but the server never listens
and every request times out with nothing in the log. `NO_PROXY` does not help.
Start it with those variables unset:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy pnpm dev
```

A second `wrangler dev` already holding the port fails the same silent way, so
check for a stale process before blaming the proxy. `.wrangler/state` holds only
local Durable Object and R2 data; deleting it recovers a wedged local run.

`pnpm dev` builds the Hub SPA before starting Wrangler, because the Worker
serves it from `web/dist` and that directory is not checked in. When working on
the front end, run the Vite dev server alongside it for hot reload:

```bash
pnpm dev:web
```

It serves <http://localhost:5173> and proxies every Worker-owned route to
`wrangler dev`, so the UI talks to real Durable Objects and real containers.

Local-mode restore pushes the whole snapshot archive through the container
control-plane file API, which rejects large bodies (HTTP 413). Large repository
workspaces (for example `logto`) therefore cannot be restored after a stop in
local development; production restores use presigned R2 URLs downloaded inside
the container and are unaffected. Verify snapshot/restore locally with a small
repository. Stale `cloudflare/proxy-everything` helper containers from crashed
`wrangler dev` sessions can also wedge startup; remove them with `docker rm -f`
if the dev server never becomes ready.

The shared Base stage installs OpenCode, `gh`, and Wrangler. OpenCode data,
state, and cache are kept below `/workspace`, so they are part of each instance
snapshot alongside any checked-out repositories.

## Session API

```bash
# Repository and model choices for the composer. The repository list is
# GitHub's, cached for ten minutes; `?refresh=1` skips that cache. A listing
# failure with nothing cached answers 500 rather than an empty list.
curl http://localhost:8787/api/catalog

# List sessions with their dispatch phase and live instance state.
curl http://localhost:8787/api/sessions

# Start a session. Returns HTTP 202 immediately; `model` defaults to the
# configured default model.
curl -X POST http://localhost:8787/api/sessions \
  -H 'Content-Type: application/json' \
  --data '{"repoKey":"logto","model":"vwnpc/ag/gemini-3.6-flash-high","prompt":"Fix the lint errors in packages/core"}'

# Inspect one session.
curl http://localhost:8787/api/sessions/<session-id>

# Read the transcript. Never wakes a container: a running one is read live
# (`"source":"container"`), a stopped one is served from its R2 mirror
# (`"source":"mirror"` plus the `mirroredAt` the export was taken at).
# `X-OpenCode-Hub-Transcript-{State,Source,At,Mirrored-At}` carry the same
# facts in headers.
curl http://localhost:8787/api/sessions/<session-id>/messages

# Follow the session live. Also never wakes anything, and the stream is
# expected to end — an EventSource reconnects, and the state frame it gets
# back is how the page learns the session woke or went to sleep.
curl -N http://localhost:8787/api/sessions/<session-id>/events

# Continue the conversation. Returns HTTP 202 whether the container is running
# or asleep: a prompt to a sleeping session is queued and wakes it. `model`
# switches models, and `promptId` makes a retried request the same prompt
# rather than a second one.
curl -X POST http://localhost:8787/api/sessions/<session-id>/messages \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"Now add a test for it"}'

# What the agent changed in the checkout: branch, changed files and the diff
# against HEAD. Unlike every other read this one needs a running container —
# the working tree only exists inside one — so it refuses on a sleeping session
# rather than waking it.
curl http://localhost:8787/api/sessions/<session-id>/changes

# Commit, push, and optionally open a pull request. Never commits onto the
# repository's default branch: work lands on `opencode/<session-id>`, created on
# the first publish and reused afterwards, unless `branch` names another one.
curl -X POST http://localhost:8787/api/sessions/<session-id>/publish \
  -H 'Content-Type: application/json' \
  --data '{"message":"Fix the lint errors","pullRequest":{"title":"Fix the lint errors"}}'

# Rename or archive. Neither touches the container.
curl -X PATCH http://localhost:8787/api/sessions/<session-id> \
  -H 'Content-Type: application/json' \
  --data '{"archived":true}'

# The default list hides archived sessions; `?archived=1` shows only those and
# `?archived=all` shows everything.
curl 'http://localhost:8787/api/sessions?archived=1'

# Interrupt a running agent, leaving the conversation intact.
curl -X POST http://localhost:8787/api/sessions/<session-id>/abort

# Re-run a failed start sequence.
curl -X POST http://localhost:8787/api/sessions/<session-id>/retry

# Delete the session together with its container and snapshots (HTTP 202).
curl -X DELETE http://localhost:8787/api/sessions/<session-id>
```

Sessions carry their own accounting and housekeeping. Tokens and cost are summed
from the assistant messages OpenCode priced and ride along on the transcript
mirror, so the list shows them without touching a container; OpenCode's own
title for a conversation replaces the first line of the opening prompt once it
has one, unless the session has been renamed by hand; and archiving takes a
session out of the default list while keeping its container, history and mirror
— sending it a message brings it straight back. The browser's own notification
fires when an agent stops working, which needs no push service and no
server-side subscription, and therefore only works while a tab is open.

Reading a session — the list, the transcript, the event stream — never starts a
container. Only creating a session, sending it a message, and opening the stock
IDE do, because each is an explicit request for a running container.

## Instance API

Instances are created only as part of a session. What remains is the operational
surface for one container: reading its state, driving its runtime, and the
deletion path that session deletion delegates to.

```bash
# List instances with live container and persistence state.
curl http://localhost:8787/api/instances

# Inspect one instance.
curl http://localhost:8787/api/instances/<instance-id>

# Explicitly wake it and receive the epoch-bearing UI launch URL.
curl -X POST http://localhost:8787/api/instances/<instance-id>/wake

# Create a snapshot without stopping.
curl -X POST http://localhost:8787/api/instances/<instance-id>/checkpoint

# Snapshot and stop. Only a later explicit wake starts and restores it.
curl -X POST http://localhost:8787/api/instances/<instance-id>/stop

# Queue container destruction and permanent R2 cleanup (returns HTTP 202).
curl -X DELETE http://localhost:8787/api/instances/<instance-id>

# Programmatic OpenCode SDK smoke test for one instance.
curl -X POST http://localhost:8787/api/instances/<instance-id>/test
```

## Persistence and deletion guarantees

The container filesystem is ephemeral after sleep. Each Sandbox Durable Object
stores its own latest `/workspace` backup handle and restores it once per fresh
runtime.

- The normal 10-minute idle stop begins only after all known legacy locations'
  `/session/status` responses and the process-wide v2 `/api/session/active`
  response agree that no session is executing. Probe failure is treated as
  unknown and fails safe by keeping the container running.
- Work-starting gateway calls carry a short durable lease so a fast task that
  starts and finishes between probes still resets the idle window.
- At the deadline, admission closes first; Sandbox waits for admitted request
  handshakes to drain, confirms OpenCode is still idle, checkpoints, and stops.
- Open browser tabs, SSE streams, WebSockets, and status polling do not count as
  execution and therefore do not keep the runtime alive.
- Just before that checkpoint, while the OpenCode server is still up, the whole
  session transcript is exported to `transcripts/<session-id>/latest.json`, so a
  sleeping session's history stays readable without waking anything. A running
  container re-exports at most once a minute, driven by the activity probe and
  only when something has actually changed, which bounds what an unexpectedly
  killed container loses to roughly one refresh interval. The Durable Object
  keeps only the summary — conversation id, export time, message count — which
  is what the session list renders. Export failures are logged and never block a
  stop.
- Only the latest successful snapshot is retained during normal operation.
- A backup ledger retains every handle whose R2 deletion has not yet been
  confirmed, so failed stale-backup cleanup remains retryable.
- Instance deletion first marks the registry record as `deleting`, which blocks
  new UI/API traffic, and returns `202` immediately. A Hub Durable Object alarm
  waits for in-flight startup/checkpoint/stop operations, destroys the container
  without making another snapshot, deletes every object below each tracked
  `backups/<backup-id>/` prefix and below `transcripts/<session-id>/`, clears the
  instance Durable Object storage, then removes the Hub record. This keeps slow
  container teardown out of the client request lifetime.
- If any deletion step fails, the record becomes `delete_failed`; the dashboard
  can retry while the backup ledger is still available.

No distributed transaction can cover both R2 and Durable Object storage. The
ordering above prevents losing backup handles before R2 confirms deletion. An
R2 lifecycle rule for `backups/` is still recommended for uploads interrupted
before a handle can be recorded, and for orphaned snapshots created by older
versions of this project. Transcript mirrors are a single overwritten object per
session, so they need no such rule.

Before the first production deployment, create the bucket from
`wrangler.jsonc`:

```bash
pnpm wrangler r2 bucket create opencode-cloud-backups
```

Production backup uploads use presigned R2 URLs. Configure an R2 Object Read &
Write token and the Cloudflare account ID as Worker secrets:

```bash
pnpm wrangler secret put CLOUDFLARE_R2_ACCOUNT_ID
pnpm wrangler secret put R2_ACCESS_KEY_ID
pnpm wrangler secret put R2_SECRET_ACCESS_KEY
```

## GitHub SSH and bundled CLI access

The image includes a dedicated Ed25519 key at `/root/.ssh/id_ed25519`. Add
`docker/ssh/id_ed25519.pub` to GitHub as a deploy key and enable write access if
the sandbox should push. Alternatively, add it as an account SSH key when it
needs access to multiple repositories.

Git is configured as `wangsijie <sijiewg@gmail.com>` with SSH commit signing.
Add the same public key as a GitHub signing key if sandbox commits should appear
as Verified.

The private key and the `gh`/Wrangler credentials below `docker/auth` are
intentionally bundled for this private image. Anyone who can read the repository
or pull the image can use them. Keep their permissions narrow, rotate them if
the artifacts are exposed, and rebuild the image after a credential rotation.

## OpenCode configuration

The complete configuration is in `src/opencode-config.ts`. The default and
small model are both `vwnpc/ag/gemini-3.6-flash-high`. Provider endpoints, credentials, models,
limits, costs, variants and input modalities are managed in that file. The Hub
also derives its session model picker from it: a model removed here disappears
from the composer, and any existing session pinned to it fails on its next
dispatch, so retire a model only after its sessions are finished or repointed.

This private repository intentionally commits provider credentials. Rotate them
before changing repository visibility or access.

## Verify and deploy

Pushing to `master` deploys to production. `.github/workflows/deploy.yml` runs
the tests, the typecheck and `pnpm run deploy` on every push, so there is no
separate release step — run the same gates locally first:

```bash
pnpm test
pnpm run typecheck
```

`pnpm run deploy` is still available for an out-of-band rollout, and needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Anything
a deploy cannot undo — a Durable Object migration, a change of R2 key layout —
has to be prepared before the push, not after it.

The `v2` Durable Object migration creates the Hub registry, `v3` added the
now-retired `LogtoSandbox` class, `v4` adds the per-instance lifecycle
coordinator, `v5` adds the per-session dispatch agent, and `v6` deletes
`LogtoSandbox` together with its Durable Object storage.

`v6` was applied on 2026-07-26 after every pre-session instance had been deleted
through the Hub. That order was required: deletion is what removes an instance's
R2 snapshots, and the backup handles lived in the storage the migration erases.
The orphaned `opencode-cloud-logtosandbox` container application was removed with
`wrangler containers delete` in the same pass.
