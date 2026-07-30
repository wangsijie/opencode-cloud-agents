# AGENTS.md

## Repository role

This repository builds and deploys OpenCode Cloud. The OpenCode configuration
its Sandbox runtime uses is **not in the code**: it lives in the D1 `settings`
table and is edited on the Hub's `/settings` page.

- `src/settings.ts` / `src/settings-schema.ts` are the setting keys and the
  validation gate in front of them; `src/api-settings.ts` is the API. The page
  itself is not descriptor-driven: `web/src/components/SettingsPage.tsx` is a
  hand-written `SECTIONS` list with one component per section, so a new
  descriptor has no UI until one is written for it — which is how the Docker
  host settings spent a while being edited straight in D1.
- `src/model-catalog.ts` derives the model picker from the stored config at
  request time.
- `Dockerfile` is the OpenCode version for Sandbox images. It carries no
  credentials; `src/container-credentials.ts` injects them at wake.
- The `opencode.agents-md` setting holds standing agent instructions (a
  global block plus per-repository additions); the wake merges them and
  writes `/root/.config/opencode/AGENTS.md` in the container.
- The `opencode.skills` setting holds `SKILL.md` entries, each optionally
  scoped to one repository; the wake writes the global entries plus the
  instance repo's entries into `/root/.config/opencode/skills/` — always the
  global directory, never the checkout.

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

The `question` tool is the deliberate exception: it parks the same way, but the
Hub can answer it. The transcript renders the part as a form
(`web/src/components/QuestionView.tsx`), and `/api/sessions/:id/questions`
forwards the reply or the dismissal to the container's own question endpoints.
The pending request lives only in the OpenCode server's memory, so a question
whose container slept cannot be answered after the wake — the card says so and
the way forward is a normal message.

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

A session may be created with no repository at all (`repoKey` omitted). Nothing
is resolved, cloned or fetched and the session works in `/workspace` itself.
`repoKey` is therefore optional on the session, instance and Sandbox records;
the D1 column is `NOT NULL`, so the row carries `''` and `src/hub-rows.ts` turns
that back into an absent field. Everything git-shaped — the diff — refuses such
a session rather than running git outside a repository.

The catalog is needed only to *start* a session. The chosen entry is copied onto
the session, instance and Sandbox records, and everything afterwards reads the
checkout instead — directory from `repoKey`, default branch from `origin/HEAD`.
Do not reintroduce catalog lookups on paths that serve existing sessions: they
would make a rename, a revoked grant or a GitHub outage break running work.

## The Hub does not publish; the agent does

There was a `POST /api/sessions/:id/publish` that committed the working tree
onto `opencode/<session-id>`, pushed it, and could open a pull request. It is
gone. The agent in the container has git, `gh` and the credentials, so asking it
to push is how work actually left a session; the route duplicated that, never
had a button in the SPA, and nobody ever called it. `GET .../changes` stays —
reading the diff is the part the UI needs.

The lesson is the one the terminal already taught: a capability with no way to
reach it does not survive contact with a real workflow. Before rebuilding this,
build the button first.

Anything interpolated into a container shell command still goes through
`shellQuote` in `src/session-changes.ts`.

## Never exclude anything from the workspace snapshot

The snapshot protocol has no `excludes` field and the host passes none, which is
deliberate — the reasoning is written out at `createBackup` in `host/host.ts`.
The container expands each exclude into `<pattern>` *and* `... <pattern>`, and
mksquashfs 4.5 in `cloudflare/sandbox:0.12.3` reads the second form as "drop the
parent directory". One entry for `.opencode-state/cache` therefore removed all
of `.opencode-state` — OpenCode's database, and so every conversation — from
every snapshot for eight hours, while every checkpoint and restore reported
success.

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
shell; containers are reached only by Durable Object RPC into `Sandbox`, which
reaches them only through the host protocol. Keep it that way — do not add a
route that forwards browser traffic to a container, and do not call
`HostClient.proxyFetch` from outside the class: the gate is what keeps a passive
retry from waking anything. Files are `/api/sessions/:id/files`, which refuses a
sleeping session rather than waking one.

