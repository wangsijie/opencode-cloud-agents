# AGENTS.md

## Repository role

This repository builds and deploys OpenCode Cloud, and owns the OpenCode configuration its Sandbox runtime uses.

- `src/opencode-config.ts` is the provider/model configuration, including capabilities, limits, costs and variants.
- `Dockerfile` is the OpenCode version for Sandbox images.

## Configuration changes

When changing an OpenCode provider, model, capability or version:

1. Keep all image-capable models explicitly configured with `modalities.input` containing both `text` and `image`; `attachment: true` alone is insufficient.
2. Remember the Hub's session model picker derives from the same file: removing a model drops it from the composer and breaks any session still pinned to it.
3. Keep OpenCode and SDK versions aligned unless a documented platform constraint requires otherwise.

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

## Deployment is automatic on push to master

`.github/workflows/deploy.yml` runs `pnpm test`, `pnpm run typecheck` and
`pnpm run deploy` on every push to `master`. **Pushing to `master` ships to
production.** There is no separate release step and no manual `pnpm run deploy`
to offer afterwards.

## Verification

Run before pushing, because the same commands gate the deploy:

```bash
pnpm test
pnpm run typecheck
```

## Secrets

This is a private repository and intentionally contains narrowly scoped provider and deployment credentials. Do not print credentials in command output or send them to external tools. Preserve unrelated working-tree changes.
