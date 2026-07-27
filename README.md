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
  commits, pushes and opens a pull request from there. A workspace panel below
  it browses the checkout, which is what retired the stock OpenCode IDE.
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

### One origin, one API surface

The Hub is a single Worker hostname and nothing behind it is publicly routable.
Every browser request is either the SPA shell, its hashed assets, or an
`/api/*` route; the only thing that reaches a container is a Durable Object RPC
made inside the Worker.

That was not always true. Until M6 the stock OpenCode SPA was served through
this Worker as an escape hatch for terminals and file browsing, which needed a
public container gateway (`/gateway/<id>/<epoch>/*`), a versioned asset proxy
(`/ui/...`, `/assets/...`), a bootstrap script that virtualized `localStorage`,
and a regex patch of OpenCode's entry bundle. All of it is deleted. What it
existed for is now first-party:

- `GET /api/sessions/<id>/files?path=` lists a directory of the checkout, and
  `&read=1` returns one file's content (text capped at 256 KB, binaries
  described rather than rendered).

It refuses a sleeping session (HTTP 409) rather than waking one, and validates
the runtime epoch before any container call — a tab left open across a shutdown
cannot restart the container.

The other half of that retirement, a terminal, has been removed. Its PTY was
proxied through the Sandbox SDK's `stub.terminal()` onto container port 3000,
which `containerFetch` admits only during a control-plane operation, so it threw
on every attempt; behind a collapsed sidebar tab nobody ever found out. There is
no WebSocket route into a container today, and the Sandbox Durable Object
refuses an upgrade outright.

The upside of the retirement is that OpenCode upgrades are no longer coupled to
a bundle patch, and `/gateway/` no longer exists as a public route.

## Workspaces and repository provisioning

There is one container image. It installs OpenCode, `gh` and Wrangler, and
leaves `/workspace` empty; repositories are never baked into the image, and
neither are credentials — the SSH key, the `gh` login, git identity and
signing, extra environment variables and OpenCode skills are read from the
settings table and injected by the Worker on every wake
(`src/container-credentials.ts`).

GitHub is the only source for the catalog a session can be started from: the Hub
lists every repository the token can push to, sorted by recent activity, and
caches the answer for ten minutes. Archived and read-only repositories are left
out — a session that cannot push its work cannot finish. A failed refresh serves
the last good answer; with nothing cached the dashboard shows the error rather
than an empty picker, and no session can be started until it is fixed. The
composer's *Refresh repos* button skips the cache (`GET /api/catalog?refresh=1`) for a
repository created a minute ago.

The token is entered on the settings page (`github.token`) and doubles as the
container's `gh` CLI login for opening pull requests. A `GITHUB_TOKEN` wrangler
secret overrides the stored one when set.

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
SSH key configured on the settings page must be authorized for it on GitHub —
public repositories included. The token decides what is *offered*; the key
decides what can be *cloned*.

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
   holds a connection while the agent works. The agent waits for the run to
   show up as busy, releases its lease, and leaves the rest to the semantic
   activity probe; the usual 10-minute idle stop follows completion.

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

Model choices derive from the stored OpenCode config (`src/model-catalog.ts`);
a session stores the `providerID/modelID` reference and unknown references are
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

One admin password, set on first run. A fresh deployment shows a setup page —
type a password or have one generated and shown once — and stores a salted
PBKDF2 hash of it in the `settings` table ([src/access.ts](src/access.ts),
[src/password.ts](src/password.ts)). Signing in issues a random token whose
SHA-256 is a row in `admin_sessions`; the cookie carries the raw token, so the
database alone grants nothing. Changing the password (on the settings page,
current password required) clears that table, signing every browser out except
the one that made the change.

Everything under `/api/` requires it; `/api/auth` and `/api/setup` are the two
routes that answer without a session. The SPA shell and its assets do not:
they carry the sign-in and setup forms and nothing else worth reading. A
rejected request answers 401, which drops the open tab back to the form.
`wrangler dev` asks for the password too — there is no local bypass.

There is deliberately no rate limiting, which is enough for one operator on an
unlisted hostname and not much more. Between deploying and completing setup
the password is unset and anyone who finds the URL can claim it — finish setup
immediately after the first deploy. If this deployment ever grows a second
user or a guessable address, put it behind real identity — Cloudflare Access
in front of every route including the default `workers.dev` one, or a Zero
Trust tunnel.

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

### Front end only: mock mode

When the work is purely front end, none of that machinery is needed:

```bash
pnpm dev:mock
```

This is the Vite dev server alone — no Wrangler, no Docker, no D1. `VITE_MOCK=1`
makes `main.tsx` install an in-memory backend (`web/src/mock/`) behind the API
layer before the first render: every `/api` request is answered from fixtures,
and the session event stream is simulated. The fixtures cover one session per
UI state (streaming live, idle with a kitchen-sink transcript and subagents,
sleeping, waking, queued, starting, failed, lost, error, deleting, CJK and
overlong titles), plus rich changes/workspace/catalog/settings data.
One session streams a scripted reply forever; sending a prompt to a sleeping
session plays the whole queued → starting → cold-wake → reply arc. Mutations
(rename, delete, settings saves) work but live in memory and reset on
reload. The mock chunk is dev-only: `vite build` excludes it entirely (grep the
bundle for `OPENCODE_HUB_MOCK_FIXTURES` to prove it).

