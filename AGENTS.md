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
(`src/github-catalog.ts`) using the token committed in that file — a
`GITHUB_TOKEN` secret overrides it. That token only ever lists repositories;
pushes and pull requests use the image's own `gh` login. `src/repos.ts` is no
longer a catalog: it is the entry shape, the safety rules, and the
`/workspace/<repoKey>` path convention.

GitHub's answer is stored in Hub storage for good, beside the session records,
and every read is served from it without waiting on GitHub. `REPO_CATALOG_TTL_MS`
is not a lifetime: past that age the Hub reports `stale`, and the SPA asks for
one `?refresh=1` after it has rendered. Only a first-ever read and an explicit
refresh block on GitHub. A repository pinned on an existing instance is merged
back in, so work in a repository GitHub stopped listing can continue.

The list is served in last-used order: the Hub derives, from its own session
records, when each repository was last prompted in, and sorts those ahead of the
rest. That is why the composer defaults to the repository the last session ran
in. It is derived, not stored — do not add a parallel "recently used" list, in
the browser or beside the catalog.

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

## Never exclude anything from the workspace snapshot

`CHECKPOINT_EXCLUDES` in `src/sandbox.ts` is empty and must stay that way unless
somebody unpacks a real archive to prove otherwise. The container expands each
exclude into `<pattern>` *and* `... <pattern>`, and mksquashfs 4.5 in
`cloudflare/sandbox:0.12.3` reads the second form as "drop the parent
directory". One entry for `.opencode-state/cache` therefore removed all of
`.opencode-state` — OpenCode's database, and so every conversation — from every
snapshot for eight hours, while every checkpoint and restore reported success.

## A session can be lost, and that is terminal

OpenCode keeps its whole state inside `/workspace` (`OPENCODE_ENV` in
`src/sandbox.ts` points `XDG_DATA_HOME` and friends there), so a container that
dies without checkpointing takes the conversation with it. The restore path
notices it came up on an empty workspace with no snapshot to put back, records
the loss against the OpenCode session id it invalidates, and reports it on the
runtime status. The session then moves to phase `lost` — from the session view
on the next read, or from the dispatcher before it spends a wake and a prompt on
it — and stays there.

`lost` is terminal on purpose. Retry and send both refuse with 409, the agent
sets no alarm, and the UI offers a new session rather than a retry button: the
history the Hub mirrored stays readable, but there is nothing left to continue.
Do not "recover" a lost session by creating a fresh OpenCode session under the
old record — that is a different conversation wearing this one's name.

## No public route into a container

Since M6 the stock OpenCode UI and its proxies (`/ui/`, `/assets/`, `/gateway/`,
`/hub/bootstrap.js`) are deleted. The browser talks only to `/api/*` and the SPA
shell; containers are reached exclusively by Durable Object RPC from inside the
Worker. Keep it that way — do not add a route that forwards browser traffic to a
container port. Files and terminals are `/api/sessions/:id/files` and
`/api/sessions/:id/terminal`, and both refuse a sleeping session rather than
waking one.

The terminal is the exception to "passive traffic never keeps a container
alive", and deliberately so: a shell is invisible to the OpenCode activity
probe, so the panel renews a work lease through `POST /api/sessions/:id/keepalive`
and lets it expire on its own when the tab closes.

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
