# opencode-cloud

OpenCode platform source of truth and Cloudflare deployment. The repository
defines the shared provider/model configuration for all managed OpenCode
runtimes and runs an OpenCode Hub on Cloudflare Workers, Durable Objects,
Containers, and R2. One Worker hostname serves a management dashboard and
routes traffic to any number of independently sleeping OpenCode instances.

## Repository roles

- Build and deploy independently sleeping OpenCode Sandbox instances on Cloudflare.
- Maintain the canonical OpenCode provider, model, capability and version configuration for Sandbox and other machines.
- Document and operate machine deployments such as Mac Mini OpenCode Web.

See [`docs/opencode-fleet.md`](docs/opencode-fleet.md) for the synchronization contract and [`docs/macmini-opencode.md`](docs/macmini-opencode.md) for Mac Mini operations.

The container integration follows Cloudflare's
[`sandbox-sdk/examples/opencode`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)
example. This repository pins Sandbox SDK/container image `0.12.3` and OpenCode
`1.18.4` together.

## Hub architecture

- `/` is the Hub dashboard. Its composer starts a session from a repository, a
  model and a prompt; below it, the dashboard lists sessions and any remaining
  hand-made instances with their container and backup state.
- The `Hub` Durable Object is the strongly consistent session and instance
  registry.
- Every session has a `SessionAgent` Durable Object. Its alarm owns the
  start-work sequence and survives restarts and transient failures.
- Every instance also has a `LifecycleCoordinator` Durable Object. Its alarm
  polls OpenCode execution state and owns the semantic 10-minute idle deadline;
  browser HTTP, SSE, and WebSocket traffic never renews that deadline.
- Every immutable instance ID maps to a different template-specific Sandbox
  Durable Object and therefore a different container. Display names such as
  `amber-otter-4f2a` are generated randomly.
- New instances are provisioned lazily: creation records the selected template
  and adds a stopped logical instance immediately; its image starts when the
  instance is first opened.
- The first Hub access registers the previous single-instance ID, `opencode`,
  as `original-opencode`, preserving its Durable Object storage and R2 backup
  during the migration.

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

Each template is backed by a container image and a dedicated Durable Object
class binding. Instance records persist the image key, allowing the router and
lifecycle operations to resolve the correct Sandbox class without changing
instance URLs.

## Workspaces and repository provisioning

New instances always use the **Base** image (internal key `opencode-v1`), which
installs OpenCode, `gh`, Wrangler, and the bundled credentials. The creation
dialog chooses the workspace content:

- **Blank** starts with an empty `/workspace`.
- **Repository** instances record a `repoKey` from the catalog in
  [`src/repos.ts`](src/repos.ts). The first wake shallow-clones the repository
  into `/workspace/<repoKey>` before the OpenCode server starts; later wakes
  restore the workspace snapshot and run a best-effort `git fetch origin`
  without touching the working tree. A clone failure fails the wake; a fetch
  failure only logs a warning.

Adding a repository is a one-line change in `src/repos.ts` plus a deploy.
Public repositories use HTTPS clone URLs; private ones use SSH and require the
bundled image key to be authorized on GitHub.

The legacy **Logto** template image (`logto-v1`, cloned at build time) is no
longer offered for new instances; existing `logto-v1` instances keep working
unchanged.

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

Dispatch failures (a repository that cannot be cloned, a runtime that will not
wake) are retried three times with backoff, then the session stays `failed` with
the underlying error on the record and a retry button in the dashboard.

Model choices come from the provider catalog in `src/opencode-config.ts`; a
session stores the `providerID/modelID` reference and unknown references are
rejected at the API boundary.

Session state (`queued` / `starting` / `working` / `failed`) describes dispatch
only. Container state stays in the instance runtime status, so a `working`
session may be busy, idle, or already asleep.

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

Open <http://localhost:8787>. Building a template image for the first time can
take several minutes. Local development uses Wrangler's local R2 store via
`PERSISTENCE_LOCAL_BUCKET=true`.

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
# Repository and model choices for the composer.
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

# Re-run a failed start sequence.
curl -X POST http://localhost:8787/api/sessions/<session-id>/retry

# Delete the session together with its container and snapshots (HTTP 202).
curl -X DELETE http://localhost:8787/api/sessions/<session-id>
```

While the custom session view is still being built, open a running session's
full OpenCode IDE from the dashboard; that link uses the instance wake route
below.

## Instance API

```bash
# List instances with live container and persistence state.
curl http://localhost:8787/api/instances

# Create a stopped Base instance with a random display name. An empty POST uses
# Base for backward compatibility.
curl -X POST http://localhost:8787/api/instances

# Explicitly create a blank Base instance.
curl -X POST http://localhost:8787/api/instances \
  -H 'Content-Type: application/json' \
  --data '{"imageKey":"opencode-v1"}'

# Create a repository instance; the first wake clones into /workspace/logto.
curl -X POST http://localhost:8787/api/instances \
  -H 'Content-Type: application/json' \
  --data '{"repoKey":"logto"}'

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
- Only the latest successful snapshot is retained during normal operation.
- A backup ledger retains every handle whose R2 deletion has not yet been
  confirmed, so failed stale-backup cleanup remains retryable.
- Deleting the migrated `opencode` instance also recognizes the two legacy
  snapshot names (`opencode-manual` and `opencode-idle-stop`).
- Instance deletion first marks the registry record as `deleting`, which blocks
  new UI/API traffic, and returns `202` immediately. A Hub Durable Object alarm
  waits for in-flight startup/checkpoint/stop operations, destroys the container
  without making another snapshot, deletes every object below each tracked
  `backups/<backup-id>/` prefix, clears the instance Durable Object storage, then
  removes the Hub record. This keeps slow container teardown out of the client
  request lifetime.
- If any deletion step fails, the record becomes `delete_failed`; the dashboard
  can retry while the backup ledger is still available.

No distributed transaction can cover both R2 and Durable Object storage. The
ordering above prevents losing backup handles before R2 confirms deletion. An
R2 lifecycle rule for `backups/` is still recommended for uploads interrupted
before a handle can be recorded, and for orphaned snapshots created by older
versions of this project.

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
limits, costs, variants and input modalities are managed in that file. It is
also the canonical source for equivalent configurations deployed to other
machines; live machine files are derived copies.

Fleet inventory and synchronization rules are documented in
[`docs/opencode-fleet.md`](docs/opencode-fleet.md).

This private repository intentionally commits provider credentials. Rotate them
before changing repository visibility or access.

## Verify and deploy

```bash
pnpm run typecheck
pnpm run deploy
```

The `v2` Durable Object migration creates the Hub registry, `v3` adds the
`LogtoSandbox` class, `v4` adds the per-instance lifecycle coordinator, and `v5`
adds the per-session dispatch agent.
Wrangler builds and pushes both configured template images during deployment.