## The terminal was removed, and why that matters for the next one

There was a shell: `GET /api/sessions/:id/terminal` upgraded a WebSocket and
handed it to the Sandbox SDK's `stub.terminal()`, which proxies the PTY onto the
container's control-plane port 3000. The site admitted port 3000 only while a
control-plane operation was in flight, and a terminal was not one — so every
attempt threw `Sandbox control plane is not admitted`. The panel sat behind a
collapsed sidebar tab and was never opened, so it shipped dead and stayed dead. It is gone now: the route, the panel, xterm, the SDK stub cast, and
the `keepalive` work-lease route that existed only to stop the idle probe from
reaping an attached shell.

Two things to keep when it is rebuilt. Go through the class — a path that
bypasses `Sandbox` bypasses the runtime gate with it, which is exactly how this
one came to be dead on arrival; the protocol has no terminal route today, and
adding one means adding it to every host. And a shell is invisible to the
OpenCode activity probe, so it needs a work lease
(`LifecycleCoordinator.beginWork`) renewed on a timer,
left to expire on its own when the tab closes; that is the one deliberate
exception to "passive traffic never keeps a container alive".

## Local development

`pnpm dev` starts the site's `wrangler dev`, and the site runs no containers, so
this alone gets you the Hub, D1 and the SPA — with every container path failing
at the `SANDBOX_HOST` binding. To exercise a session end to end, run the sandbox
host beside it:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy wrangler dev -c host/wrangler.jsonc
```

That is the process with a real container in it, and it is the one the proxy
variables break: it hangs after "Preparing container image(s)" when
`HTTP_PROXY`/`HTTPS_PROXY` are set — the image builds, the server never listens,
and every request times out with no error in the log. `NO_PROXY` does not help;
wrangler reads the proxy variables directly. Two `wrangler dev` processes on the
same port fail the same silent way, so check for a stale one before assuming the
proxy is at fault. `.wrangler/state` holds only local Durable Object and R2
data; deleting it is the way to recover from a wedged local run.

For front-end-only work, `pnpm dev:mock` runs the Vite dev server against
in-memory fixtures (`web/src/mock/`) — no wrangler, no Docker, no D1. Fixtures
cover every session UI state; mutations reset on reload. The mock is installed
in `main.tsx` behind `import.meta.env.DEV && VITE_MOCK`, so it never reaches a
production bundle. When touching frontend types in `web/src/api.ts`, keep the
fixtures compiling — `pnpm typecheck` covers them.

## Deployment is automatic on push to master

`.github/workflows/deploy.yml` runs `pnpm test`, `pnpm run typecheck` and
`pnpm run deploy` on every push to `master`. **Pushing to `master` ships to
production.** There is no separate release step and no manual `pnpm run deploy`
to offer afterwards.

## There are two Workers, and only one of them runs containers

The site (`src/`, root `wrangler.jsonc`) has no container binding at all. Every
container belongs to a *sandbox host* — for Cloudflare sessions that is
`opencode-sandbox-host` (`host/`, `host/wrangler.jsonc`), reached over the
private `SANDBOX_HOST` service binding, which is also the authentication
boundary. `host/` has its own `tsconfig.json` and its own generated
`worker-configuration.d.ts`: a second Worker is a second `Env`.

The contract between them is the [Sandbox Host protocol](protocol/PROTOCOL.md).
`src/host-client.ts` is the site's only client — one method per route, one
transport per provider — and `src/runtime-ops.ts` is what the Hub does *inside*
a container expressed against it. `src/sandbox.ts` keeps everything a host may
not have: the runtime gate, the epoch, the backup ledger, the activity probe,
the transcript mirror, the deletion barrier.

A change to `Dockerfile`, `docker/`, `host/` or `protocol/` deploys the host;
the workflow does that first, because the site's service binding must not point
at a Worker that is not there yet. Everything else deploys the site alone, which
now builds no image at all.

Because the platform's `container.running` went with the binding, the site keeps
its own answer to "is it up" under the `host:runtime` storage key, written by
every call that starts or stops a container and calibrated against
`GET /sessions/:id` wherever a round trip is affordable — the runtime status
read, and the entry to every stop path. Do not reintroduce a synchronous
container check; there is nothing local left to ask.

## The third host ships over SSH

[`agent/`](agent/README.md) is the Docker implementation of the same protocol: a
zero-dependency Node server that runs `oc-session-<id>` containers against a
local daemon, reached over public HTTPS with a bearer token. It is not a Worker,
so it is not deployed by `wrangler`: the `docker-agent` job in
[`deploy.yml`](.github/workflows/deploy.yml) rsyncs it onto the operator's box
and restarts its launchd job.

That job asks two questions, not one. Anything under `agent/` or `docker/ssh/`
syncs and restarts — cheap, and safe by design, because restarting the agent
touches no container. Only `agent/session-image/` and `docker/ssh/` rebuild the
image, which takes minutes and reaches a session at its next *cold* start.

A change to `protocol/` deploys the Cloudflare host and leaves the agent alone
— the agent imports nothing from it, and the two are kept in step by
`test/agent-docker.test.mjs`, which walks the agent's route table against
`protocol/routes.ts`.

The invariant to protect is that the agent decides nothing. No idle reaper, ever:
the site stops a container only after exporting the whole transcript out of a
still-live OpenCode, so an agent that stopped one on its own would truncate that
history silently — the volume survives, so it is not data loss, and nothing
anywhere would report it.

`test/agent-docker.test.mjs` covers the pure half (argument vectors, container
scripts, parsers) and runs in CI. The rest needs a daemon: `node agent/e2e.mjs`
drives the whole protocol against real containers and cleans up after itself.
Run it on the box before pointing the site at a new one — three bugs that every
unit test passed through (a proxy that destroyed its own upstream, an
`EXEC_TIMEOUT` that could not fire, a `CONTAINER_NOT_RUNNING` that could not
fire) were only ever visible there.

## Snapshots are a host capability, not an assumption

A session's provider is chosen when it is created and stored on both the Hub row
and the `Sandbox` identity; `resolveHostClient` turns it into a transport — the
service binding for `cloudflare`, the operator's origin plus bearer for
`docker`. The client is cached in the object for a minute rather than forever,
because the Docker agent's URL, token and image are settings that can change
under a live session.

What the orchestration branches on is `supportsSnapshots`, never the provider
name. Cloudflare containers are ephemeral, so the workspace only survives as an
R2 snapshot; the Docker agent keeps it on a named volume that outlives every
container. That single bit decides three things, and nothing else should have to
know:

- **Restore.** With snapshots, a missing marker means "put the snapshot back".
  Without, it means the volume itself was recreated — the same loss, reached a
  different way, so it still becomes a `workspaceLost` record.
- **Stop.** `persistWorkspaceBeforeStop` checkpoints where it can and otherwise
  runs the `sync` alone. Either way the transcript export comes first, while
  OpenCode is still answering. That ordering is the invariant; the archive is
  the optional part.
- **Purge.** `DELETE /sessions/:id` destroys the workspace storage as well as
  the container, so a volume-persistent session needs no R2 sweep — and the
  orphan scan, which walks the whole `backups/` prefix, is skipped rather than
  run against objects that host never wrote.

The Docker host declares `snapshots: false` in `resolveHostClient` rather than
having it probed from `/healthz`. It is a property of the design, not something
an agent could answer differently, and a round trip per wake would buy nothing.

The one place the two hosts do not behave identically is the end of an event
stream. When a container stops, the browser's `/api/sessions/:id/events` ends —
cleanly `Canceled` on Cloudflare, but sometimes `Exception Thrown: ReadableStream
received over RPC disconnected prematurely` on Docker, where the SSE body came
over public HTTPS and the connection was severed mid-stream rather than closed.
Nothing is lost: the transcript export always finishes before the stop, and the
browser reconnects. Do not "fix" it by swallowing a truncated upstream in
`streamOpencodeEvents` — that hides a genuine mid-conversation disconnect, which
is the case worth reporting. Verified 2026-07-28 against both hosts.

## Two buckets, split by who writes them

`opencode-cloud-sessions` (`SESSION_BUCKET`) is the site's: transcript mirrors
under `transcripts/`, composer image uploads under `uploads/` (put there when
the image is picked, before any session or prompt names them; the daily cron
sweeps the unsent ones), and — from sessions created before uploads were their
own request — staged prompt attachments under `prompt-attachments/`.
`opencode-cloud-backups` (`BACKUP_BUCKET`) is the container snapshots under
`backups/`, written only by the sandbox host Worker — the site no longer sets
`BACKUP_BUCKET_NAME`, which is the variable the sandbox SDK reads to presign
uploads, because the SDK is on the host now.

The site still binds the snapshot bucket, for deletes and nothing else. Snapshot
deletion is deliberately outside the protocol: the ledger of handles lives in
the `Sandbox` object's own storage, so purge is the one thing that has to reach
the bucket from this side. A host is never asked to forget a snapshot.

The snapshot bucket is also the one that cannot be renamed casually: every
stored backup handle refers to objects in it. Transcripts are plain `put`/`get`
of our own, which is why they were the side that moved.

## A deploy that touches the image is a deploy that can lose sessions

This is the *host's* deploy now, not the site's. Deploying a changed container
image rolls out: each running instance is sent `SIGTERM`, given 15 minutes, then
`SIGKILL`. Nothing checkpoints on the way down — `createCheckpoint` runs only at
idle-stop and from the manual `/api/instances/:id/checkpoint` route — so an
instance that has been busy since it was created has no snapshot, comes up on an
empty `/workspace`, and its session goes to `lost`.

`rollout_active_grace_period` in `host/wrangler.jsonc` is set to 900 so an active
instance is left alone for fifteen minutes before it becomes eligible. **It buys
time; it does not make a deploy safe.** Two things follow.

The two Workers move independently, so a host rollout leaves new site code
driving old-image containers, and a site deploy leaves new site code driving a
host that has not moved. The dangerous change is the one that moves several
sides at once: bumping `@opencode-ai/sdk` in `package.json` together with
`OPENCODE_VERSION` in the `Dockerfile`, or upgrading `@cloudflare/sandbox` — the
SDK is now in the host Worker, its agent is in the image, and the OpenCode
client is in the site. Ship a version bump like that on its own, and expect the
window to be inconsistent rather than assume it is not.

And anything still running past the grace period is killed regardless. A deploy
that must not lose work needs the instances drained first — checkpoint, then
stop — not a longer grace period.

## Most deploys do not touch the container at all

`.github/workflows/deploy.yml` diffs the push against its predecessor and
deploys `opencode-sandbox-host` only when `Dockerfile`, `docker/`, `host/` or
`protocol/` changed. Everything else leaves the host — and therefore every
running container — completely alone; the site is deployed on its own and builds
no image.

This has to be decided from the paths, not left to wrangler. Wrangler does skip
a rollout when the container application's config does not change, but the image
is built from the `Dockerfile` on every deploy and its digest rarely reproduces
across runners and days — `apt-get` and `npm install --global` see to that — so
wrangler would see a new image nearly every time.

Two consequences. `host/wrangler.jsonc` is inside a watched directory because a
container configuration change (instance type, grace period, region constraints)
reaches the platform through the same application update a rollout carries; skip
it and the change silently does not apply. And a site-only deploy leaves the
fleet on the old image indefinitely, so the version-skew warning above is not
confined to a fifteen-minute window — the image only catches up on the next
push that touches a host path.

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
