# Per-repo prebuild: seeding new sessions from a warm workspace

## Problem

A new session's workspace starts empty on both providers — Cloudflare containers
are ephemeral, and the Docker host creates a fresh named volume per session
(`oc-vol-<sessionId>`). Every first `pnpm install` in a dependency-heavy repo
(electron, esbuild) costs 4–10 minutes of session time. Snapshots already
persist a *session's own* workspace across sleeps; nothing carries a warm
workspace *across sessions of the same repo*.

This is the same problem Codespaces prebuilds and Cursor's environment
snapshots solve: take a disk image after dependencies are installed, and start
new environments from it instead of from zero.

## Goals and principles

- **Invisible and automatic.** No operator action, no per-repo configuration,
  no agent-visible steps. Prebuilds are produced as a side effect of normal
  session activity and consumed silently at wake.
- **Best-effort, never load-bearing.** A missing, stale, or corrupt prebuild
  degrades to today's behavior (fresh clone + full install). No prebuild
  failure may ever mark a session `lost` — that state is terminal and reserved
  for a session losing *its own* workspace.
- **Provider-appropriate transport.** Cloudflare persists through R2 (its only
  persistent medium); Docker persists through local volumes (zero network,
  rsync-incremental). The *policy* is shared; the *transport* is not.

## The one invariant that keeps this safe

> A workspace is seeded from a prebuild **only when the instance has no
> workspace of its own** (first wake of a new instance). A workspace restored
> from the instance's own snapshot or found on its own volume is **never**
> touched by seeding or sanitizing.

Sanitizing (git reset, deleting donor state) on a session's own workspace would
destroy user work. The branch point is unambiguous on both providers:
Cloudflare knows whether `persistence:latest-backup` exists; Docker's
`EnsureResponse.workspaceCreated` already says whether the volume is new.

## Lifecycle overview

Prebuilds have one consumer and — eventually — two producers. The consumer
(seeding at wake) is identical regardless of who produced the prebuild.

```
 producer A (built first):              new session (same repo)
 dedicated prebuild run                 ───────────────────────
 ──────────────────────                 wake: no own workspace
 operator picks a repo →                ├─ prebuild exists? seed it
 throwaway container:                   │   ├─ sanitize (see below)
 clone → install → promote ───────────► │   └─ fetch + checkout default branch
                                        └─ else: clone (today's path)
 producer B (later, automatic):         agent runs `pnpm install`; the store,
 donor session goes idle →              node_modules and electron cache are
 checkpoint → promote ────────────────► already warm → seconds, not minutes
```

Producer A is a deterministic pipeline with no LLM involved — it exists to
make the mechanism observable and testable in isolation. Producer B is the
same promote step piggybacking on real sessions' checkpoints/stops; it comes
later and reuses everything A built.

Promotion is latest-wins per repo. A stale prebuild is not an error: the
seeded workspace is reconciled by `git fetch` + an incremental install.

## Dedicated prebuild runs (built first)

**Trigger.** `POST /api/prebuilds` with `{repoKey, provider}` → `202 {runId}`.
`GET /api/prebuilds` lists the registry plus each (host, repo)'s latest run
(status, step timings, error, install log tail) — that read is the whole
observability story. One run per repo *per host* at a time; a second trigger
while one is running is refused. `DELETE /api/prebuilds/:repoKey?provider=…`
removes the artifact and the registry row — mostly a testing affordance. The
UI is its own page, below.

A prebuild is a volume on one machine, so the provider is a whole host
(`docker:<id>`) and everything above is addressed by the pair: the registry
row, the run history, the Durable Object that serializes runs, the delete. A
repository can hold a prebuild on every Docker host, and the page groups the
list by host.

**Pipeline.** A run is a throwaway instance that deliberately never starts the
OpenCode server:

1. Create a container the same way a session wake does (id like
   `prebuild-<slug>-<ts>`), inject git/gh credentials as wake already does —
   the clone needs them.
