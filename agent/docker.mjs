/**
 * The Docker half of the sandbox agent: everything that knows what a container
 * is.
 *
 * Two kinds of thing live here. The pure half — names, argument vectors, shell
 * scripts, output parsers — is exported so `test/agent-docker.test.mjs` can
 * check the parts that are easy to get quietly wrong without a Docker daemon in
 * the loop. The impure half is one function, {@link runDocker}, which spawns the
 * CLI and collects bounded output; every operation in `server.mjs` is one or a
 * few of those.
 *
 * This file has no dependencies, by design: the agent is copied onto a Mac mini
 * and run by launchd against the system `node`, with no install step and nothing
 * to keep in sync but this repository's PROTOCOL.md.
 *
 * The constants below are duplicated from `protocol/types.ts` rather than
 * imported — that file is TypeScript inside a Worker build, and the agent must
 * stay plain `.mjs`. PROTOCOL.md is the contract both sides read.
 */
import { spawn } from 'node:child_process';

/** Mirrors SESSION_ID_PATTERN in protocol/types.ts. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Mirrors EXEC_OUTPUT_LIMIT_BYTES in protocol/types.ts. */
export const EXEC_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

/** The port OpenCode serves on inside the container. */
export const OPENCODE_CONTAINER_PORT = 4096;

/** Where the session's workspace volume is mounted. */
export const WORKSPACE_MOUNT = '/workspace';

/**
 * How long an `exec` runs when the caller names no budget.
 *
 * The site passes an explicit `timeoutMs` for everything it expects to be slow
 * (a clone, a fetch, a git command); this is the backstop that keeps an
 * unbounded command from holding an HTTP request open forever.
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

/**
 * How GNU `timeout` reports that it cut a command short.
 *
 * 124 is the documented one, for the child that took the SIGTERM. 137 is
 * 128+SIGKILL, which is what comes back when the child ignored it and
 * `--kill-after` escalated — and also what an OOM kill looks like, which is why
 * the exec route weighs the elapsed time before calling either a timeout.
 */
export const TIMEOUT_EXIT_CODES = new Set([124, 137]);

/**
 * The OpenCode server's environment, written inside the container instead of
 * passed as `docker exec -e`.
 *
 * It carries every provider API key, and a `docker` argument vector is visible
 * to every user on the host through `ps`. `/root` is in the container's own
 * layer rather than the workspace volume, so this never survives into a
 * snapshot, a `docker cp`, or the next container built on the same volume.
 */
export const SERVER_ENV_FILE = '/root/.opencode-server.env';

/** Where a detached OpenCode server's output goes, for the 502 message. */
export const SERVER_LOG_FILE = '/tmp/opencode-server.log';

/** The docker CLI to spawn. Overridable because launchd has no useful PATH. */
export const DOCKER_BIN = process.env.OC_AGENT_DOCKER || 'docker';

export function containerName(sessionId) {
  return `oc-session-${assertSessionId(sessionId)}`;
}

