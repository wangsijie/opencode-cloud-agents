# opencode-sandbox-host

The Cloudflare implementation of the [Sandbox Host protocol](../protocol/PROTOCOL.md):
a second Worker whose only job is to run session containers.

- `index.ts` — the router. `/healthz`, then one Durable Object per session id.
- `host.ts` — `CloudflareSandboxHost`, a `@cloudflare/sandbox` Sandbox behind
  the protocol's endpoints. No session state beyond "does this exist, when did
  it start, which port is OpenCode on"; every policy stays in the site Worker.
- `support.ts` — status mapping, body validation, quoting, output caps and the
  proxy URL rewrite, covered by `test/host-support.test.mjs`.

## Why it is separate

The site Worker holds the orchestration (the runtime gate, the epoch, the
backup ledger, the transcript mirror) and the site's `Sandbox` Durable Object
keeps its class name and its storage. What moves here is only the container:
one host per provider, one protocol, and the site chooses the transport per
session. That is what lets a session run on a Mac mini's Docker instead of
Cloudflare's containers without a second orchestrator.

## Deployment

`.github/workflows/deploy.yml` deploys this Worker on a push to `master` when
`Dockerfile`, `docker/`, `host/` or `protocol/` changed — before the site, so a
service binding never points at a Worker that is not there yet. Manually:

```bash
pnpm run deploy:host
```

There is no route and no `workers.dev` subdomain: the site's service binding is
the only way in, and it is also the authentication boundary. The protocol's
bearer token is for the remote Docker agent, which is on the public internet.

Deploying this Worker rolls its containers out under the same 15-minute active
grace period as the site's, and the same warning applies: an instance that has
been busy since it was created has no checkpoint, and killing it loses the
session. See AGENTS.md.

## Configuration

`wrangler.jsonc` carries the container image (built from the repository root so
`docker/ssh/*` is in the build context), the `BACKUP_BUCKET` R2 binding and the
Durable Object. Snapshots additionally need R2 credentials as secrets on **this**
Worker, the same ones the site uses today:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID -c host/wrangler.jsonc
npx wrangler secret put R2_SECRET_ACCESS_KEY -c host/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID -c host/wrangler.jsonc
```

Without them `POST /sessions/:id/snapshot` fails: the SDK uploads the archive
straight from the container to R2 with a presigned URL, so the R2 binding alone
is not enough.

## Types

The host is a second Worker and therefore a second `Env`, so it has its own
`tsconfig.json` and its own generated `worker-configuration.d.ts`.
`pnpm run typecheck` covers both programs; `pnpm run types:host` regenerates
this one after a `wrangler.jsonc` change.
