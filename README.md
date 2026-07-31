# opencode-cloud-agents

An OpenCode Hub on Cloudflare Workers, Durable Objects, Containers, and R2. One
Worker hostname serves a session dashboard and routes traffic to any number of
independently sleeping OpenCode containers.

There are two Workers. The site (`src/`) owns the Hub — the SPA, the API, D1,
and the Durable Objects that decide when anything happens. It runs no containers
itself: those belong to a *sandbox host*, reached over the
[Sandbox Host protocol](protocol/PROTOCOL.md). `opencode-sandbox-host` (`host/`)
is the Cloudflare implementation, deployed beside the site and bound privately;
a second implementation runs Docker containers on a machine of your own.

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
  it browses the checkout.
- The `Hub` Durable Object is the strongly consistent session and instance
  registry.
- Every session has a `SessionAgent` Durable Object. Its alarm owns the
  start-work sequence and survives restarts and transient failures.
- Every immutable instance ID maps to its own Sandbox Durable Object and
  therefore its own container. Display names such as `amber-otter-4f2a` are
  generated randomly.
- Instances are provisioned lazily: creating a session records a stopped logical
  instance immediately, and its container starts on the first explicit wake.

### One origin, one API surface

The Hub is a single Worker hostname and nothing behind it is publicly routable.
Every browser request is either the SPA shell, its hashed assets, or an
`/api/*` route; the only thing that reaches a container is a Durable Object RPC
made inside the Worker, which reaches it in turn through the host protocol.

## Workspaces and repository provisioning

There is one container image. It installs OpenCode, `gh` and Wrangler, and
leaves `/workspace` empty; repositories are never baked into the image, and
neither are credentials — the SSH key, the `gh` login, git identity and
signing, extra environment variables, OpenCode skills and the merged
`AGENTS.md` instructions are read from the settings table and injected by the
Worker on every wake (`src/container-credentials.ts`).

GitHub is the only source for the catalog a session can be started from: the Hub
lists every repository the token can push to, sorted by recent activity, and
caches the answer for ten minutes. Archived and read-only repositories are left
out — a session that cannot push its work cannot finish.

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

A session can also be started with **no repository** — then nothing is cloned
or fetched and the session works in `/workspace` itself, an ordinary session in
every other way, except that there is no checkout to diff.

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
starts inside the container; the usual 10-minute idle stop follows completion.

Continuing a session takes the same path, whether or not its container is still
running. `POST /api/sessions/<id>/messages` puts the prompt on the agent's
durable queue and answers 202; if the container is asleep the agent wakes it,
restores the workspace and continues the *same* OpenCode session, so the whole
conversation is still there. The session page renders that wait as progress
instead of asking the user to press a wake button first.

Several messages sent during a wake are delivered in order and none twice.

Dispatch failures (a repository that cannot be cloned, a runtime that will not
wake) are retried three times with backoff, then the session stays `failed` with
the underlying error on the record and a retry button in the dashboard.

Model choices derive from the stored OpenCode config (`src/model-catalog.ts`);
a session stores the `providerID/modelID` reference and unknown references are
rejected at the API boundary.

Session state (`queued` / `starting` / `working` / `failed`) describes dispatch
only. Container state stays in the instance runtime status, so a `working`
session may be busy, idle, or already asleep. Because those are two state
machines, the API also returns a single `status` the UI renders as one badge.

Reading a session — the list, the transcript, the event stream, the diff, the
files — never starts a container. Only creating a session and
sending it a message do, because those are the explicit requests for a running
one; everything else refuses a sleeping session instead of waking it.

Everything the UI does goes through the HTTP API on the same origin, documented
in [docs/API.md](docs/API.md).

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
git clone git@github.com:wangsijie/opencode-cloud-agents.git
cd opencode-cloud-agents
pnpm install
pnpm dev
```

Open <http://localhost:8787>. That is the site alone, which is enough for
everything but running a session; container paths fail at the `SANDBOX_HOST`
binding until the sandbox host is running too:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy wrangler dev -c host/wrangler.jsonc
```

Building the container image for the first time can take several minutes. That
host process is also the one the proxy variables break: with
`HTTP_PROXY`/`HTTPS_PROXY` set, Wrangler hangs after "Preparing container
image(s)" — the image builds, the server never listens, and every request times
out with nothing in the log. `NO_PROXY` does not help; start it with those
variables unset, as above. Local development uses Wrangler's local R2 store via
`PERSISTENCE_LOCAL_BUCKET`, which is the host's variable now.

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
and the session event stream is simulated. Mutations
(rename, delete, settings saves) work but live in memory and reset on
reload. The mock chunk is dev-only: `vite build` excludes it entirely.

Local-mode restore pushes the whole snapshot archive through the container
control-plane file API, which rejects large bodies (HTTP 413). Large repository
workspaces therefore cannot be restored after a stop in
local development; production restores use presigned R2 URLs downloaded inside
the container and are unaffected. Verify snapshot/restore locally with a small
repository. Stale `cloudflare/proxy-everything` helper containers from crashed
`wrangler dev` sessions can also wedge startup; remove them with `docker rm -f`
if the dev server never becomes ready.

## Persistence and deletion guarantees

The container filesystem is ephemeral after sleep. Each Sandbox Durable Object
stores its own latest `/workspace` backup handle and restores it once per fresh
runtime.