export function volumeName(sessionId) {
  return `oc-vol-${assertSessionId(sessionId)}`;
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

// --- prebuilds -------------------------------------------------------------

/** Mirrors REPO_KEY_PATTERN in protocol/types.ts. */
export const REPO_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Every prebuild volume carries this label with the repo key as its value. */
export const PREBUILD_VOLUME_LABEL = 'io.opencode.prebuild';

/**
 * How many promoted generations a prebuild volume keeps.
 *
 * Two, not one, so a promote never yanks the directory a concurrent seed is
 * copying from: the seed pinned `current`'s target when it resolved the
 * symlink, and that generation survives until the promote after next.
 */
export const PREBUILD_KEPT_GENERATIONS = 2;

export function assertRepoKey(repoKey) {
  if (typeof repoKey !== 'string' || !REPO_KEY_PATTERN.test(repoKey)) {
    throw new Error(`Invalid repo key: ${JSON.stringify(repoKey)}`);
  }
  return repoKey;
}

export function prebuildVolumeName(repoKey) {
  return `oc-prebuild-${assertRepoKey(repoKey)}`;
}

/**
 * A helper container that sees two volumes and nothing else.
 *
 * Prebuild content moves between volumes with `docker run --rm` around plain
 * `cp`, because on macOS the daemon's volumes live inside a VM the agent
 * cannot reach by path. The session image is used because it is the one image
 * guaranteed present on a box that runs sessions.
 */
export function prebuildHelperArgs({ image, mounts, script }) {
  const args = ['run', '--rm'];
  for (const mount of mounts) {
    args.push('--volume', mount);
  }
  args.push(image, 'sh', '-c', script);
  return args;
}

/**
 * Copy the prebuild's current generation onto a fresh workspace volume.
 *
 * Exit 3 — the same "nothing there" convention the file scripts use — when the
 * volume has no promoted generation yet; the caller treats that as "no
 * prebuild", not a failure. `cp -a` keeps modes and times, which the pnpm
 * store's content addressing relies on.
 */
export function prebuildSeedScript() {
  return [
    'set -e',
    'test -d /src/current/. || exit 3',
    'cp -a /src/current/. /dst/'
  ].join('\n');
}

/**
 * Promote a stopped session workspace into a prebuild generation.
 *
 * The copy lands in a dot-prefixed staging directory, excluded paths are
 * dropped, and only then does one `mv` publish it — a reader never sees a
 * half-written generation. The `current` symlink is replaced via rename for
 * the same reason. Old generations beyond {@link PREBUILD_KEPT_GENERATIONS}
 * are pruned by name order; `gen-` names sort by creation because they embed
 * a zero-padded timestamp. `meta.json` is what `GET /prebuilds` reads; the
 * size in it and on stdout is the same `du -sb`. The final line of stdout is
 * the byte count the caller parses.
 */
export function prebuildPromoteScript({ generation, repoKey, updatedAt, exclude = [] }) {
  if (!/^gen-\d+$/.test(generation)) {
    throw new Error(`Invalid generation name: ${JSON.stringify(generation)}`);
  }
  assertRepoKey(repoKey);
  if (!/^[0-9TZ:.-]{10,40}$/.test(updatedAt)) {
    throw new Error(`Invalid timestamp: ${JSON.stringify(updatedAt)}`);
  }
  const rms = exclude.map(
    (path) => `rm -rf /dst/.staging/${shellQuote(assertRelativePath(path))}`
  );
  return [
    'set -e',
    'rm -rf /dst/.staging',
    'mkdir /dst/.staging',
    'cp -a /src/. /dst/.staging/',
    ...rms,
    `mv /dst/.staging /dst/${generation}`,
    `ln -sfn ${generation} /dst/.current-next`,
    'mv -T /dst/.current-next /dst/current',
    `ls -1 /dst | grep '^gen-' | sort | head -n -${PREBUILD_KEPT_GENERATIONS} | while read -r old; do rm -rf "/dst/$old"; done`,
    `size=$(du -sb /dst/${generation} | cut -f1)`,
    `printf '{"repoKey":"${repoKey}","updatedAt":"${updatedAt}","sizeBytes":%s}' "$size" > /dst/meta.json.next`,
    'mv /dst/meta.json.next /dst/meta.json',
    'echo "$size"'
  ].join('\n');
}

/**
 * Paths in a promote's exclude list are workspace-relative bookkeeping files
 * named by the site. Constrained rather than escaped, same as repo keys.
 */
export function assertRelativePath(path) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z0-9._][A-Za-z0-9._/-]{0,255}$/.test(path) ||
    path.includes('..')
  ) {
    throw new Error(`Invalid exclude path: ${JSON.stringify(path)}`);
  }
  return path;
}

/**
 * Read every mounted prebuild's metadata in one helper container.
 *
 * Each volume is mounted at `/p/<index>`; the script prints one line per
 * mount: the index, a tab, and the `meta.json` content (which is written by
 * the agent on promote and never contains a newline). A volume with no meta —
 * promoted by a future agent, wiped by hand — prints nothing and is skipped.
 */
export function prebuildMetaScript(count) {
  return [
    `i=0`,
    `while [ "$i" -lt ${Number(count)} ]; do`,
    '  if [ -f "/p/$i/meta.json" ]; then',
    `    printf '%s\\t' "$i"; cat "/p/$i/meta.json"; printf '\\n'`,
    '  fi',
    '  i=$((i + 1))',
    'done'
  ].join('\n');
}

