# opencode-cloud

This repository follows Cloudflare's official
[`sandbox-sdk/examples/opencode`](https://github.com/cloudflare/sandbox-sdk/tree/main/examples/opencode)
example. The upstream snapshot used when creating it was commit
`453e4c7cbb03647ba631bd740972c3e2707ed8c0` (2026-07-17).

That upstream commit references the not-yet-published `0.12.4` release. This
experiment pins both the npm package and the container image to the current
matching stable release, `0.12.3`.

It starts OpenCode inside a Cloudflare Sandbox and proxies the OpenCode web UI,
API, event stream, and terminal WebSocket through a Worker. The default and
small model are both `vwnpc/grok-4.5`, matching the local OpenCode custom
provider configuration on the machine where this experiment was created.

## Prerequisites

- Docker is running locally.
- Node.js and pnpm are installed.
- A VW NPC provider API key is available for actually sending Grok 4.5 prompts.
  The UI can be started without one, but model calls will fail.
- Deploying to Cloudflare requires a Workers Paid plan.

## Run locally

```bash
git clone git@github.com:wangsijie/opencode-cloud.git
cd opencode-cloud
pnpm install
cp .dev.vars.example .dev.vars
# Set VWNPC_API_KEY in .dev.vars before sending a prompt.
pnpm dev
```

Open <http://localhost:8787> for the full OpenCode web UI. The first run builds
the container image and can take several minutes.

The image checks out Cloudflare's public `cloudflare/agents` repository into
`/home/user/agents`; it deliberately does not copy this private repository or
its proxy configuration into the sandbox.

## Programmatic SDK test

With the dev server running and a valid API key configured:

```bash
curl -X POST http://localhost:8787/api/test
```

This creates an OpenCode session and asks it to summarize the sample
repository's `README.md`.

## Credential flow

The real `VWNPC_API_KEY` remains in the Worker runtime. OpenCode receives a
placeholder key, and the Sandbox HTTPS egress interceptor replaces it only when
the request is forwarded to `ai.vwnpc.com`. Processes inside the container
cannot read the real key. The provider uses `@ai-sdk/anthropic` because the
custom endpoint implements the Anthropic-compatible protocol.

For deployment, store the key as a Worker secret:

```bash
pnpm wrangler secret put VWNPC_API_KEY
pnpm deploy
```

Do not commit `.dev.vars`.
