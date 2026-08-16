# Hub API

Every route lives under the one Worker origin and requires the admin session
cookie (see *Production access control* in the README).

## Session API

```bash
# Repository and model choices for the composer. The repository list is
# GitHub's, cached for ten minutes; `?refresh=1` skips that cache. A listing
# failure with nothing cached answers 500 rather than an empty list.
curl http://localhost:8787/api/catalog

# List sessions with their dispatch phase and live instance state.
curl http://localhost:8787/api/sessions

# Start a session. Returns HTTP 202 immediately; `model` defaults to the
# configured default model.
curl -X POST http://localhost:8787/api/sessions \
  -H 'Content-Type: application/json' \
  --data '{"repoKey":"<repo>","model":"<providerID>/<modelID>","prompt":"Fix the lint errors in packages/core"}'

# Inspect one session.
curl http://localhost:8787/api/sessions/<session-id>

# Read the transcript. Never wakes a container: a running one is read live
# (`"source":"container"`), a stopped one is served from its R2 mirror
# (`"source":"mirror"` plus the `mirroredAt` the export was taken at).
# `X-OpenCode-Hub-Transcript-{State,Source,At,Mirrored-At}` carry the same
# facts in headers.
curl http://localhost:8787/api/sessions/<session-id>/messages

# Follow the session live. Also never wakes anything, and the stream is
# expected to end — an EventSource reconnects, and the state frame it gets
# back is how the page learns the session woke or went to sleep.
curl -N http://localhost:8787/api/sessions/<session-id>/events

# Read a subagent's own conversation. OpenCode's `task` tool runs its work in a
# child session inside the same container; `?child=` narrows both the transcript
# and the event stream to it. Unlike the parent it has no R2 mirror, so a
# sleeping container answers `"state":"sleeping"` with no messages.
curl 'http://localhost:8787/api/sessions/<session-id>/messages?child=<opencode-session-id>'
curl -N 'http://localhost:8787/api/sessions/<session-id>/events?child=<opencode-session-id>'

# Where that subagent sits under the session that started it: the path from the
# root session down to it, which is also the check that the id belongs here at
# all (404 otherwise). Needs a running container, so a sleeping one answers 409.
curl 'http://localhost:8787/api/sessions/<session-id>/agent-session?child=<opencode-session-id>'

# Continue the conversation. Returns HTTP 202 whether the container is running
# or asleep: a prompt to a sleeping session is queued and wakes it. `model`
# switches models, and `promptId` makes a retried request the same prompt
# rather than a second one.
curl -X POST http://localhost:8787/api/sessions/<session-id>/messages \
  -H 'Content-Type: application/json' \
  --data '{"prompt":"Now add a test for it"}'

# What the agent changed in the checkout: branch, changed files and the diff
# against HEAD. Unlike every other read this one needs a running container —
# the working tree only exists inside one — so it refuses on a sleeping session
# rather than waking it.
curl http://localhost:8787/api/sessions/<session-id>/changes

# Start the container and nothing else: no prompt, no OpenCode session, nothing
# queued. This is how a reader gets back to the diff or the files of a sleeping
# session without sending the agent a message to do it. Answers with the session
# view; 503 while a wake is still queued behind an idle-stop, which is a retry.
curl -X POST http://localhost:8787/api/sessions/<session-id>/wake

# There is no publish route: pushing is the agent's own job. Ask it in a prompt
# — it has git, `gh` and the credentials inside the container.

# Rename a session. Does not touch the container.
curl -X PATCH http://localhost:8787/api/sessions/<session-id> \
  -H 'Content-Type: application/json' \
  --data '{"title":"A better name"}'

# Browse the checkout inside a running container. `path` is relative to it and
# cannot leave it; `&read=1` returns one file (text capped at 256 KB).
curl 'http://localhost:8787/api/sessions/<session-id>/files?path=src'
curl 'http://localhost:8787/api/sessions/<session-id>/files?read=1&path=src/index.ts'

# Interrupt a running agent, leaving the conversation intact.
curl -X POST http://localhost:8787/api/sessions/<session-id>/abort

# Re-run a failed start sequence.
curl -X POST http://localhost:8787/api/sessions/<session-id>/retry

# Delete the session together with its container and snapshots (HTTP 202).
curl -X DELETE http://localhost:8787/api/sessions/<session-id>
```

Sessions carry their own accounting and housekeeping. Tokens and cost are summed
from the assistant messages OpenCode priced and ride along on the transcript
mirror, so the list shows them without touching a container; OpenCode's own
title for a conversation replaces the first line of the opening prompt once it
has one, unless the session has been renamed by hand; and archiving takes a
session out of the default list while keeping its container, history and mirror
— sending it a message brings it straight back.

## Instance API

Instances are created only as part of a session. What remains is the operational
surface for one container: reading its state, driving its runtime, and the
deletion path that session deletion delegates to.

```bash
# List instances with live container and persistence state.
curl http://localhost:8787/api/instances

# Inspect one instance.
curl http://localhost:8787/api/instances/<instance-id>

# Explicitly start the container. Nothing in the UI calls this any more —
# sending a session a message is what wakes one — so this is the manual start.
# It answers with the merged runtime status, including the wake's stage timings.
curl -X POST http://localhost:8787/api/instances/<instance-id>/wake

# Create a snapshot without stopping.
curl -X POST http://localhost:8787/api/instances/<instance-id>/checkpoint

# Snapshot and stop. Only a later explicit wake starts and restores it.
curl -X POST http://localhost:8787/api/instances/<instance-id>/stop

# Queue container destruction and permanent R2 cleanup (returns HTTP 202).
curl -X DELETE http://localhost:8787/api/instances/<instance-id>

# Programmatic OpenCode SDK smoke test for one instance.
curl -X POST http://localhost:8787/api/instances/<instance-id>/test
```