/** Single-quote a value for `sh -c`. Same rule as the site's shellQuote. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** The parent directory of an absolute path; `/` at the root. */
export function parentDirectory(path) {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

// --- argument vectors ------------------------------------------------------

/**
 * Create the session container.
 *
 * Three details are load-bearing. `-p 127.0.0.1:0:4096` publishes OpenCode on a
 * kernel-chosen loopback port because macOS cannot route to a container IP —
 * the agent proxies through the published port and asks `docker port` for it,
 * since it changes on every start. `--init` puts a reaper at PID 1 so the
 * processes OpenCode spawns and abandons do not accumulate as zombies behind
 * `sleep infinity`. And `--restart unless-stopped` is the *only* lifecycle
 * opinion the agent holds: it brings back containers a reboot or a daemon
 * restart took down, and never a container the site stopped on purpose.
 */
export function runArgs({ sessionId, image, port = OPENCODE_CONTAINER_PORT }) {
  if (typeof image !== 'string' || image.trim().length === 0) {
    throw new Error('An image is required to create a session container');
  }
  return [
    'run',
    '--detach',
    '--init',
    '--restart',
    'unless-stopped',
    '--name',
    containerName(sessionId),
    '--label',
    `io.opencode.session=${sessionId}`,
    '--volume',
    `${volumeName(sessionId)}:${WORKSPACE_MOUNT}`,
    '--publish',
    `127.0.0.1:0:${port}`,
    image.trim(),
    'sleep',
    'infinity'
  ];
}

/**
 * Run one command inside the session container.
 *
 * `timeout` inside the container rather than killing the CLI: signalling
 * `docker exec` from out here severs the pipe and leaves the command running
 * inside the container, which is how a timed-out clone becomes a second clone
 * racing the first. GNU `timeout` runs the child in its own process group and
 * signals the group, so the shell's children go with it.
 *
 * SIGTERM first with `--kill-after` behind it, rather than SIGKILL outright:
 * `timeout` only reports the documented 124 when it sends the default signal
 * (`--signal=KILL` exits 137 instead, indistinguishable from an OOM kill), and
 * a git that gets a TERM leaves a less broken index behind than one that does
 * not.
 *
 * `login` is true for the protocol's `exec` route, whose contract is `sh -lc`,
 * and false for the agent's own helpers — a login shell may print whatever
 * `/etc/profile` feels like into stdout, and file contents must not be
 * concatenated with a MOTD.
 */
export function execArgs({
  sessionId,
  command,
  cwd,
  env,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  login = true,
  interactive = false
}) {
  const args = ['exec'];
  if (interactive) {
    args.push('--interactive');
  }
  if (cwd) {
    args.push('--workdir', cwd);
  }
  for (const [key, value] of Object.entries(env ?? {})) {
    args.push('--env', `${key}=${value}`);
  }
  args.push(containerName(sessionId));
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  args.push('timeout', '--kill-after=5', String(seconds));
  args.push('sh', login ? '-lc' : '-c', command);
  return args;
}

/** `docker exec --detach`: start something and leave it running. */
export function detachedExecArgs({ sessionId, command }) {
  return ['exec', '--detach', containerName(sessionId), 'sh', '-c', command];
}

/** The tab-separated container state the agent reads on every inspect. */
export const INSPECT_FORMAT =
  '{{.State.Status}}\t{{.State.Running}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{.State.ExitCode}}\t{{.Config.Image}}';

export function inspectArgs(sessionId) {
  return ['inspect', '--format', INSPECT_FORMAT, containerName(sessionId)];
}

// --- scripts ---------------------------------------------------------------

/**
 * Write one file from stdin.
 *
 * Written to a sibling temporary path and moved into place, so a reader never
 * sees a half-written file and a failed write leaves the previous one intact —
 * "atomic per file, not per batch", as PROTOCOL.md puts it. The mode is applied
 * before the move because OpenSSH refuses a private key that was ever readable
 * by anyone else.
 *
 * One `docker exec` per file rather than a tar stream: the batching the protocol
 * asks for is of the *site → agent* hop, which is one HTTPS request either way,
 * and a local exec costs milliseconds against a hand-rolled tar writer's long
 * names and checksums.
 */
export function writeFileScript(path, mode) {
  const target = shellQuote(path);
  const dir = shellQuote(parentDirectory(path));
  return [
    'set -e',
    `mkdir -p ${dir}`,
    `tmp=${target}.oc-write.$$`,
    'cat > "$tmp"',
    ...(mode ? [`chmod ${mode} "$tmp"`] : []),
    `mv -f "$tmp" ${target}`
  ].join('\n');
}

/** `cat` a file, distinguishing "no such file" from an unreadable one. */
export function readFileScript(path) {
  const target = shellQuote(path);
  return `test -f ${target} || exit 3\ncat -- ${target}`;
}

export function existsScript(path) {
  return `test -e ${shellQuote(path)}`;
}

/**
 * One directory, no recursion, in a form that survives odd file names.
 *
 * Records are NUL-separated because a newline is a legal character in a file
 * name and a listing that splits on one is a listing that can be forged from
 * inside the container. `%T@` is epoch seconds, converted here rather than
 * trusting either side's locale.
 */
export function listFilesScript(path) {
  const target = shellQuote(path);
  return `test -d ${target} || exit 3\ncd ${target} && find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`;
}

/**
 * Is an OpenCode server already serving this port?
 *
 * The bracket is not a typo: `pgrep -f` matches against every process's command
 * line including the `sh -c` that carries this pattern, so a literal pattern
 * always finds itself and reports a server that does not exist. `s[e]rve`
 * matches `serve` as a regex while the shell's own argv contains the brackets.
 */
export function serverAliveScript(port) {
  return `pgrep -f 'opencode s[e]rve --port ${Number(port)}' > /dev/null`;
}

/**
 * The environment file the server is started with.
 *
 * `set -a` around the source makes plain assignments exported, so the values
 * need quoting but no `export`. Keys are validated by the caller: a key that is
 * not a shell identifier cannot be assigned, and silently dropping one would
 * mean a server missing an API key for reasons nobody could see.
 */
export function serverEnvFileContent(env) {
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

export const SHELL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Start the OpenCode server, detached, with exactly the given environment.
 *
 * The log is truncated on each start so the 502 a failed start returns quotes
 * this attempt rather than the last one. `exec` replaces the shell so the
 * process `pgrep` finds — and the one the next `opencode/start` adopts — is
 * OpenCode itself.
 */
export function startServerScript({
  port,
  directory = WORKSPACE_MOUNT,
  envFile = SERVER_ENV_FILE,
  logFile = SERVER_LOG_FILE
}) {
  return [
    'set -a',
    `. ${shellQuote(envFile)}`,
    'set +a',
    `cd ${shellQuote(directory)}`,
    `: > ${shellQuote(logFile)}`,
    `exec opencode serve --port ${Number(port)} --hostname 0.0.0.0 >> ${shellQuote(
      logFile
    )} 2>&1`
  ].join('\n');
}

// --- parsers ---------------------------------------------------------------

/**
 * Cut one output stream to the protocol's cap.
 *
 * Counted in bytes, because the limit is a transport one, and the head is what
 * survives: in a batched script the first failure explains everything printed
 * after it.
 */
export function capOutput(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  if (bytes.byteLength <= EXEC_OUTPUT_LIMIT_BYTES) {
    return { text: bytes.toString('utf8'), truncated: false };
  }
  return {
    text: bytes.subarray(0, EXEC_OUTPUT_LIMIT_BYTES).toString('utf8'),
    truncated: true
  };
}

/**
 * Decide how a file goes onto the wire.
 *
 * `utf-8` for text, base64 for anything else. A NUL byte is the cheap tell, and
 * a round trip through the decoder catches the rest: `toString('utf8')` replaces
 * invalid sequences with U+FFFD instead of failing, so the only honest test is
 * whether re-encoding reproduces the original bytes.
 */
export function decodeFileContent(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer));
  if (!bytes.includes(0)) {
    const text = bytes.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') === bytes.byteLength) {
      return { content: text, encoding: 'utf-8' };
    }
  }
  return { content: bytes.toString('base64'), encoding: 'base64' };
}