Local-mode restore pushes the whole snapshot archive through the container
control-plane file API, which rejects large bodies (HTTP 413). Large repository
workspaces (for example `logto`) therefore cannot be restored after a stop in
local development; production restores use presigned R2 URLs downloaded inside
the container and are unaffected. Verify snapshot/restore locally with a small
repository. Stale `cloudflare/proxy-everything` helper containers from crashed
`wrangler dev` sessions can also wedge startup; remove them with `docker rm -f`
if the dev server never becomes ready.

The shared Base stage installs OpenCode, `gh`, and Wrangler. OpenCode data and
state are kept below `/workspace`, so they are part of each instance snapshot
alongside any checked-out repositories; its cache lives there too but is
excluded from the snapshot, because restoring a cache costs more than rebuilding
one (see [Cold start](#cold-start)).

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

# Read a subagent's own conversation. OpenCode's `task` tool runs its work in a
# child session inside the same container; `?child=` narrows both the transcript
# and the event stream to it. Unlike the parent it has no R2 mirror, so a
# sleeping container answers `"state":"sleeping"` with no messages.
curl 'http://localhost:8787/api/sessions/<session-id>/messages?child=<opencode-session-id>'
curl -N 'http://localhost:8787/api/sessions/<session-id>/events?child=<opencode-session-id>'

# Where that subagent sits under the session that started it: the path from the
# root session down to it, which is also the check that the id belongs here at
# all (404 otherwise). Needs a running container, so a sleeping one answers 409.
curl 'http://localhost:8787/api/sessions/<session-id>/agent-session?child=<opencode-session-id>'

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

# Rename a session. Does not touch the container.
curl -X PATCH http://localhost:8787/api/sessions/<session-id> \
  -H 'Content-Type: application/json' \
  --data '{"title":"A better name"}'

# Browse the checkout inside a running container. `path` is relative to it and
# cannot leave it; `&read=1` returns one file (text capped at 256 KB).
curl 'http://localhost:8787/api/sessions/<session-id>/files?path=src'
curl 'http://localhost:8787/api/sessions/<session-id>/files?read=1&path=src/index.ts'

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
— sending it a message brings it straight back.

Reading a session — the list, the transcript, the event stream, the diff, the
files — never starts a container. Only creating a session and
sending it a message do, because those are the explicit requests for a running
one; everything else refuses a sleeping session instead of waking it.

## Instance API

Instances are created only as part of a session. What remains is the operational
surface for one container: reading its state, driving its runtime, and the
deletion path that session deletion delegates to.

```bash
# List instances with live container and persistence state.
curl http://localhost:8787/api/instances

# Inspect one instance.
curl http://localhost:8787/api/instances/<instance-id>

# Explicitly start the container. Nothing in the UI calls this any more —
# sending a session a message is what wakes one — so this is the manual start.
# It answers with the merged runtime status, including the wake's stage timings.
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
- Work-starting calls carry a short durable lease so a fast task that starts
  and finishes between probes still resets the idle window.
- Dispatch releases its lease once it has confirmed the session is observably
  active, handing the session back to the probe instead of staying `working`
  until the lease expires. A handover it cannot confirm keeps the lease.
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

### Cold start

Waking a sleeping session is the one wait with nothing to show but a spinner, so
it is measured. Every wake records its stages — container start plus snapshot
restore, repository provisioning, OpenCode server start — and the totals ride
out on the instance runtime status (`runtime.lastWake`), which the session list
already reads. The session page prints the last cold start under the title, with
the per-stage split in its tooltip. Wakes that only restarted the server on an
already-running container are marked `cold: false` and not shown, because mixing
them into the number would flatter it.

Two things were done with that measurement in hand:

- A resumed checkout's `git fetch origin` no longer sits in front of the server
  start. Nothing the server needs depends on it, so it runs alongside and the
  wake pays for whichever is slower instead of both.
- Regenerable caches are excluded from the snapshot (`.opencode-state/cache`).
  Snapshot size is restore time and restore time is the cold start, so anything
  in the archive is paid for on every wake forever. Only caches are excluded:
  re-creating an installed `node_modules` costs the user far more than the
  seconds a smaller archive saves.

Compression was left alone deliberately — the SDK already writes these archives
with lz4, which is the fastest of its options to decompress, and that is the
side of the trade that lands in the cold start.

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

## GitHub SSH and CLI access

Containers reach GitHub with the SSH key configured on the settings page —
generate an Ed25519 pair there, or paste an existing one. Add the public key
to GitHub as a deploy key (with write access if the sandbox should push), or
as an account SSH key when it needs multiple repositories. The Worker writes
the key to `/root/.ssh/id_ed25519` on every wake.

With a git identity configured, commits are made under it and signed with the
same SSH key. Add the public key as a GitHub signing key if sandbox commits
should appear as Verified.

The `gh` CLI inside the container is signed in with the shared GitHub token;
extra credentials for other services (`CLOUDFLARE_API_TOKEN` for Wrangler, and
so on) go into the environment-variable list, also on the settings page.
Nothing of this is baked into the image or the repository; rotating a
credential is an edit on the settings page plus the next container wake.

## OpenCode configuration

The complete configuration — providers, credentials, models, limits, costs,
variants, input modalities, permissions — is the `opencode.config` document,
edited as JSON on the settings page. Saves are validated
(`src/settings-schema.ts`): a config that omits a permission key or whose
default model does not resolve is refused, and removing a model that existing
sessions are pinned to demands an explicit force, since those sessions fail on
their next dispatch. The Hub derives its session model picker from the same
stored document at request time.

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
