# AGENTS.md

## Repository role

This repository builds and deploys OpenCode Cloud. The OpenCode configuration
its Sandbox runtime uses is **not in the code**: it lives in the D1 `settings`
table and is edited on the Hub's `/settings` page.

- `src/settings.ts` / `src/settings-schema.ts` are the setting keys and the
  validation gate in front of them; `src/api-settings.ts` is the API.
- `src/model-catalog.ts` derives the model picker from the stored config at
  request time.
- `Dockerfile` is the OpenCode version for Sandbox images. It carries no
  credentials; `src/container-credentials.ts` injects them at wake.

## Configuration changes

When changing the OpenCode config (on the settings page) or its validation:

1. Keep all image-capable models explicitly configured with `modalities.input` containing both `text` and `image`; `attachment: true` alone is insufficient (the validator warns).
2. Remember the Hub's session model picker derives from the same stored config: removing a model drops it from the composer and breaks any session still pinned to it (the API refuses unless forced).
3. Keep OpenCode and SDK versions aligned unless a documented platform constraint requires otherwise.

## An unanswered permission is a hung session

OpenCode falls through to `ask` for any permission no rule matches, and an ask
blocks the tool call on a promise only a reply settles. Nothing in the Hub
answers one — there is no permission UI and no operator — so a single ask leaves
the tool part `running`, the container busy and the session `working` until
somebody aborts it. `permission` in the stored OpenCode config therefore decides
every key OpenCode accepts — `validateOpencodeConfig` in
`src/settings-schema.ts` refuses to store a config that omits one, and a new
key added by an OpenCode upgrade has to be added to
`REQUIRED_PERMISSION_KEYS` there too. `external_directory` is the one that
fires in practice: a model
reading a file outside the checkout, and Grok does it often enough that it
looked like a Grok bug.

## Repository catalog

GitHub is the only catalog. The Hub lists the account's pushable repositories
(`src/github-catalog.ts`) using the token stored under `github.token` in
settings — a `GITHUB_TOKEN` wrangler secret overrides it. The same token signs
the container's `gh` CLI in for pull requests. `src/repos.ts` is no
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
container port. Files are `/api/sessions/:id/files`, which refuses a sleeping
session rather than waking one.

## The terminal was removed, and why that matters for the next one

There was a shell: `GET /api/sessions/:id/terminal` upgraded a WebSocket and
handed it to the Sandbox SDK's `stub.terminal()`, which proxies the PTY onto the
container's control-plane port 3000. `containerFetch` admits port 3000 only
while a `withControlPlaneAccess` operation is in flight, and a terminal is not
one — so every attempt threw `Sandbox control plane is not admitted`. The panel
sat behind a collapsed sidebar tab and was never opened, so it shipped dead and
stayed dead. It is gone now: the route, the panel, xterm, the SDK stub cast, and
the `keepalive` work-lease route that existed only to stop the idle probe from
reaping an attached shell.

Two things to keep when it is rebuilt. Go through the class, not the SDK's
client-side stub proxies — a proxy that bypasses `Sandbox` bypasses the runtime
gate and the control-plane admission with it, which is exactly how this one came
to be dead on arrival. And a shell is invisible to the OpenCode activity probe,
so it needs a work lease (`LifecycleCoordinator.beginWork`) renewed on a timer,
left to expire on its own when the tab closes; that is the one deliberate
exception to "passive traffic never keeps a container alive".

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

## A deploy that touches the image is a deploy that can lose sessions

Deploying a changed container image rolls out: each running instance is sent
`SIGTERM`, given 15 minutes, then `SIGKILL`. Nothing in the Worker checkpoints
on the way down — `createCheckpoint` runs only at idle-stop and from the manual
`/api/instances/:id/checkpoint` route — so an instance that has been busy since
it was created has no snapshot, comes up on an empty `/workspace`, and its
session goes to `lost`.

`rollout_active_grace_period` in `wrangler.jsonc` is set to 900 so an active
instance is left alone for fifteen minutes before it becomes eligible. **It buys
time; it does not make a deploy safe.** Two things follow.

The Worker version updates immediately and globally while containers roll out
gradually, so for that whole window new Worker code is driving old-image
containers. Nothing here is written to tolerate that yet, and the dangerous
change is the one that moves both sides at once: bumping `@opencode-ai/sdk` in
`package.json` together with `OPENCODE_VERSION` in the `Dockerfile`, or
upgrading `@cloudflare/sandbox` — the SDK is in the Worker, its agent is in the
image. Ship a version bump like that on its own, and expect the window to be
inconsistent rather than assume it is not.

And anything still running past the grace period is killed regardless. A deploy
that must not lose work needs the instances drained first — checkpoint, then
stop — not a longer grace period.

## Most deploys do not touch the container at all

`.github/workflows/deploy.yml` diffs the push against its predecessor and only
runs `pnpm run deploy` when `Dockerfile`, `docker/` or `wrangler.jsonc` changed.
Everything else ships with `pnpm run deploy:worker-only`, which passes
`--containers-rollout=none`: the Worker is deployed without building or updating
the container, and running instances are left alone entirely.

This has to be decided from the paths, not left to wrangler. Wrangler does skip
a rollout when the container application's config does not change, but the image
is built from the `Dockerfile` on every deploy and its digest rarely reproduces
across runners and days — `apt-get` and `npm install --global` see to that — so
wrangler would see a new image nearly every time.

Two consequences. `wrangler.jsonc` is on the list because a container
configuration change (instance type, grace period, region constraints) reaches
the platform through the same application update a rollout carries; skip it and
the change silently does not apply. And a Worker-only deploy leaves the fleet on
the old image indefinitely, so the version-skew warning above is not confined to
a fifteen-minute window — the image only catches up on the next deploy that
touches it.

## Verification

Run before pushing, because the same commands gate the deploy:

```bash
pnpm test
pnpm run typecheck
```

## Secrets

Credentials live in the D1 `settings` table, entered on the `/settings` page —
the repository itself carries none. The admin password is stored as a salted
PBKDF2 hash and browser sessions as token hashes in `admin_sessions`; secret
settings never read back through the API. Do not print credentials in command
output or send them to external tools; do not reintroduce hardcoded
credentials into the code or the image. Preserve unrelated working-tree
changes.
