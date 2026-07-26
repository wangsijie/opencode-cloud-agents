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

## Repository catalog

GitHub is the only catalog. The Hub lists the account's pushable repositories
(`src/github-catalog.ts`) and caches them for ten minutes, using the token
committed in that file — a `GITHUB_TOKEN` secret overrides it. That token only
ever lists repositories; pushes and pull requests use the image's own `gh` login.
`src/repos.ts` is no longer a catalog: it is the entry shape, the safety rules,
and the `/workspace/<repoKey>` path convention.

The catalog is needed only to *start* a session. The chosen entry is copied onto
the session, instance and Sandbox records, and everything afterwards reads the
checkout instead — directory from `repoKey`, default branch from `origin/HEAD`.
Do not reintroduce catalog lookups on paths that serve existing sessions: they
would make a rename, a revoked grant or a GitHub outage break running work.

## Publishing a session's work

`POST /api/sessions/:id/publish` commits and pushes onto `opencode/<session-id>`
and never onto the repository's default branch. Anything interpolated into a
container shell command goes through `shellQuote`/`isSafeBranchName` in
`src/session-changes.ts`; commit messages and pull request bodies are user text.

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
