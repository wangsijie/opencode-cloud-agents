# opencode-sandbox-agent

The Docker implementation of the
[Sandbox Host protocol](../protocol/PROTOCOL.md): a zero-dependency Node server
that runs session containers on a Mac mini (or any Linux box) beside a Docker
daemon, and answers the same HTTP API the Cloudflare host worker in [`host/`](../host)
answers.

The same agent runs on every box the operator has. Nothing in here knows about
the others: a host is one entry in the site's `docker.hosts` setting, with its
own name, its own token and its own volumes, and a session that lands on it
stays on it. Setting up a second box is this file from the top, with a
different id at step 5.

Once it is up, give the deploy its keys — `SANDBOX_AGENT_2_SSH_{HOST,PORT,USER,KEY}`
as repository secrets, and an entry in the matrix in
[`deploy.yml`](../.github/workflows/deploy.yml) — or the box quietly stays on
whatever commit was rsynced onto it by hand.

It is a *primitive server*. It holds no session state, no credentials at rest,
and no business logic — the site worker owns the runtime gate, the epoch, the
transcript mirror and every lifecycle decision. Two files:

| File | What it is |
|---|---|
| [`server.mjs`](server.mjs) | the HTTP contract, the bearer check, the reverse proxy |
| [`docker.mjs`](docker.mjs) | argument vectors, container scripts, output parsers, one `spawn` |

Each session gets a container `oc-session-<id>` and a named volume
`oc-vol-<id>` mounted at `/workspace`. **The volume is the persistence**: this
host reports `capabilities.snapshots: false`, and a session survives a stop
because the workspace was never in the container.

## The agent makes no lifecycle decisions

There is no idle reaper here and there must never be one.

The site stops a container only *after* exporting the whole transcript out of a
still-running OpenCode — that ordering is what makes a sleeping session's
history complete. An agent that stopped containers on its own would silently
truncate that history at whatever the last mirror happened to be. The workspace
would still be on the volume, so it is not data loss, and nothing anywhere would
report it: the session would simply be missing its last turn.

Containers stop when `POST /sessions/:id/stop` says so. The one lifecycle
opinion the agent does hold is `--restart unless-stopped`, which brings back
containers a reboot or a Docker restart took down and never one the site
stopped.

## Requirements

- **Node 20+** (`node --version`) — the agent is plain ESM with no dependencies
  and no install step.
- **Docker** with a daemon the agent's user can reach (`docker version`). The
  agent only ever spawns the `docker` CLI, so any engine that provides one will
  do — Docker Desktop, OrbStack, Colima. On macOS all of them run as the
  logged-in user rather than as a root daemon, which is why the agent is a
  launchd *user agent*.
- **The session image**, built from this repository (below).
- A public HTTPS front — the agent binds `127.0.0.1` and expects a TLS
  terminator with a real certificate in front of it.

The image must carry, beyond the protocol's container contract (`sh`, `git`,
`openssh-client`, `gh`, `node`, `opencode`): `procps` for `pgrep`, coreutils
`timeout`, and GNU `find` with `-printf`. The agent uses all three, and the
supplied image installs them.

## Setup

### 1. Build the session image

The build context is the repository root, because the SSH client config and the
pinned `known_hosts` come from [`docker/ssh/`](../docker/ssh):

```bash
docker build -f agent/session-image/Dockerfile -t opencode-session:latest .
```

On macOS, build it over SSH with the engine's CLI directory on `PATH`:
`ssh host 'docker build …'` gets `/usr/bin:/bin:/usr/sbin:/sbin` and nothing
else, so a build that works in a login shell fails there with "command not
found". OrbStack installs to `/usr/local/bin`; Docker Desktop keeps its own copy
in `/Applications/Docker.app/Contents/Resources/bin`.

Check `~/.docker/config.json` on the same box. A `credsStore` naming a helper
that is not installed fails any build that has to pull, with an opaque "error
getting credentials" — and uninstalling Docker Desktop leaves exactly that
behind, rewriting the key to `osxkeychain` while removing the binary. With no
`auths` entries the whole key is unnecessary; deleting it is the fix.

The image carries no credentials. Every secret — the SSH key pair, the `gh`
login, git identity, environment variables, OpenCode skills — lives in the
site's settings table and is written into the container on each wake.

### 2. Write the token