2. Clone the repo (reusing the wake's clone path).
3. Run installs **with the same `OPENCODE_ENV` XDG variables a session gets**
   (`XDG_DATA_HOME`/`XDG_CACHE_HOME` under `/workspace/.opencode-state`).
   This is load-bearing: without them pnpm's store lands in `/root`, which the
   base image wipes on boot and no snapshot carries — the prebuild would hold
   `node_modules` but no store and no electron cache.
4. Promote (provider-specific, below).
5. Tear the throwaway down — container, volume/instance state, everything but
   the promoted prebuild.

Each step's duration and the install output tail land in the run record.
Failure at any step marks the run failed and tears down; the previous prebuild,
if any, stays live.

**What to install.** Default is convention: look for lockfiles at the repo
root and one directory level down; `pnpm-lock.yaml` → `pnpm install
--frozen-lockfile`, `package-lock.json` → `npm ci`, `yarn.lock` → `yarn
install --frozen-lockfile`, run sequentially with a generous (20 min) exec
timeout. An optional settings key (`prebuild.install`, per-repo command list)
overrides the convention for repos that need more; absent for most.

**Provider mechanics.** Both reuse the session machinery rather than growing a
parallel one:

- *Cloudflare*: the run drives a real Sandbox instance (container + exec via
  the existing host protocol) but skips the OpenCode start. After install,
  call the existing `createBackup`, promote the snapshot to
  `prebuilds/<repoKey>/…` (copy + registry upsert, as below), then purge the
  instance.
- *Docker*: the run uses the existing ensure/exec/stop agent ops on a
  throwaway session id, then promotes the stopped volume into a new
  generation of `oc-prebuild-<slug>` (rsync + `current` swap, as below), then
  deletes the throwaway container and volume.

A run's workspace never ran OpenCode, so its prebuild contains no
conversation database — the seed-time sanitize still runs (it must, for
producer-B prebuilds) but finds nothing to delete.

## UI

### The Prebuilds settings tab

A tab in Settings at `/settings/prebuilds` — the settings route grows a section
segment, `SECTIONS` grows an entry with no setting key behind it, and
`SettingsPage` a `PrebuildsSection` branch. It shipped first as a page of its
own at `/prebuilds` with a sidebar button beside Settings, on the reasoning that
settings rows are key-value edits while this has live, polling state. The
sidebar footer is the thing that could not carry it: it holds Settings and Sign
out and nothing else, so a second configuration surface had nowhere to be
reached from. `/prebuilds` still parses, to the same tab.

The tab is **one list of the repos that have a prebuild**, from
`GET /api/prebuilds`, plus an add control underneath. It listed the whole
catalog first, with the row as the trigger and every un-prebuilt repo carrying
a muted `no prebuild` — which is fine at a handful of repositories and puts the
two that matter behind a scroll at fifty. So the catalog moved into the add
control: `RepoSelect`, the composer's own searchable picker (`allowNone={false}`
there, because a repository is the whole point of that choice), and an **Add**
button that starts the first run. A row therefore also appears for a repo whose
latest run is `running` or `failed` — a first build is watchable from the moment
it is added, and a failed attempt that produced nothing leaves its error on
screen instead of vanishing. Deleting is what takes a repo off the list, so
`DELETE /api/prebuilds/:repoKey?provider=…` forgets that host's run history
along with its registry row; otherwise a failure would be an undeletable row.
Per row:

- **Repo name**, and the prebuild state: `built 2 h ago · cloudflare · 1.4 GB`
  (relative time from the registry's `updated_at`; size recorded at promote —
  R2 object size / `du` on the volume generation).
  A repo can hold one prebuild per provider; rows with both show both.
- **Last run outcome** when it isn't the happy path: a failed run's error and
  its install log tail behind a disclosure. A run history table is deliberately
  omitted — the registry row plus the latest run answer every question the
  operator actually has; `prebuild_runs` keeps history for debugging via D1.
