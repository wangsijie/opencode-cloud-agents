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
out Cloudflare's public `cloudflare/agents` repository into `/home/user/agents`.
It deliberately does not copy this private repository or its proxy
configuration into the sandbox.

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
pnpm deploy
```

Wrangler builds and pushes the container image, deploys the Worker, and applies
the Durable Object migration. No environment variables or Worker secrets are
required.