Generate a long random token and store it where only the agent's user can read
it. It goes in two places: this file, and this host's entry in the site's
`docker.hosts` setting.

```bash
mkdir -p ~/.config/opencode-agent
openssl rand -hex 32 > ~/.config/opencode-agent/token
chmod 600 ~/.config/opencode-agent/token
```

The agent reads `OC_AGENT_TOKEN` or, preferably, `OC_AGENT_TOKEN_FILE`: a token
in an environment variable is visible to anything that can read the process
table, `launchctl procinfo` or `systemctl show`.

Each box gets its own token. They are per-host entries in the same setting, and
one token shared between two boxes would mean rotating it on both at once.

### 3. Run it as a service

Copy the file for the box's init system and start it:
[`systemd/opencode-sandbox-agent.service`](systemd/opencode-sandbox-agent.service)
on Linux (sources at `/srv/opencode-cloud`, `journalctl -u
opencode-sandbox-agent`), or
[`launchd/io.opencode.sandbox-agent.plist`](launchd/io.opencode.sandbox-agent.plist)
on macOS, where the paths need replacing and it must be a *user* agent because
the engine runs as the logged-in user. Both files carry their own install
commands and the reasoning behind their settings.

That difference is the one that bites: a Mac mini needs automatic login and
"start up automatically after a power failure" enabled, or the first reboot
takes every session with it. A Linux box needs nobody logged in at all.

Restarting the *agent* touches no container on either — sessions keep running
and the site reconnects — which is what makes a deploy cheap.

One thing about a Linux box: Ubuntu's `docker.io` package ships without
BuildKit, and the image build needs it — `COPY --chmod` fails with "the --chmod
option requires BuildKit" halfway through. `apt-get install docker-buildx` is
the whole fix.

Environment variables the job reads:

| Variable | Default | |
|---|---|---|
| `OC_AGENT_TOKEN_FILE` | — | file holding the bearer token (preferred) |
| `OC_AGENT_TOKEN` | — | the token itself |
| `OC_AGENT_HOST` | `127.0.0.1` | bind address; keep it loopback |
| `OC_AGENT_PORT` | `8787` | |
| `OC_AGENT_IMAGE` | `opencode-session:latest` | used when the site names no image |
| `OC_AGENT_DOCKER` | `docker` | path to the CLI, for a launchd PATH that lacks it |

### 4. Put a TLS terminator in front

The agent speaks plain HTTP on loopback; the terminator owns TLS and the public
name. [`nginx/opencode-sandbox-agent.conf`](nginx/opencode-sandbox-agent.conf)
is the one to install if the box has nginx and certbot — replace `SERVER_NAME`,
enable it, then `certbot --nginx -d <name>`, which rewrites the file with the
TLS lines and installs its own renewal timer. Point the name straight at the
box, not through a proxy that would answer the HTTP-01 challenge itself.

Whatever terminates TLS, the settings that matter are the ones that keep a
stream alive: no response buffering, and no idle timeout short enough to reap
one. `/sessions/:id/proxy/event` is an SSE stream the site's transcript mirror
lives on; it can be silent for hours between turns and must arrive frame by
frame. In Caddy that is `flush_interval -1` plus zero `read_timeout` and
`write_timeout` on the `http` transport; the nginx file says the same thing in
its own words, with the reasoning in comments.

A buffered or reaped stream does not fail loudly. It shows up as a session that
keeps forgetting it was listening — the site reconnects, the mirror falls back
to polling, and the transcript's `reason` stops saying `live`.

### 5. Point the site at it

On the Hub's `/settings` page, under **Docker hosts**, add an entry:

- **id** — `mac-mini`, say: lowercase letters, digits and dashes. Sessions
  store `docker:<id>`, so pick it once — it cannot be changed afterwards
  without orphaning every session on this box.
- **label** — what the composer's picker calls it; optional, defaults to the id
- **agent URL** — `https://sandbox.example.com` (origin only, no path)
- **agent token** — the token from step 2
- **session image** — optional; defaults to `opencode-session:latest`
- **idle timeout** — optional minutes; defaults to 30

Both the URL and the token must be set before the host appears as a provider on
the new-session form. Add as many hosts as you run: the list order is the order
they are offered in, and the first is the default for a new session. The site
caches the resolved configuration inside each session's Durable Object for
**60 seconds**, so a settings change takes up to a minute to reach a live
session.

## Verifying

