# AGENTS.md

## Repository role

This repository is not only the OpenCode Cloud deployment. It is also the source of truth for OpenCode configuration across all managed machines and Sandbox runtimes.

- `src/opencode-config.ts` is the canonical provider/model configuration, including capabilities, limits, costs and variants.
- `Dockerfile` is the canonical OpenCode version for Sandbox images.
- `docs/opencode-fleet.md` is the fleet inventory and synchronization contract.
- `docs/macmini-opencode.md` is the Mac Mini OpenCode Web operations guide.
- Live machine files such as `~/.config/opencode/opencode.jsonc` are derived deployment copies, never the canonical source.

## Configuration changes

When changing an OpenCode provider, model, capability or version:

1. Make the canonical change in this repository first.
2. Keep all image-capable models explicitly configured with `modalities.input` containing both `text` and `image`; `attachment: true` alone is insufficient.
3. Keep Sandbox and machine configurations semantically aligned. Document any intentional platform-specific difference.
4. When rollout to a live machine is in scope, update its derived config, restart the service, and verify the runtime `/provider` result rather than trusting the file alone.
5. Update fleet and machine documentation in the same change when ownership, paths, versions or deployment steps change.

## Local development

`pnpm dev` starts `wrangler dev` with a real container. It hangs after
"Preparing container image(s)" when `HTTP_PROXY`/`HTTPS_PROXY` are set in the
environment: the image builds, but the server never starts listening and every
request to `localhost:8787` times out with no error in the log. Start it with
those variables unset instead:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy pnpm dev
```

`NO_PROXY` does not help — wrangler reads the proxy variables directly. Two
`wrangler dev` processes on the same port fail the same silent way, so check for
a stale one before assuming the proxy is at fault. `.wrangler/state` holds only
local Durable Object and R2 data; deleting it is the way to recover from a
wedged local run.

## Verification

Run before deployment:

```bash
pnpm test
pnpm run typecheck
```

Use `pnpm run deploy` for Cloudflare Worker/Sandbox rollout. After deployment, verify the target Sandbox actually started from the new image and that image-capable models report `capabilities.input.image: true`.

## Repository boundaries and secrets

The sibling `v2ray-docker` repository owns FRP, nginx network ingress, proxy routing and VPS topology. Keep only OpenCode application/runtime operations here and link to network configuration there.

This is a private repository and intentionally contains narrowly scoped provider and deployment credentials. Do not print credentials in command output or send them to external tools. Preserve unrelated working-tree changes.