- The normal 10-minute idle stop begins only after OpenCode itself reports that
  no session is executing. Probe failure is treated as unknown and fails safe
  by keeping the container running.
- Open browser tabs, SSE streams, WebSockets, and status polling do not count as
  execution and therefore do not keep the runtime alive.
- Just before that checkpoint, while the OpenCode server is still up, the whole
  session transcript is exported to `transcripts/<session-id>/latest.json`, so a
  sleeping session's history stays readable without waking anything. A running
  container re-exports at most once a minute, driven by the activity probe and
  only when something has actually changed, which bounds what an unexpectedly
  killed container loses to roughly one refresh interval.
- Only the latest successful snapshot is retained during normal operation.
- Deleting a session returns `202` immediately and blocks new traffic; a
  background alarm destroys the container, deletes every snapshot and the
  transcript mirror, then removes the record. If any step fails, the record
  becomes `delete_failed` and the dashboard can retry.

### Cold start

Waking a sleeping session is the one wait with nothing to show but a spinner, so
it is measured. Every wake records its stages — container start plus snapshot
restore, repository provisioning, OpenCode server start — and the totals ride
out on the instance runtime status (`runtime.lastWake`), which the session list
already reads. The session page prints the last cold start under the title, with
the per-stage split in its tooltip. Wakes that only restarted the server on an
already-running container are marked `cold: false` and not shown, because mixing
them into the number would flatter it.

An R2 lifecycle rule for `backups/` is still recommended for uploads interrupted
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

Standing agent instructions live in the `opencode.agents-md` setting: one
global block, plus optional per-repository additions. On every wake the
Worker merges the global block with the addition for the instance's
repository — each sandbox holds exactly one checkout — and writes the result
to `/root/.config/opencode/AGENTS.md`, where OpenCode reads it alongside
whatever `AGENTS.md` the repository itself carries. Clearing the setting
removes the file on the next wake.

Skills (`opencode.skills`) work the same way: each entry is one `SKILL.md`,
written on every wake into the container's global skills directory
(`/root/.config/opencode/skills/<name>/SKILL.md`). An entry may optionally be
scoped to a repository, in which case only sandboxes on that repository
receive it — the file still lands in the global directory rather than the
checkout, since a sandbox holds exactly one repository and nothing should be
written into it. A skill name may be either one global entry or per-repo
entries with distinct repositories; saves mixing the two are refused, as both
would target the same container path.

### MCP servers

MCP servers are part of the same `opencode.config` document, under `mcp` —
OpenCode reads them straight from the delivered config, so no extra plumbing
is involved. Tokens belong in the `container.env` setting and are referenced
as `{env:VAR}`; the config template ships disabled entries for the common
cases:

```json
{
  "mcp": {
    "linear": {
      "type": "remote",
      "url": "https://mcp.linear.app/mcp",
      "headers": { "Authorization": "Bearer {env:LINEAR_API_KEY}" },
      "oauth": false,
      "enabled": true
    },
    "notion": {
      "type": "local",
      "command": ["notion-mcp-server"],
      "environment": { "NOTION_TOKEN": "{env:NOTION_TOKEN}" },
      "enabled": true
    },
    "figma": {
      "type": "local",
      "command": ["figma-developer-mcp", "--stdio"],
      "environment": { "FIGMA_API_KEY": "{env:FIGMA_API_KEY}" },
      "enabled": true
    }
  }
}
```

Linear's hosted server takes a plain API key in the `Authorization` header
(`oauth: false` keeps OpenCode from attempting a browser flow no container can
complete). Notion's hosted server is OAuth-only, but its official local server
takes an internal integration token; Figma's hosted server is OAuth-only with
no token alternative, so the community `figma-developer-mcp` takes a personal
access token instead. Both local servers are preinstalled in the session
images (`Dockerfile`, `agent/session-image/Dockerfile`) — `/root` is wiped on
every boot, so an `npx` download would recur on every wake.

For a server that only speaks OAuth (Figma's official one, say), the
`opencode.mcp-auth` setting holds a pasted OAuth store: run
`opencode mcp auth <name>` on your own machine, then paste
`~/.local/share/opencode/mcp-auth.json` into the MCP auth section. On each
session's next wake the store is seeded into the snapshotted workspace at
`/workspace/.opencode-state/data/opencode/mcp-auth.json`, where OpenCode
refreshes it in place. A marker records which settings revision seeded the
workspace: an unchanged setting never overwrites the refreshed tokens (a
rotated refresh token must not be resurrected), saving the setting again
reseeds every session, and clearing it deletes the seeded store on the next
wake. One limitation follows from snapshots: restoring an old checkpoint
revives the tokens as of that checkpoint, and if the provider has rotated the
refresh token since, the fix is a fresh paste.

## Verify and deploy

`.github/workflows/ci.yml` runs the tests and the typecheck on every push and
pull request. Pushing to `master` also deploys: `.github/workflows/deploy.yml`
repeats those gates and runs `pnpm run deploy`, so there is no separate release
step — run the same gates locally first:

```bash
pnpm test
pnpm run typecheck
```

`pnpm run deploy` is still available for an out-of-band rollout, and needs
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. Anything
a deploy cannot undo — a Durable Object migration, a change of R2 key layout —
has to be prepared before the push, not after it.