- **Rebuild button.** Disabled with a spinner-label while that repo's
  run is active — and disabled outright in the group of a host that has since
  been removed from settings, where the rows survive only so they can be
  deleted. Which host a *new* prebuild goes on is picked beside the add
  control, and only when there is more than one to pick.
- **While a run is active**, the row expands into the step ladder — `clone →
  install → snapshot → promote`, each step showing its elapsed/final duration
  from the run record's `timings`, plus the live install log tail. This is the
  tab's reason to exist: watching exactly where a prebuild's minutes go.
- **Delete** behind an overflow/confirm, wired to the DELETE route.

Polling follows the SPA's existing pattern (SessionPage polls harder during a
wake): a few-second interval while any run is `running`, lazy otherwise. The
dev mock (`web/src/mock`) gains `/api/prebuilds` fixtures — one built repo, one
running mid-install, one failed — so the tab is buildable without a backend.

### How a seeded session shows up differently

Two layers, matching how the user encounters it:

1. **Live, on the boot screen.** Today the wake shows a static "Starting the
   runtime environment". The session record gains a transient `bootStep`
   written by the wake path as it moves — `restoring` (own snapshot) /
   `seeding` (prebuild) / `cloning` / `starting` — and SessionPage's booting
   branch words it accordingly: a seeded wake reads "Restoring cached
   workspace (prebuild from 2 h ago)" where a cold one reads "Cloning the
   repository…". The page already polls sharply during a wake, so the step is
   live with no new transport. `bootStep` is presentation-only state: nothing
   may branch on it, and a wake that never writes it (old rows, races) just
   keeps the generic wording.
2. **Durable, after boot.** The instance record gains
   `workspaceOrigin: 'clone' | 'prebuild' | 'snapshot'` (plus the prebuild's
   `updated_at` when seeded), set once when the workspace is first
   materialized. `InstanceModal` — already the home of instance-level detail —
   shows it as a plain line: "Workspace: seeded from prebuild (built 3 h
   ago)". That is also the operator's after-the-fact tell, alongside the
   `seededFromPrebuild` wake timing in the tail, that the mechanism worked —
   the UI equivalent of the fetch-vs-clone tell.

## What a prebuild contains — and what seeding must remove

A prebuild is a full copy of a donor session's `/workspace` at checkpoint time.
That includes exactly what we want — the checkout, `node_modules`, the pnpm
store and electron/esbuild caches under `.opencode-state/{data,cache}` — but
also things that must not leak into a new session:

| In the prebuild | Keep? | Handling at seed time |
| --- | --- | --- |
| repo checkout (possibly dirty, on some branch) | yes | `git reset --hard` + `git clean -fd`, then fetch and hard-reset to the default branch |
| `node_modules` (gitignored) | yes | untouched — `git clean -fd` without `-x` preserves ignored files |
| pnpm store, electron/esbuild caches (`.opencode-state/data/pnpm`, `.opencode-state/cache`) | yes | untouched |
| OpenCode's own database and state (`.opencode-state/data/opencode`, `.opencode-state/state`) | **no** | `rm -rf` before the OpenCode server starts — otherwise the new container sees the donor's conversations |
| other gitignored files (`.env` and the like) | carried over | accepted: single-operator deployment, same repo, same credential scope; documented here rather than solved |

