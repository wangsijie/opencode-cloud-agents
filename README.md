# opencode-cloud

OpenCode Hub running on Cloudflare Workers, Durable Objects, Containers, and
R2. One Worker hostname serves a management dashboard and routes traffic to any
number of independently sleeping OpenCode instances.

The container integration follows Cloudflare's
[`sandbox-sdk/examples/opencode`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)
example. This repository pins Sandbox SDK/container image `0.12.3` and OpenCode
`1.18.3` together.

## Hub architecture

- `/` is the Hub dashboard. It lists instance/container state and backup state,
  and supports create, enter, checkpoint, stop, and delete.
- The `Hub` Durable Object is the strongly consistent instance registry.
- Every immutable instance ID maps to a different `Sandbox` Durable Object and
  therefore a different container. Display names such as
  `amber-otter-4f2a` are generated randomly.
- New instances are provisioned lazily: creation adds a stopped logical
  instance immediately; its current configured image starts when it is first
  opened.
- The first Hub access registers the previous single-instance ID, `opencode`,
  as `original-opencode`, preserving its Durable Object storage and R2 backup
  during the migration.

### Why the single-domain router is path based

The stock OpenCode SPA cannot be mounted transparently below
`/instances/<id>`: it uses root-relative assets, root SPA routes, and
`location.origin` as its default server. The Hub therefore separates UI and
server routing:

- `/?_hub=<id>` loads that instance's OpenCode UI shell.
- `/ui/<id>/__hub-v<version>/*` serves a versioned UI asset graph from the
  selected instance. Versioning the path, rather than only the entry module's
  query string, keeps lazy ESM chunks and their shared context providers in one
  browser module graph.
- `/gateway/<id>/*` is the OpenCode server base URL. The Worker strips the
  prefix and streams HTTP, SSE, and terminal WebSocket traffic to that
  instance's port 4096.

The small bootstrap loaded with the UI selects the path-based gateway as
OpenCode's default server and keeps the instance marker on SPA history URLs.
This avoids cookies, so separate tabs do not use a cookie to decide which
instance receives API traffic.

Wildcard subdomains would be simpler if they become available: the Worker
could route `<instance>.example.com` directly and stock OpenCode could use that
origin without UI adaptation. The current design works with one exact hostname.

Instance records already contain an `imageKey`. It currently resolves only to
`opencode-v1`. Cloudflare binds an image to a Container/Durable Object class, so a
future image catalog should add another Sandbox class/binding and resolver case;
the Hub schema and URLs do not need to change.

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

Open <http://localhost:8787>. The first instance start builds the image and can
take several minutes. Local development uses Wrangler's local R2 store via
`PERSISTENCE_LOCAL_BUCKET=true`.

The image installs OpenCode, `gh`, and Wrangler, and checks this repository out
over SSH into `/workspace/opencode-cloud`. OpenCode data, state, and cache are
kept below `/workspace`, so they are part of each instance snapshot.

## Instance API

```bash
# List instances with live container and persistence state.
curl http://localhost:8787/api/instances

# Create a stopped instance with a random display name.
curl -X POST http://localhost:8787/api/instances

# Inspect one instance.
curl http://localhost:8787/api/instances/<instance-id>

# Create a snapshot without stopping.
curl -X POST http://localhost:8787/api/instances/<instance-id>/checkpoint

# Snapshot and stop. The next request starts and restores a fresh container.
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

- The normal 10-minute idle stop checkpoints before stopping.
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
small model are both `vwnpc/grok-4.5`. Provider endpoints, credentials, limits,
and future model settings are managed in that file.

This private repository intentionally commits provider credentials. Rotate them
before changing repository visibility or access.

## Verify and deploy

```bash
pnpm run typecheck
pnpm run deploy
```

The `v2` Durable Object migration creates the Hub registry. Wrangler builds and
pushes the configured current container image during deployment.