const FIND_TYPES = { f: 'file', d: 'directory', l: 'symlink' };

/**
 * Parse `listFilesScript` output into the protocol's file shape.
 *
 * The name is taken as "everything after the third tab" rather than by
 * splitting, because a tab is as legal in a file name as a newline is.
 */
export function parseListing(stdout, includeHidden = true) {
  const files = [];
  for (const record of String(stdout).split('\0')) {
    if (record.length === 0) continue;
    const parts = splitFields(record, 3);
    if (!parts) continue;
    const [type, size, mtime, name] = parts;
    if (!includeHidden && name.startsWith('.')) continue;
    const modifiedAt = epochToIso(mtime);
    files.push({
      name,
      type: FIND_TYPES[type] ?? 'other',
      size: Number.parseInt(size, 10) || 0,
      ...(modifiedAt ? { modifiedAt } : {})
    });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

function splitFields(record, count) {
  const fields = [];
  let rest = record;
  for (let index = 0; index < count; index += 1) {
    const at = rest.indexOf('\t');
    if (at < 0) return null;
    fields.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  fields.push(rest);
  return fields;
}

function epochToIso(value) {
  const seconds = Number.parseFloat(value);
  if (!Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Parse {@link INSPECT_FORMAT} into the protocol's session state.
 *
 * Docker writes the zero time as `0001-01-01T00:00:00Z` for a container that
 * has never run or never stopped; that is an absent field, not an old one.
 */
export function parseInspect(stdout) {
  const [status = '', running = '', startedAt = '', finishedAt = '', exitCode = '', image = ''] =
    String(stdout).trim().split('\t');
  const isRunning = running === 'true';
  const started = normalizeDockerTime(startedAt);
  const finished = normalizeDockerTime(finishedAt);
  const changedAt = isRunning ? started : (finished ?? started);
  const code = Number.parseInt(exitCode, 10);
  return {
    exists: true,
    running: isRunning,
    status,
    image,
    ...(isRunning && started ? { startedAt: started } : {}),
    ...(changedAt ? { changedAt } : {}),
    ...(!isRunning && Number.isFinite(code) ? { exitCode: code } : {})
  };
}

function normalizeDockerTime(value) {
  if (!value || value.startsWith('0001-01-01')) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * The loopback port `4096/tcp` is published on.
 *
 * `docker port <name> 4096/tcp` prints `127.0.0.1:49154`; `docker port <name>`
 * prints `4096/tcp -> 127.0.0.1:49154`. Both are accepted, and an IPv6 binding
 * is skipped rather than parsed — the agent connects over IPv4 loopback.
 */
export function parsePublishedPort(stdout) {
  for (const line of String(stdout).split('\n')) {
    const address = line.includes('->') ? line.split('->').pop() : line;
    const match = /(?:^|\s)(?:127\.0\.0\.1|0\.0\.0\.0):(\d+)\s*$/.exec(
      String(address).trim()
    );
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
}

/**
 * Docker's several ways of saying "that container or volume is not there".
 *
 * Anchored on the CLI's own error prefix, because this decides whether a
 * non-zero exit becomes a 503: a command inside a healthy container is free to
 * print the words "no such container" and must not be mistaken for one.
 */
export function isNoSuchObject(stderr) {
  return /^Error(?: response from daemon)?:.*(?:no such (?:container|object|volume)|is not running)/im.test(
    String(stderr)
  );
}

// --- the one impure function ----------------------------------------------

/**
 * Spawn the docker CLI and collect its output, bounded in both bytes and time.
 *
 * Output past `limitBytes` is dropped rather than buffered — the streams are
 * still drained, because a container writing to a full pipe blocks — and the
 * caller is told with `truncated`. `timeoutMs` here is a backstop around the
 * CLI itself; commands that run *inside* a container carry their own
 * `timeout` (see {@link execArgs}), which is the one that stops the work.
 */
export function runDocker(args, options = {}) {
  const {
    stdin,
    timeoutMs = 0,
    limitBytes = EXEC_OUTPUT_LIMIT_BYTES,
    bin = DOCKER_BIN
  } = options;
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(bin, args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    const stdout = collect(child.stdout, limitBytes);
    const stderr = collect(child.stderr, limitBytes);
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : undefined;

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: stdout.buffer(),
        stderr: stderr.buffer(),
        truncated: { stdout: stdout.truncated(), stderr: stderr.truncated() },
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });

    if (stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // A command that exits without reading its input (a full disk, a
        // missing directory) closes the pipe under us; the exit code is the
        // error worth reporting, not EPIPE.
      });
      child.stdin.end(stdin);
    }
  });
}

function collect(stream, limitBytes) {
  const chunks = [];
  let size = 0;
  let dropped = false;
  stream.on('data', (chunk) => {
    if (size >= limitBytes) {
      dropped = true;
      return;
    }
    const room = limitBytes - size;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      size = limitBytes;
      dropped = true;
      return;
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  });
  return {
    buffer: () => Buffer.concat(chunks),
    truncated: () => dropped
  };
}