Sanitizing happens at **seed time in the fresh container**, never at promote
time (which would mutate the donor's live workspace), and never via snapshot
excludes — the snapshot protocol has no excludes on purpose (see AGENTS.md on
the mksquashfs incident).

If any sanitize step fails, wipe `/workspace` and fall through to the normal
clone path. The prebuild is then suspect; log it, don't retry it in a loop.

## Shared changes (both providers)

All in `src/runtime-ops.ts`, which both providers already reach through
`RuntimeHost`:

1. **`seedWorkspace(host, checkout, …)`** — new: runs the sanitize sequence
   above, then a *blocking* `git fetch origin --prune` + checkout of the
   default branch + `reset --hard origin/<default>`. (The existing background
   fetch in `provisionRepository` is fine for restored-own-snapshot wakes, but
   a seeded checkout may be on the donor's branch at a stale commit — the new
   session must start on a current default branch.) On fetch failure: wipe and
   fall back to clone.
2. **`provisionRepository` is unchanged** — after a successful seed it sees
   `.git` and takes the fetch path; after a failed/absent seed it clones.
3. Wake timings gain `seededFromPrebuild: boolean` and `prebuildSeedMs` so the
   win (and the failure rate) is observable in `wrangler tail`.

Sessions without a `repoKey` skip everything — there is nothing to key a
prebuild on.

## Cloudflare provider

**Storage.** Prebuilds live in the existing sessions bucket under their own
prefix: `prebuilds/<repoKey>/…`, plus a D1 registry table:

```sql
CREATE TABLE prebuilds (
  repo_key   TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,            -- 'cloudflare' (docker rows optional, see below)
  handle     TEXT NOT NULL,            -- serialized DirectoryBackup pointing at prebuilds/…
  source_instance TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE prebuild_runs (          -- dedicated runs, for observation
  id          TEXT PRIMARY KEY,
  repo_key    TEXT NOT NULL,
  provider    TEXT NOT NULL,
  status      TEXT NOT NULL,          -- running | succeeded | failed
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  timings     TEXT,                   -- JSON: cloneMs, installMs, snapshotMs, promoteMs
  error       TEXT,
  log_tail    TEXT                    -- last lines of install output
);
```

**Promote** (one code path, two callers — dedicated runs now, checkpoints
later):

- Copy the just-written snapshot object(s) from the source instance's backup
  keys to `prebuilds/<repoKey>/…` via R2 binding streaming (get → put).
  Rewrite the `DirectoryBackup` handle to point at the copy and upsert the
  registry row. Copy rather than alias: instance deletion purges the
  instance's snapshot prefix, and a prebuild must survive its donor.
- Delete the previous prebuild object(s) only after the new handle is stored.

When the automatic producer lands, it adds two things on top: a
`PREBUILD_MIN_AGE` throttle (30 min — several short sessions a day shouldn't
each stream gigabytes) and fire-and-forget semantics from the checkpoint's
perspective (its failure logs a warning and nothing else). Dedicated runs
promote unthrottled — a manual trigger means the operator wants it now.

**Seed.** In `restoreWorkspace`: when there is no own `latest-backup` and the
instance has a `repoKey` with a registry row, call the host's
`snapshot-restore` with the prebuild handle, then run the shared
`seedWorkspace`. Failure at any point → wipe, proceed to clone. This path runs
before the OpenCode server starts, so the donor-state deletion always precedes
OpenCode opening its database.

## Docker provider

**Protocol.** `EnsureRequest` gains `repoKey?: string`; `EnsureResponse` gains
`seededFromPrebuild?: boolean`. The site passes the instance's `repoKey` (it
already has it); old agents ignore the field, so the change is
backward-compatible.

**Storage.** One prebuild volume per repo on the operator's box:
`oc-prebuild-<slug>` where `slug` is the sanitized repo key (lowercased,
non-`[a-z0-9_.-]` → `-`, truncated + 8-char hash suffix; volume names cannot
contain `/`). Labeled `io.opencode.repo=<repoKey>`. Inside the volume,
generation directories plus a `current` symlink:

```
/gen-<timestamp>/…   ← full workspace copy
/current → gen-<timestamp>
```

Generations exist so a promote never swaps content out from under a concurrent
seed's `cp`: promote writes a new `gen-*`, atomically repoints `current`, and
keeps the previous generation until the next promote deletes it (keep 2).