```bash
curl -sS -H "Authorization: Bearer $(cat ~/.config/opencode-agent/token)" \
  https://sandbox.example.com/healthz
```

```json
{"ok":true,"protocolVersion":1,"provider":"docker","capabilities":{"snapshots":false},"runtime":{"dockerVersion":"27.4.0"}}
```

An unauthenticated request gets 401 — including on `/healthz`, deliberately, so
a probe cannot learn that this box runs sessions.

For the whole protocol against a real daemon, run the scripted end-to-end check
on a machine with Docker and the image. It starts its own agent on a random
loopback port, drives the site's wake path in miniature, and cleans up after
itself:

```bash
node agent/e2e.mjs                # everything
node agent/e2e.mjs --no-opencode  # skip the server start, proxy and SSE
node agent/e2e.mjs --keep         # leave the container behind to poke at
```

It is not part of `pnpm test`, which has no Docker. The pure half — argument
construction, the container scripts, output truncation, the text/binary
decision, the listing parser — is covered by
[`test/agent-docker.test.mjs`](../test/agent-docker.test.mjs).

**What a healthy session looks like in production** (measured 2026-07-28, a
Mac mini over a TLS front end). A first cold start — container, credentials,
`git clone`, OpenCode — took 15 seconds from `POST /api/sessions` to the first
prompt reaching the container. A wake after an idle stop took 6 seconds: no
snapshot to restore, so it is the container start, one credential batch, a
`git fetch` and the server. The Cloudflare host, doing the same wake with a
2 MB workspace snapshot to put back, took 33 seconds. If a wake here starts
costing tens of seconds, the volume is not being reused — look for a recreated
volume, which the site reports as a lost session rather than a slow one.

## Operations

**Rotating the token.** Write the new value into the site's settings first, then
into the token file, then `launchctl kickstart -k gui/$(id -u)/io.opencode.sandbox-agent`.
Sessions in flight see up to a minute of 401s (the site's settings cache) and
recover on their own; nothing is lost, because a failed wake leaves the
workspace on its volume.

**Upgrading the image.** Build the new tag, then set this host's image to it. A
session picks it up at its next *cold* start: `ensure` replaces a stopped
container whose image no longer matches, and leaves a running one alone — an
upgrade is not worth killing a live session for. To force it, stop the session
from the Hub and wake it again. Because the workspace is on the volume, an image
swap needs no migration and loses no history.

**Deleting a session.** `DELETE /sessions/:id` removes the container *and* the
volume: for a Docker session that is the whole of purge, and there is no R2
sweep to follow. It also means a session must be deleted from the Hub *before*
the Docker settings are cleared — with no agent URL the site cannot reach the
host, and the session sits in `deleting`.

**Reading logs.** The agent logs one line per *failed* request (method, path,
status, duration) and never a body; a 2xx is written nowhere. The site polls
every session's state on every list refresh, so success lines grow with the
number of sessions rather than with anything worth reading — logging only
failures is what keeps this file small enough to need no rotation. Lifecycle
events that are neither a request nor a failure (an image replacement, a
prebuild seed or promote) are still logged. A session's OpenCode server logs
inside its container at `/tmp/opencode-server.log`; a failed `opencode/start`
quotes the tail of it in the 502.

## Notes on the implementation

A few decisions that are not obvious from the outside, all of them written out
at the code:

- **The published port is looked up, not remembered.** Containers publish
  OpenCode with `-p 127.0.0.1:0:4096`, because macOS cannot route to a container
  IP. The kernel picks a different port at every start, so the agent asks
  `docker port`, caches the answer for three seconds, and drops it on every
  lifecycle call.
- **`exec` is bounded inside the container.** `timeout --signal=KILL` around
  `sh -lc`, not a kill of the docker CLI — signalling from outside severs the
  pipe and leaves the command running, which is how a timed-out clone becomes
  two clones racing.
- **The server environment is written to a file, not passed as `-e`.** It
  carries every provider API key, and a `docker` argument vector is readable by
  every user on the box. It goes to `/root/.opencode-server.env` at mode 600 —
  the container's own layer, not the workspace volume.
- **Files are written through a temporary path and moved.** Atomic per file, and
  the mode is applied before the move, because OpenSSH refuses a private key
  that was ever readable by anyone else.
- **Listings are NUL-separated.** A newline is legal in a file name, and a
  listing that split on one could be forged from inside a container.
