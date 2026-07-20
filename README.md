# opencode-cloud

This repository follows Cloudflare's official
[`sandbox-sdk/examples/opencode`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)
example. The upstream snapshot used when creating it was commit
`453e4c7cbb03647ba631bd740972c3e2707ed8c0` (2026-07-17).

That upstream commit references the not-yet-published `0.12.4` release. This
experiment pins both the npm package and the container image to the matching
stable release, `0.12.3`. The image extends Cloudflare's generic Sandbox image
and installs OpenCode `1.18.3` itself, so OpenCode can be upgraded independently
without waiting for Cloudflare's `-opencode` image variant.

It starts OpenCode inside a Cloudflare Sandbox and proxies the OpenCode web UI,
API, event stream, and terminal WebSocket through a Worker. The default and
small model are both `vwnpc/grok-4.5`.

## Prerequisites

- Docker is running locally.
- Node.js and pnpm are installed.
- Deploying to Cloudflare requires a Workers Paid plan.

## Run locally

```bash
git clone git@github.com:wangsijie/opencode-cloud.git
cd opencode-cloud
pnpm install
pnpm dev
```

Open <http://localhost:8787> for the full OpenCode web UI. The first run builds
the container image and can take several minutes.

The image installs the same OpenCode version as `@opencode-ai/sdk`, then checks
out this repository over SSH into `/opt/repos/opencode-cloud`. Additional
repositories can be placed alongside it under `/opt/repos`.

The image also installs `gh` and Wrangler globally. Both commands are already
authenticated using the committed CLI credentials under `docker/auth`, so they
can access GitHub and Cloudflare without an interactive login.

## GitHub SSH access

The image includes a dedicated Ed25519 key at `/root/.ssh/id_ed25519` for Git
operations over SSH. Add `docker/ssh/id_ed25519.pub` to GitHub as a deploy key
on the target repository; enable write access if the sandbox needs to push.
Alternatively, add it as an account SSH key when the sandbox needs access to
multiple repositories.

The private key is intentionally committed to this private repository and
embedded in the image. Anyone who can read the repository or pull the image can
use it, so keep its GitHub permissions narrow and rotate it if either artifact
is exposed.

Git is globally configured in the image with the identity `wangsijie
<sijiewg@gmail.com>`. Commit signing is enabled by default using the SSH key at
`/root/.ssh/id_ed25519`. Add `docker/ssh/id_ed25519.pub` to the matching GitHub
account as a signing key if commits should display as Verified on GitHub.

The same warning applies to the GitHub and Cloudflare credentials under
`docker/auth`. The Wrangler credential includes a refresh token so its OAuth
session can be renewed inside the container. Re-copy the local credentials and
rebuild the image whenever either login is rotated or revoked.

When upgrading Cloudflare Sandbox, update `@cloudflare/sandbox` and the base
image tag and digest together. OpenCode and `@opencode-ai/sdk` should likewise
be updated together.

## Programmatic SDK test

With the dev server running and a valid API key configured:

```bash
curl -X POST http://localhost:8787/api/test
```

This creates an OpenCode session and asks it to summarize the sample
repository's `README.md`.

## OpenCode configuration

The complete OpenCode configuration lives in `src/opencode-config.ts`. Default
models, providers, endpoints, credentials, model limits, and future custom
settings are managed together in that committed file. The VW NPC provider uses
`@ai-sdk/anthropic` because its endpoint implements the Anthropic-compatible
protocol.

This repository is private and intentionally commits provider credentials. If
the repository visibility or access list changes, rotate those credentials
first.

## Deploy

```bash
pnpm run deploy
```

Wrangler builds and pushes the container image, deploys the Worker, and applies
the Durable Object migration. No environment variables or Worker secrets are
required.
