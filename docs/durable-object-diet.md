# Durable Object diet: one source of truth, in D1

## Problem

Five Durable Object classes hold roughly 7,400 lines between them, and most of
what they hold is not something a Durable Object is needed for. Three separate
problems are tangled together in that number:

**State is duplicated, and the copy is the one the UI reads.** `SessionAgent`
owns `phase`, `pending`, `opencodeSessionId`, `model`, `lastError` — and then
mirrors a subset into the `sessions` row through `reportToHub`
(`src/session-agent.ts:851`). The mirror is fire-and-forget: a failed write logs
a warning and is repaired only "by the next successful report", which may never
come. The session list renders from that copy. `LifecycleCoordinator` does the
same with `lastSyncedLifecycle` (`src/lifecycle.ts:204`), whose entire purpose is
to skip redundant mirror writes. So the registry is not a projection that lags
by a moment — it is a projection that can be permanently wrong, with no
reconciliation anywhere.

**State is duplicated with columns that already exist.** `InstanceIdentity`
(`src/sandbox.ts:272`) carries `repoKey`, `repo`, `provider` — all three are
columns on `sessions`. `RunState` (`src/prebuild-runner.ts:85`) carries `runId`,
`repoKey`, `provider`, `timings` — the `prebuild_runs` row is inserted by the
same object that holds the struct. These are not caches of remote data; they are
second copies of local data.

**State exists only to survive eviction.** A Durable Object is evicted
constantly, so every field must be rebuildable from storage, and some fields
exist purely to admit that:

```ts
/**
 * Whether anything may have happened since the last export. It starts true so
 * a Durable Object that was just restarted re-exports once instead of trusting
 * a watermark it did not write.
 */
private transcriptDirty = true;
```
— `src/sandbox.ts:414`

That is not session state. That is tax.

None of this is an argument against Durable Objects. It is an argument that
three different things are currently being stored in them: **data**, **locks**,
and **timers**. Only the last two need the object.

## Goal

> Every piece of durable session data lives in D1 and is read from D1. A Durable
> Object holds locks, timers and live connections — never the authoritative copy
> of anything a query could answer.

The test to apply to any surviving field: *if this object were destroyed right
now, is anything lost that a `SELECT` could not reproduce?* If no, it does not
belong in storage. If yes, it belongs in a table.

## Why not KV

D1 only. KV is eventually consistent — a write followed by a read can return the
previous value — and every piece of state here is read-your-own-write: a phase
transition is read back by the next request, a `revision` is compared against
the value just written. The site already reads D1 through the primary
deliberately (the Sessions API read replication is unused, see
`wrangler.jsonc`), and that choice is what makes this migration safe at all.

The one legitimate KV-shaped value is the 60-second `hostClient` cache
(`src/sandbox.ts:390`), and that one does not need to be persistent at all.

## The three categories

Everything currently in DO storage or DO memory falls into exactly one of these.
The categories, not the file layout, decide the plan.

### Category 1 — DO tax: delete, replace with nothing

State that exists because the object can be evicted, or because the platform
stopped answering a question. It is not replaced by a table; it disappears.

| State | Location | Why it goes |
| --- | --- | --- |
| `hostRuntime` | `sandbox.ts:386` | Local answer to "is the container up" invented when `container.running` went away with the binding. `sessions.container` / `status_observed_at` already exist. |
| `hostClient` cache | `sandbox.ts:390` | Pure 60s performance cache over the settings table. |
| `lastWake` | `runtime:last-wake` | Wake stage timings — observability data, belongs in a row or a log, not in the object. |
| `knownLocations` | `runtime:known-locations` | Discovered from the container; rediscoverable at any time. |
| `lastSyncedLifecycle` | `lifecycle.ts:204` | Exists only to skip duplicate mirror writes. With one source of truth there is no mirror. |
| `transcriptDirty = true` | `sandbox.ts:414` | Explicitly a "the DO just restarted" hedge. |
| `LEGACY_BACKUP_HANDLES_STORAGE_KEY` | `sandbox.ts:129` | Superseded by the per-handle prefix; only the migration read path remains (2773, 2824). |
| `LEGACY_SCHEMA_VERSION_KEY` | `hub.ts:16` | Marker for an era of storage that is wiped on sight. |
| `*InProgress` single-flight fields (8 across two classes) | `sandbox.ts:391-397`, `lifecycle.ts:201-203` | Kept — but as **locks**, not state. Never persisted, never migrated. |

### Category 2 — Data wearing a DO costume: move to D1, invert the truth

State that is already shaped like a row, and in several cases already *has* a
row. The work is inverting which copy is authoritative, then deleting the other.

| State | Key | Destination |
| --- | --- | --- |
| `RunState` | `prebuild:run` | `prebuild_runs` (+ `step`, `step_started_at`, `attempts`; `timings` already exists) |
| `StoredSessionAgentState` | `session-agent:state` | `sessions` columns (most already exist) + new `session_prompts` table |
| `InstanceIdentity` | `instance:identity` | Nothing new — `repo_key`, `repo_json`, `provider` are already columns |
| backup handle ledger | `persistence:backup-handle:*` | New `session_backups` table |
| `purgeRequested` | `instance:purge-requested` | `sessions.lifecycle` already models the deleting state |
| `workspaceLost`, `lastError`, `lastRestore` | three keys | Columns on `sessions` |