**Seed.** In the agent's ensure flow, when the session volume was just created,
`repoKey` is present, and the prebuild volume exists: run a helper container
(same session image) with the prebuild volume read-only and the session volume
mounted, `cp -a "$(readlink /src/current)/." /workspace/`. Report
`seededFromPrebuild: true`; the site then runs the shared `seedWorkspace`
sanitize. Helper failure → report `false`, site clones as today.

**Promote** (one code path, two callers). A helper container rsyncs a
*stopped* session volume into a new generation and swaps `current`. rsync
against the previous generation with `--link-dest` makes an unchanged promote
nearly free. A single in-process mutex per repo serializes concurrent promotes
on the one host. The site's D1 registry may mirror docker prebuilds for
observability, but the agent's volume state is authoritative — the site never
needs it to decide anything.

Dedicated runs call this on their throwaway volume after stopping it. The
automatic producer, when it lands, adds: the agent stamps
`io.opencode.repo=<repoKey>` on session containers/volumes at ensure, and
promotes after any labeled container's stop completes (idle timeout or
explicit stop) — stop is the one moment the volume is guaranteed quiescent.

## Concurrency and failure summary

- Two donors promoting the same repo: last write wins (R2 object put is atomic;
  docker promotes serialize on the agent mutex). A stale winner costs one
  incremental install later — acceptable.
- Seed racing a promote: R2 reads the object version it opened; docker reads a
  pinned generation directory. Neither observes a half-written prebuild.
- Every failure on the prebuild path (restore, copy, sanitize, fetch) resolves
  to "wipe and clone", never to `lost`, never to a failed wake.
- Kill switch: a `prebuild.enabled` settings key (default on) checked at both
  promote and seed, for turning the whole mechanism off without a deploy.

## GC

- Cloudflare: one live prebuild per repo; the promote replaces and then deletes
  the previous object. Orphans (repo never used again) are bounded — one
  squashfs per repo — and can be swept by `updated_at` age later if it ever
  matters.
- Docker: two generations per repo volume; `docker volume ls` by label gives
  the operator an inventory. LRU pruning can be added if disk pressure appears.

## What this does not do (deliberately)

- No *scheduled* prebuild pipeline (Codespaces-style on-push Actions builds).
  Runs are manual now, piggybacked later; a cron refresh can be bolted onto
  the run endpoint if staleness ever hurts.
- No lockfile-keyed cache invalidation. Content-addressed stores plus
  `git fetch` + incremental install make staleness self-healing.
- No shared pnpm store volume (the earlier "option 1"). The prebuild carries
  the store; a separate shared store would be redundant.

## Phases

**Phase 1 — manual trigger, Docker only.** The full vertical slice on one
provider: D1 migration (registry + runs), `seedWorkspace` in runtime-ops,
`repoKey`/`seededFromPrebuild` protocol fields, the agent's prebuild volume +
seed-on-ensure + run pipeline + promote, the `/api/prebuilds` routes, the
Prebuilds settings tab (mock fixtures first, then live), `bootStep` and
`workspaceOrigin`. Done means: trigger a run from the tab, watch the step
ladder, then create a session on that repo and see "Restoring cached
workspace" instead of "Cloning" on the boot screen.

**Phase 2 — Cloudflare.** The same run pipeline and seed on the Cloudflare
provider: promote as R2 copy + registry handle, the prebuild-restore branch in
`restoreWorkspace`, runs driven against a throwaway Sandbox instance. Verified
per the tail + R2 playbook (first wake of a new instance running `git fetch`
instead of `git clone`).

**Phase 3 — automatic, invisible.** Promotion piggybacks on real sessions:
promote-after-checkpoint (Cloudflare, `PREBUILD_MIN_AGE` throttle) and
promote-on-stop of labeled containers (Docker). Pure reuse of the promote
step. Plus the `opencode.agents-md` standing line — installs must be
idempotent and prefer `--prefer-offline`; long installs run in background with
logs, never piped to `tail` in the foreground.