### Category 3 — Genuinely the object's job: keep

Three things, none of which is data.

1. **Per-session serialization.** `lifecycleMutationTail`, `operationDrainWaiters`,
   `lifecycleDrainWaiters`, and the single-flight promises. A database cannot
   provide this; `idFromName(sessionId)` is exactly the right primitive.
2. **Persistent alarms.** Idle reclamation, retry backoff, the deletion drain,
   the prebuild watchdog. `setAlarm` and `storage.put` commit in the *same
   transaction* — D1 has no equivalent, and losing that atomicity means either
   "state advanced but nothing will poke it" or "poked twice".
3. **Live container connections.** The `liveEvents` subscription
   (`sandbox.ts:417`).

`StoredLifecycleState` (`lifecycle.ts:84`) is the deliberate grey area. Its
fields — `idleCandidateSince`, `nextProbeAt`, `consecutiveProbeFailures`,
`workLeases` — are data, and could be columns. But every one of them exists to
be read by an alarm in the same object, nothing outside reads them, and this is
the most intricate state machine in the repository. **It stays where it is.**
Category 2 is justified by an external reader; this has none.

## Plan

Four stages. Each ships on its own and each leaves the tree in a state that can
be released — in particular, **no stage ends with a double-write still in
place**, because a double-write is the bug being fixed, not a migration step.

### Stage 0 — Delete the tax

No migration, no new table. Remove the Category 1 entries and the two legacy
key readers. Nothing observable changes.

Worth noting as the target shape: `Hub` (`src/hub.ts`) already holds **no state
at all** — its constructor only wipes legacy storage and bootstraps an alarm,
and it drives the deletion queue out of D1. That is what the other classes
should look like when this is done.

### Stage 1 — `RunState` to `prebuild_runs`

The smallest independent case, chosen first to validate the shape: a DO that
schedules but does not store.

- Add `step`, `step_started_at`, `attempts`, `provider` to `prebuild_runs`.
- `PrebuildRunner` keeps its watchdog alarm and its single-flight guard, and
  reads the run from D1.
- Immediate payoff: run progress becomes a SQL query instead of an RPC into the
  object.

Low risk by construction — one repo at a time, no concurrent writers, and a
failed run is re-runnable.

### Stage 2 — Invert `SessionAgent` (the stage that fixes the bug)

1. New `session_prompts` table for the queue. Ordered, queryable, replayable,
   and it subsumes `deliveredPromptIds` (today an array inside the struct) as a
   column instead of a second list.
2. `phase`, `model`, `variant`, `opencodeSessionId`, `lastError`, `lastPromptAt`,
   `attempt` become authoritative on `sessions`. `reportToHub` is deleted, not
   redirected.
3. Delete `InstanceIdentity` — every field is already a column.
4. Whatever remains of `StoredSessionAgentState` is likely just `schemaVersion`;
   if so, drop the key entirely.

**The one behavioural change:** with the mirror gone, `updateSession` is on the
critical path. A failure must propagate, not warn. Today's `catch` that logs and
continues (`session-agent.ts:874`) becomes wrong — it would silently drop a
phase transition. Cover this in tests as part of the stage.

### Stage 3 — Backup ledger to `session_backups`

`persistence:backup-handle:*` is read by prefix scan (`sandbox.ts:2790`), which
is a `WHERE session_id = ?` in disguise. A table also makes the ledger
auditable: today a lost handle is an orphaned R2 object discoverable only by
sweeping the whole `backups/` prefix.

Snapshot deletion stays outside the protocol either way — the site deletes the
objects, a host is never asked to forget one.

### Stage 4 — `RuntimeGate` to D1 CAS (optional, last)

`RuntimeGate` (`sandbox.ts:326`) carries `revision` and `runtimeEpoch`: it is
already an optimistic lock, and `UPDATE ... WHERE revision = ?` with a
changed-rows check expresses it *more* strongly than the in-object version,
because it stays correct with more than one writer.

Deliberately last: it sits on the wake and stop hot paths, and the payoff is
architectural consistency rather than a fixed bug. Ship it alone.

## What this does not do

This is not a step toward leaving Cloudflare, and it does not depend on doing
so. Every stage is worth shipping on the current platform: Stage 2 fixes a real
consistency bug, and the rest remove duplication.

It does, however, leave a smaller target if that migration is ever made. What
would remain to reimplement is locks, alarms and one live subscription — not
7,400 lines of state management. The persistent scheduler that would replace
`setAlarm` (a `due_at` table with leases and crash-safe re-entry) is the one
piece with no equivalent here, and it is the piece to design carefully if that
day comes.

## Verification

Each stage must keep the existing suite green:

```bash
pnpm test
pnpm run typecheck
```

Stage 2 additionally needs a test that a failed `sessions` write surfaces as an
error rather than a warning — that is the invariant the old mirror silently
violated.
