#!/usr/bin/env node
/**
 * `opencode-sandbox-agent` — the Docker implementation of the
 * [Sandbox Host protocol](../protocol/PROTOCOL.md).
 *
 * A zero-dependency Node server that runs on a Mac mini or a Linux box beside a
 * Docker daemon, reached by the site worker over public HTTPS with a bearer
 * token. It is the same kind of thing as `host/` — a dumb primitive server —
 * and holds no session state beyond a cache of published ports: no credentials
 * at rest, no business logic, and, most importantly, **no lifecycle opinions**.
 *
 * That last one is the invariant to protect. There is no idle reaper here and
 * there must never be one: the site stops a container only after it has exported
 * the whole transcript out of a still-live OpenCode, so an agent that stopped
 * containers on its own would silently truncate the history a sleeping session
 * shows. The workspace would survive on its volume — this is not data loss — but
 * the conversation the Hub mirrors would be missing its last turn, and nothing
 * would report that. Containers stop when `POST /sessions/:id/stop` says so.
 *
 * The Docker specifics live in [docker.mjs](docker.mjs); this file is the HTTP
 * contract, the bearer check, and the proxy.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import {
  DEFAULT_EXEC_TIMEOUT_MS,
  OPENCODE_CONTAINER_PORT,
  PREBUILD_VOLUME_LABEL,
  REPO_KEY_PATTERN,
  SERVER_ENV_FILE,
  SERVER_LOG_FILE,
  SESSION_ID_PATTERN,
  SHELL_IDENTIFIER_PATTERN,
  TIMEOUT_EXIT_CODES,
  WORKSPACE_MOUNT,
  capOutput,
  containerName,
  decodeFileContent,
  detachedExecArgs,
  execArgs,
  existsScript,
  inspectArgs,
  isNoSuchObject,
  listFilesScript,
  parseInspect,
  parseListing,
  parsePublishedPort,
  prebuildHelperArgs,
  prebuildMetaScript,
  prebuildPromoteScript,
  prebuildSeedScript,
  prebuildVolumeName,
  readFileScript,
  runArgs,
  runDocker,
  serverAliveScript,
  serverEnvFileContent,
  shellQuote,
  startServerScript,
  volumeName,
  writeFileScript
} from './docker.mjs';

/** Mirrors PROTOCOL_VERSION in protocol/types.ts. */
const PROTOCOL_VERSION = 1;

/** Mirrors OPENCODE_START_TIMEOUT_MS in protocol/types.ts. */
const OPENCODE_START_TIMEOUT_MS = 180_000;

/** The image a session runs when the site names none. */
const DEFAULT_IMAGE = 'opencode-session:latest';

const DEFAULT_STOP_GRACE_SEC = 5;

/** Beyond a stop's own grace period, how long the CLI itself may take. */
const CLI_SLACK_MS = 15_000;

/** Body cap for JSON routes. A write-batch of skills is the large one. */
const MAX_JSON_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Bound on a prebuild copy in either direction (seed or promote). A workspace
 * with a full node_modules is gigabytes, but the copy is local disk to local
 * disk; a quarter hour means something is wedged, not slow.
 */
const PREBUILD_COPY_TIMEOUT_MS = 15 * 60 * 1000;

/** Mirrors the status table in PROTOCOL.md. */
const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  INVALID_REQUEST: 400,
  SESSION_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  DIR_NOT_FOUND: 404,
  CONTAINER_NOT_RUNNING: 503,
  EXEC_TIMEOUT: 408,
  OPENCODE_START_FAILED: 502,
  SNAPSHOT_UNSUPPORTED: 501,
  SNAPSHOT_NOT_FOUND: 404,
  PREBUILD_UNSUPPORTED: 501,
  HOST_ERROR: 500
};

class HostRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}

// --- the server ------------------------------------------------------------

/**
 * Build the agent's HTTP server.
 *
 * Every timeout that could cut a stream is disabled. `/sessions/:id/proxy/event`
 * is an SSE connection that stays open for the life of a session and sends
 * nothing between turns; a server (or a fronting Caddy) that reaps idle sockets
 * turns that into a reconnect loop the site experiences as a session that keeps
 * forgetting it was listening.
 */
export function createAgentServer(options = {}) {
  const token = options.token ?? process.env.OC_AGENT_TOKEN ?? '';
  if (!token) {
    throw new Error('A bearer token is required (OC_AGENT_TOKEN)');
  }
  const context = {
    tokenDigest: digest(token),
    defaultImage: options.image ?? process.env.OC_AGENT_IMAGE ?? DEFAULT_IMAGE,
    log: options.log ?? defaultLog,
    /** sessionId:containerPort → {port, at}. See resolvePublishedPort. */
    ports: new Map(),
    /** sessionId → tail of the lifecycle queue. See withSessionLock. */
    locks: new Map()
  };

  const server = http.createServer((request, response) => {
    handle(context, request, response).catch((error) => {
      context.log('error', `Unhandled request failure: ${describe(error)}`);
      if (!response.headersSent) {
        sendError(response, 'HOST_ERROR', describe(error));
      } else {
        response.destroy();
      }
    });
  });
  // No request may be cut short by the transport: an exec can legitimately run
  // for minutes and a proxied event stream for hours.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;
  return server;
}

async function handle(context, request, response) {
  const startedAt = Date.now();
  const url = new URL(request.url ?? '/', 'http://agent');
  response.on('finish', () => {
    // Only failures are written. A successful request is not evidence of
    // anything — the site polls every session's state on every list refresh,
    // and at 58 sessions that one line accounted for 87% of a log nobody read.
    // Dropping it is what keeps this file small enough to need no rotation.
    if (response.statusCode < 400) {
      return;
    }
    context.log(
      'error',
      `${request.method} ${url.pathname} → ${response.statusCode} ${
        Date.now() - startedAt
      }ms`
    );
  });

  if (!authorized(context, request)) {
    // Including /healthz: a probe that does not carry the token tells an
    // unauthenticated caller that this box runs sessions.
    sendError(response, 'UNAUTHORIZED', 'A bearer token is required');
    return;
  }

  if (url.pathname === '/healthz') {
    if (request.method !== 'GET') {
      sendError(response, 'INVALID_REQUEST', 'healthz is GET');
      return;
    }
    sendJson(response, 200, await healthz());
    return;
  }

  const prebuildMatch = matchPrebuildRoute(request.method ?? 'GET', url.pathname);
  if (prebuildMatch) {
    try {
      await readJsonBody(request);
      sendJson(response, 200, await dispatchPrebuild(context, prebuildMatch));
    } catch (error) {
      if (error instanceof HostRequestError) {
        sendError(response, error.code, error.message);
        return;
      }
      context.log('error', `prebuild ${prebuildMatch.route} failed: ${describe(error)}`);
      sendError(response, 'HOST_ERROR', describe(error));
    }
    return;
  }

  const match = matchSessionRoute(request.method ?? 'GET', url.pathname);
  if (!match) {
    sendError(
      response,
      'INVALID_REQUEST',
      `Unknown route: ${request.method} ${url.pathname}`
    );
    return;
  }

  if (match.route === 'proxy') {
    await proxy(context, match.sessionId, match.proxyPath, url, request, response);
    return;
  }

  try {
    const body = await readJsonBody(request);
    sendJson(response, 200, await dispatch(context, match, body));
  } catch (error) {
    if (error instanceof HostRequestError) {
      sendError(response, error.code, error.message);
      return;
    }
    context.log('error', `${match.route} failed: ${describe(error)}`);
    sendError(response, 'HOST_ERROR', describe(error));
  }
}

function dispatch(context, match, body) {
  const { sessionId, route } = match;
  switch (route) {
    case 'state':
      return sessionState(sessionId);
    case 'ensure':
      return withSessionLock(context, sessionId, () =>
        ensureSession(
          context,
          sessionId,
          optionalString(body, 'image'),
          optionalRepoKey(body)
        )
      );
    case 'stop':
      return withSessionLock(context, sessionId, () =>
        stopSession(context, sessionId, optionalNumber(body, 'timeoutSec'))
      );
    case 'remove':
      return withSessionLock(context, sessionId, () =>
        removeSession(context, sessionId)
      );
    case 'exec':
      return execCommand(sessionId, body);
    case 'write-batch':
      return writeBatch(sessionId, body);
    case 'read':
      return readSessionFile(sessionId, body);
    case 'exists':
      return fileExists(sessionId, body);
    case 'list':
      return listSessionFiles(sessionId, body);
    case 'opencode-start':
      return withSessionLock(context, sessionId, () =>
        startOpencode(context, sessionId, body)
      );
    case 'snapshot':
    case 'snapshot-restore':
      // The workspace lives on a named volume that outlives every container, so
      // there is nothing to archive and nothing to put back. The site branches
      // on `capabilities.snapshots`, so this is the path nobody should reach.
      throw new HostRequestError(
        'SNAPSHOT_UNSUPPORTED',
        'This host persists workspaces on named volumes and takes no snapshots'
      );
    case 'prebuild-promote': {
      const repoKey = requiredRepoKey(body);
      // The session lock keeps the container's existence stable under the
      // copy; the prebuild lock serializes promotes of the same repo, which
      // would otherwise race each other's staging directory.
      return withSessionLock(context, sessionId, () =>
        withSessionLock(context, `prebuild:${repoKey}`, () =>
          promotePrebuild(context, sessionId, repoKey, excludeList(body))
        )
      );
    }
    default:
      throw new HostRequestError('INVALID_REQUEST', `Unknown route: ${route}`);
  }
}

function dispatchPrebuild(context, match) {
  switch (match.route) {
    case 'list':
      return listPrebuilds(context);
    case 'remove':
      return withSessionLock(context, `prebuild:${match.repoKey}`, () =>
        removePrebuild(match.repoKey)
      );
    default:
      throw new HostRequestError(
        'INVALID_REQUEST',
        `Unknown prebuild route: ${match.route}`
      );
  }
}

/**
 * Mirrors `matchSessionRoute` in protocol/routes.ts.
 *
 * Reimplemented rather than imported because the agent is plain `.mjs` shipped
 * on its own; PROTOCOL.md is the contract, and `test/host-protocol.test.mjs`
 * covers the TypeScript twin.
 */
export function matchSessionRoute(method, pathname) {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'sessions' || parts.length < 2) return null;
  const sessionId = parts[1];
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const rest = parts.slice(2);

  if (rest.length === 0) {
    if (method === 'GET') return { sessionId, route: 'state' };
    if (method === 'DELETE') return { sessionId, route: 'remove' };
    return null;
  }
  if (rest[0] === 'proxy') {
    return {
      sessionId,
      route: 'proxy',
      proxyPath: `/${rest.slice(1).join('/')}`
    };
  }
  if (method !== 'POST') return null;
  switch (rest.join('/')) {
    case 'ensure':
      return { sessionId, route: 'ensure' };
    case 'stop':
      return { sessionId, route: 'stop' };
    case 'exec':
      return { sessionId, route: 'exec' };
    case 'files/write-batch':
      return { sessionId, route: 'write-batch' };
    case 'files/read':
      return { sessionId, route: 'read' };
    case 'files/exists':
      return { sessionId, route: 'exists' };
    case 'files/list':
      return { sessionId, route: 'list' };
    case 'opencode/start':
      return { sessionId, route: 'opencode-start' };
    case 'snapshot':
      return { sessionId, route: 'snapshot' };
    case 'snapshot/restore':
      return { sessionId, route: 'snapshot-restore' };
    case 'prebuild/promote':
      return { sessionId, route: 'prebuild-promote' };
    default:
      return null;
  }
}

/** Mirrors `matchPrebuildRoute` in protocol/routes.ts. */
export function matchPrebuildRoute(method, pathname) {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'prebuilds') return null;
  if (parts.length === 1) {
    return method === 'GET' ? { route: 'list' } : null;
  }
  if (parts.length === 2 && method === 'DELETE') {
    const repoKey = parts[1];
    if (!REPO_KEY_PATTERN.test(repoKey)) return null;
    return { route: 'remove', repoKey };
  }
  return null;
}

// --- lifecycle -------------------------------------------------------------

async function healthz() {
  const version = await runDocker(['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 10_000
  });
  const dockerVersion = version.stdout.toString('utf8').trim();
  return {
    ok: version.code === 0 && dockerVersion.length > 0,
    protocolVersion: PROTOCOL_VERSION,
    provider: 'docker',
    // Declared, not probed: the workspace volume outlives the container, which
    // is why this host has nothing to snapshot — and why per-repo prebuilds
    // can live on volumes of their own.
    capabilities: { snapshots: false, prebuilds: true },
    runtime: dockerVersion ? { dockerVersion } : {}
  };
}

async function sessionState(sessionId) {
  const inspected = await inspectContainer(sessionId);
  if (!inspected) {
    return { exists: false, running: false };
  }
  const { status, image, ...state } = inspected;
  return state;
}

/**
 * Bring the session's container to running, creating whatever is missing.
 *
 * The volume is created first and separately from the container, because
 * whether it already existed is the answer to a question only this host can
 * answer: a `workspaceCreated` after the first wake means the volume was lost
 * and recreated, which the site turns into the same `workspaceLost` record a
 * Cloudflare session gets when its snapshot is gone.
 *
 * A stopped container whose image no longer matches the operator's setting is
 * replaced rather than restarted — that is the image upgrade path, and it is
 * safe precisely because the workspace is not in the container. A *running*
 * container is left alone whatever its image: an upgrade is not worth killing a
 * live session over, and the next sleep gets it.
 */
async function ensureSession(context, sessionId, requestedImage, repoKey) {
  const image = requestedImage?.trim() || context.defaultImage;
  const volume = volumeName(sessionId);

  const volumeInspect = await runDocker(['volume', 'inspect', volume], {
    timeoutMs: 15_000
  });
  const workspaceCreated = volumeInspect.code !== 0;
  if (workspaceCreated) {
    await mustRun(['volume', 'create', volume], 'create the workspace volume', {
      timeoutMs: 30_000
    });
  }
  // Only a workspace that did not exist a moment ago may be seeded; anything
  // else is (or was) a session's own data. Failures degrade to an unseeded
  // volume — the site clones as if there were no prebuild.
  const seededFromPrebuild =
    workspaceCreated && repoKey
      ? await seedFromPrebuild(context, { volume, repoKey, image })
      : false;

  let existing = await inspectContainer(sessionId);
  const wasRunning = existing?.running === true;

  if (existing && !wasRunning && existing.image !== image) {
    context.log(
      'info',
      `Replacing ${containerName(sessionId)}: image ${existing.image} → ${image}`
    );
    await runDocker(['rm', '--force', containerName(sessionId)], {
      timeoutMs: 60_000
    });
    existing = undefined;
  }

  if (!existing) {
    await mustRun(runArgs({ sessionId, image }), 'create the session container', {
      timeoutMs: 120_000
    });
  } else if (!wasRunning) {
    await mustRun(['start', containerName(sessionId)], 'start the container', {
      timeoutMs: 60_000
    });
  }

  if (!wasRunning) {
    // A fresh start means a fresh published port; nothing may be proxied to the
    // one the last container held.
    forgetPorts(context, sessionId);
    const now = await inspectContainer(sessionId);
    if (!now?.running) {
      throw new HostRequestError(
        'HOST_ERROR',
        `Container ${containerName(sessionId)} did not stay running (${
          now?.status ?? 'gone'
        })`
      );
    }
  }

  return {
    running: true,
    created: !wasRunning,
    workspaceCreated,
    ...(workspaceCreated ? { seededFromPrebuild } : {})
  };
}

// --- prebuilds -------------------------------------------------------------

/**
 * Copy the repo's prebuild, if one exists, onto a freshly created workspace
 * volume. Returns whether it did; every failure is a log line and `false`,
 * because a session that starts on an empty volume is merely slow, while an
 * ensure that fails here would not start at all.
 */
async function seedFromPrebuild(context, { volume, repoKey, image }) {
  const source = prebuildVolumeName(repoKey);
  const sourceInspect = await runDocker(['volume', 'inspect', source], {
    timeoutMs: 15_000
  });
  if (sourceInspect.code !== 0) {
    return false;
  }
  const result = await runDocker(
    prebuildHelperArgs({
      image,
      mounts: [`${source}:/src:ro`, `${volume}:/dst`],
      script: prebuildSeedScript()
    }),
    { timeoutMs: PREBUILD_COPY_TIMEOUT_MS }
  );
  if (result.code === 0) {
    context.log('info', `Seeded ${volume} from prebuild ${source}`);
    return true;
  }
  // Exit 3 is the script's own "no promoted generation yet" — a prebuild
  // volume that exists but never finished a promote. Not worth a warning.
  if (result.code !== 3) {
    context.log(
      'error',
      `Prebuild seed from ${source} failed (${result.code}): ${result.stderr
        .toString('utf8')
        .trim()}`
    );
  }
  return false;
}

/**
 * Archive a stopped session workspace as the repo's prebuild.
 *
 * The container must not be running: a live OpenCode writes to the volume
 * mid-copy, and half a database is worse than yesterday's prebuild. The copy,
 * the exclusion of caller-named bookkeeping files, the atomic publish and the
 * generation pruning are all one helper-container script.
 */
async function promotePrebuild(context, sessionId, repoKey, exclude) {
  const existing = await inspectContainer(sessionId);
  if (existing?.running) {
    throw new HostRequestError(
      'INVALID_REQUEST',
      'Stop the session container before promoting its workspace'
    );
  }
  const source = volumeName(sessionId);
  const sourceInspect = await runDocker(['volume', 'inspect', source], {
    timeoutMs: 15_000
  });
  if (sourceInspect.code !== 0) {
    throw new HostRequestError(
      'SESSION_NOT_FOUND',
      'This session has no workspace volume to promote'
    );
  }

  const target = prebuildVolumeName(repoKey);
  const targetInspect = await runDocker(['volume', 'inspect', target], {
    timeoutMs: 15_000
  });
  if (targetInspect.code !== 0) {
    await mustRun(
      [
        'volume',
        'create',
        '--label',
        `${PREBUILD_VOLUME_LABEL}=${repoKey}`,
        target
      ],
      'create the prebuild volume',
      { timeoutMs: 30_000 }
    );
  }

  const generation = `gen-${String(Date.now()).padStart(14, '0')}`;
  const image = context.defaultImage;
  const result = await runDocker(
    prebuildHelperArgs({
      image,
      mounts: [`${source}:/src:ro`, `${target}:/dst`],
      script: prebuildPromoteScript({
        generation,
        repoKey,
        updatedAt: new Date().toISOString(),
        exclude
      })
    }),
    { timeoutMs: PREBUILD_COPY_TIMEOUT_MS }
  );
  if (result.code !== 0) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Prebuild promote failed (${result.code}): ${result.stderr
        .toString('utf8')
        .trim()}`
    );
  }
  const lines = result.stdout.toString('utf8').trim().split('\n');
  const sizeBytes = Number.parseInt(lines[lines.length - 1] ?? '', 10);
  context.log('info', `Promoted ${source} to ${target}/${generation}`);
  return {
    promoted: true,
    ...(Number.isFinite(sizeBytes) ? { sizeBytes } : {})
  };
}

/**
 * Every prebuild on this box, from the volumes' own `meta.json` files.
 *
 * One helper container mounts them all read-only rather than one per volume;
 * a volume without a meta — a promote that never finished — is simply absent
 * from the answer, matching what a seed would find there.
 */
async function listPrebuilds(context) {
  const ls = await mustRun(
    [
      'volume',
      'ls',
      '--filter',
      `label=${PREBUILD_VOLUME_LABEL}`,
      '--format',
      '{{.Name}}'
    ],
    'list prebuild volumes',
    { timeoutMs: 15_000 }
  );
  const prefix = 'oc-prebuild-';
  const names = ls.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (name) =>
        name.startsWith(prefix) && REPO_KEY_PATTERN.test(name.slice(prefix.length))
    );
  if (names.length === 0) {
    return { prebuilds: [] };
  }

  const result = await runDocker(
    prebuildHelperArgs({
      image: context.defaultImage,
      mounts: names.map((name, index) => `${name}:/p/${index}:ro`),
      script: prebuildMetaScript(names.length)
    }),
    { timeoutMs: 60_000 }
  );
  if (result.code !== 0) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not read prebuild metadata: ${result.stderr.toString('utf8').trim()}`
    );
  }

  const prebuilds = [];
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const index = Number.parseInt(line.slice(0, tab), 10);
    const name = names[index];
    if (name === undefined) continue;
    try {
      const meta = JSON.parse(line.slice(tab + 1));
      prebuilds.push({
        // The volume name is the identity; the meta merely describes it.
        repoKey: name.slice(prefix.length),
        updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : '',
        ...(Number.isFinite(meta.sizeBytes) ? { sizeBytes: meta.sizeBytes } : {})
      });
    } catch {
      // An unreadable meta is a prebuild the UI cannot date; skip it.
    }
  }
  prebuilds.sort((left, right) => left.repoKey.localeCompare(right.repoKey));
  return { prebuilds };
}

/** Drop a repo's prebuild volume. Idempotent, like session remove. */
async function removePrebuild(repoKey) {
  const removed = await runDocker(
    ['volume', 'rm', '--force', prebuildVolumeName(repoKey)],
    { timeoutMs: 60_000 }
  );
  if (removed.code !== 0 && !isNoSuchObject(removed.stderr.toString('utf8'))) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not remove the prebuild volume: ${removed.stderr
        .toString('utf8')
        .trim()}`
    );
  }
  return { removed: true };
}

/**
 * Bounded stop: `docker stop` is SIGTERM, then SIGKILL after the grace period,
 * so the escalation the protocol describes is the CLI's own. The workspace
 * volume is untouched.
 */
async function stopSession(context, sessionId, timeoutSec) {
  const grace = Math.max(0, timeoutSec ?? DEFAULT_STOP_GRACE_SEC);
  const existing = await inspectContainer(sessionId);
  if (!existing || !existing.running) {
    forgetPorts(context, sessionId);
    return { stopped: true };
  }
  const stopped = await runDocker(
    ['stop', '--timeout', String(grace), containerName(sessionId)],
    { timeoutMs: grace * 1000 + CLI_SLACK_MS }
  );
  forgetPorts(context, sessionId);
  if (stopped.code === 0) {
    return { stopped: true };
  }
  if (isNoSuchObject(stopped.stderr.toString('utf8'))) {
    return { stopped: true };
  }
  // Not an error: the caller retries a pending termination, and says so.
  const after = await inspectContainer(sessionId);
  return { stopped: after?.running !== true };
}

/**
 * Destroy the container *and* the workspace volume.
 *
 * This is the whole of purge for a Docker session — there is no R2 sweep to
 * follow, because there was never a snapshot. `--force` on both makes the call
 * idempotent: removing what is not there is a success.
 */
async function removeSession(context, sessionId) {
  forgetPorts(context, sessionId);
  const removed = await runDocker(
    ['rm', '--force', '--volumes', containerName(sessionId)],
    { timeoutMs: 60_000 }
  );
  if (removed.code !== 0 && !isNoSuchObject(removed.stderr.toString('utf8'))) {
    if (removed.timedOut) {
      return { removed: false };
    }
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not remove the container: ${removed.stderr.toString('utf8').trim()}`
    );
  }
  const volume = await runDocker(['volume', 'rm', '--force', volumeName(sessionId)], {
    timeoutMs: 60_000
  });
  if (volume.code !== 0 && !isNoSuchObject(volume.stderr.toString('utf8'))) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not remove the workspace volume: ${volume.stderr
        .toString('utf8')
        .trim()}`
    );
  }
  return { removed: true };
}

async function inspectContainer(sessionId) {
  const result = await runDocker(inspectArgs(sessionId), { timeoutMs: 15_000 });
  if (result.code !== 0) {
    return undefined;
  }
  return parseInspect(result.stdout.toString('utf8'));
}

// --- primitives ------------------------------------------------------------

async function execCommand(sessionId, body) {
  const command = requiredString(body, 'command');
  const cwd = optionalString(body, 'cwd');
  const env = stringMap(body, 'env');
  const timeoutMs = optionalNumber(body, 'timeoutMs') ?? DEFAULT_EXEC_TIMEOUT_MS;

  const result = await runDocker(
    execArgs({ sessionId, command, cwd, env, timeoutMs, login: true }),
    { timeoutMs: timeoutMs + CLI_SLACK_MS }
  );
  assertContainerReached(result);

  // A command is free to exit 124 or 137 on its own, so the exit code alone is
  // not the answer: it counts as a timeout only if the command also ran for
  // roughly the whole budget. An outer kill (the CLI backstop) is unambiguous.
  const timedOut =
    result.timedOut ||
    (TIMEOUT_EXIT_CODES.has(result.code) && result.durationMs >= timeoutMs * 0.9);
  if (timedOut) {
    throw new HostRequestError(
      'EXEC_TIMEOUT',
      `Command timed out after ${timeoutMs}ms`
    );
  }

  const stdout = capOutput(result.stdout);
  const stderr = capOutput(result.stderr);
  return {
    success: result.code === 0,
    exitCode: result.code,
    stdout: stdout.text,
    stderr: stderr.text,
    ...(stdout.truncated || stderr.truncated
      ? { truncated: { stdout: stdout.truncated, stderr: stderr.truncated } }
      : {})
  };
}

async function writeBatch(sessionId, body) {
  const files = parseWriteBatch(body);
  for (const file of files) {
    const content =
      file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : Buffer.from(file.content, 'utf8');
    await writeContainerFile(sessionId, file.path, content, file.mode);
  }
  return { written: files.length };
}

async function writeContainerFile(sessionId, path, content, mode) {
  const result = await runDocker(
    execArgs({
      sessionId,
      command: writeFileScript(path, mode),
      login: false,
      interactive: true,
      timeoutMs: 60_000
    }),
    { stdin: content, timeoutMs: 60_000 + CLI_SLACK_MS }
  );
  assertContainerReached(result);
  if (result.code !== 0) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not write ${path}: ${result.stderr.toString('utf8').trim()}`
    );
  }
}

async function readSessionFile(sessionId, body) {
  const path = requiredString(body, 'path');
  const result = await runDocker(
    execArgs({
      sessionId,
      command: readFileScript(path),
      login: false,
      timeoutMs: 60_000
    }),
    { timeoutMs: 60_000 + CLI_SLACK_MS }
  );
  assertContainerReached(result);
  if (result.code === 3) {
    throw new HostRequestError('FILE_NOT_FOUND', `No such file: ${path}`);
  }
  if (result.code !== 0) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not read ${path}: ${result.stderr.toString('utf8').trim()}`
    );
  }
  return decodeFileContent(result.stdout);
}

async function fileExists(sessionId, body) {
  const path = requiredString(body, 'path');
  const result = await runDocker(
    execArgs({
      sessionId,
      command: existsScript(path),
      login: false,
      timeoutMs: 30_000
    }),
    { timeoutMs: 30_000 + CLI_SLACK_MS }
  );
  assertContainerReached(result);
  return { exists: result.code === 0 };
}

async function listSessionFiles(sessionId, body) {
  const path = requiredString(body, 'path');
  const includeHidden = optionalBoolean(body, 'includeHidden') ?? true;
  const result = await runDocker(
    execArgs({
      sessionId,
      command: listFilesScript(path),
      login: false,
      timeoutMs: 60_000
    }),
    { timeoutMs: 60_000 + CLI_SLACK_MS }
  );
  assertContainerReached(result);
  if (result.code === 3) {
    throw new HostRequestError('DIR_NOT_FOUND', `No such directory: ${path}`);
  }
  if (result.code !== 0) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not list ${path}: ${result.stderr.toString('utf8').trim()}`
    );
  }
  return { files: parseListing(result.stdout.toString('utf8'), includeHidden) };
}

/**
 * Turn "the daemon could not reach that container" into the protocol's 503.
 *
 * `docker exec` against a stopped container exits 1, and against a missing one
 * 125 — both codes a command inside a healthy container could return just as
 * well. What separates them is the CLI's own `Error response from daemon:`
 * prefix on stderr, which is what {@link isNoSuchObject} anchors on.
 */
function assertContainerReached(result) {
  const stderr = result.stderr.toString('utf8');
  if ((result.code === 1 || result.code === 125) && isNoSuchObject(stderr)) {
    throw new HostRequestError(
      'CONTAINER_NOT_RUNNING',
      'The session container is not running'
    );
  }
  if (result.code === 126 || result.code === 127) {
    if (/timeout|not found|no such file/i.test(stderr)) {
      throw new HostRequestError(
        'HOST_ERROR',
        `The session image is missing a required binary: ${stderr.trim()}`
      );
    }
  }
}

// --- OpenCode --------------------------------------------------------------

/**
 * Start (or adopt) the OpenCode server and wait for it to answer.
 *
 * The environment arrives fully derived from the site — this host never sees
 * the stored OpenCode config — and is written to a mode-600 file inside the
 * container rather than passed on the docker command line, which every user on
 * this box can read. Readiness is polled through the published port, on the
 * protocol's 180 s budget, with the server's liveness checked along the way so
 * a process that dies on startup fails in seconds instead of three minutes.
 */
async function startOpencode(context, sessionId, body) {
  const port = optionalNumber(body, 'port') ?? OPENCODE_CONTAINER_PORT;
  const directory = optionalString(body, 'directory') ?? WORKSPACE_MOUNT;
  const env = stringMap(body, 'env') ?? {};
  for (const key of Object.keys(env)) {
    if (!SHELL_IDENTIFIER_PATTERN.test(key)) {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"env.${key}" is not a valid environment variable name`
      );
    }
  }

  const reused = await serverAlive(sessionId, port);
  if (!reused) {
    await writeContainerFile(
      sessionId,
      SERVER_ENV_FILE,
      Buffer.from(serverEnvFileContent(env), 'utf8'),
      '600'
    );
    const started = await runDocker(
      detachedExecArgs({
        sessionId,
        command: startServerScript({ port, directory })
      }),
      { timeoutMs: 30_000 }
    );
    assertContainerReached(started);
    if (started.code !== 0) {
      throw new HostRequestError(
        'OPENCODE_START_FAILED',
        `Could not spawn the server: ${started.stderr.toString('utf8').trim()}`
      );
    }
  }

  await waitForServer(context, sessionId, port);
  return { started: true, reused };
}

async function serverAlive(sessionId, port) {
  const result = await runDocker(
    execArgs({
      sessionId,
      command: serverAliveScript(port),
      login: false,
      timeoutMs: 15_000
    }),
    { timeoutMs: 15_000 + CLI_SLACK_MS }
  );
  assertContainerReached(result);
  return result.code === 0;
}

async function waitForServer(context, sessionId, port) {
  const deadline = Date.now() + OPENCODE_START_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    const published = await resolvePublishedPort(context, sessionId, port, {
      refresh: attempt === 0
    });
    if (await probeReady(published)) {
      return;
    }
    attempt += 1;
    // Every fifth attempt — about every 2.5 s — ask whether there is still a
    // process to wait for. A server that exits on a bad config would otherwise
    // hold the wake for the full three minutes before reporting anything.
    if (attempt % 5 === 0 && !(await serverAlive(sessionId, port))) {
      throw new HostRequestError(
        'OPENCODE_START_FAILED',
        `The OpenCode server exited during startup. ${await serverLogTail(
          sessionId
        )}`
      );
    }
    await delay(500);
  }
  throw new HostRequestError(
    'OPENCODE_START_FAILED',
    `The OpenCode server did not answer within ${OPENCODE_START_TIMEOUT_MS}ms. ${await serverLogTail(
      sessionId
    )}`
  );
}

/** Readiness is `GET /path` returning 200, as PROTOCOL.md specifies. */
function probeReady(publishedPort) {
  return new Promise((resolve) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: publishedPort,
        path: '/path',
        method: 'GET',
        timeout: 5_000
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function serverLogTail(sessionId) {
  const result = await runDocker(
    execArgs({
      sessionId,
      command: `tail -c 4000 ${shellQuote(SERVER_LOG_FILE)} 2>/dev/null || true`,
      login: false,
      timeoutMs: 15_000
    }),
    { timeoutMs: 15_000 + CLI_SLACK_MS }
  );
  const tail = result.stdout.toString('utf8').trim();
  return tail ? `Log: ${tail}` : 'The server wrote no log.';
}

// --- proxy -----------------------------------------------------------------

/**
 * Reverse-proxy one request to the container's OpenCode port.
 *
 * Bodies stream in both directions and nothing is buffered: `/event` is an SSE
 * stream that must reach the site chunk by chunk, which is also why Nagle is
 * off on both sockets — a 40 ms coalescing delay per frame is visible in the
 * UI as a conversation that stutters.
 *
 * A container that is not running is a JSON 503, never a hang. That matters
 * more here than anywhere else: the site's gate is what keeps a passive UI
 * retry from waking a session, and a proxy that blocked instead of answering
 * would hold the request until something else timed out.
 */
async function proxy(context, sessionId, proxyPath, url, request, response) {
  let published;
  try {
    published = await resolvePublishedPort(
      context,
      sessionId,
      OPENCODE_CONTAINER_PORT
    );
  } catch (error) {
    sendError(
      response,
      error instanceof HostRequestError ? error.code : 'CONTAINER_NOT_RUNNING',
      describe(error)
    );
    return;
  }

  const headers = { ...request.headers };
  // The bearer is this agent's own credential and the host header names this
  // agent, not the container.
  delete headers.authorization;
  delete headers.host;
  delete headers.connection;
  delete headers['keep-alive'];
  delete headers['proxy-authorization'];
  delete headers['transfer-encoding'];
  delete headers.upgrade;

  await new Promise((resolve) => {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: published,
        path: `${proxyPath}${url.search}`,
        method: request.method,
        headers
      },
      (upstreamResponse) => {
        upstreamResponse.socket?.setNoDelay(true);
        response.socket?.setNoDelay(true);
        response.writeHead(
          upstreamResponse.statusCode ?? 502,
          stripHopByHop(upstreamResponse.headers)
        );
        response.flushHeaders();
        upstreamResponse.pipe(response);
        upstreamResponse.on('end', resolve);
        upstreamResponse.on('error', () => {
          response.destroy();
          resolve();
        });
      }
    );
    upstream.on('error', (error) => {
      // The container went away mid-flight, or the published port moved under
      // us. Either way the site's answer is the same: re-ensure and retry.
      context.ports.delete(portKey(sessionId, OPENCODE_CONTAINER_PORT));
      if (!response.headersSent) {
        sendError(
          response,
          'CONTAINER_NOT_RUNNING',
          `The session container did not answer: ${describe(error)}`
        );
      } else {
        response.destroy();
      }
      resolve();
    });
    // A client that goes away — a navigated-away browser, an aborted SSE
    // subscription — must take the connection into the container with it rather
    // than leaving it open. This has to hang off the *response*: an
    // `IncomingMessage` emits `close` as soon as its body has been consumed,
    // which for a body-less GET is immediately, so watching the request instead
    // means every proxied GET destroys its own upstream before the container
    // has answered — a 503 "socket hang up" for a container that is perfectly
    // healthy. `writableFinished` is what distinguishes a finished response
    // from an abandoned one.
    response.on('close', () => {
      if (!response.writableFinished) {
        upstream.destroy();
      }
      resolve();
    });
    request.pipe(upstream);
  });
}

function stripHopByHop(headers) {
  const forwarded = { ...headers };
  delete forwarded.connection;
  delete forwarded['keep-alive'];
  delete forwarded['transfer-encoding'];
  delete forwarded.upgrade;
  return forwarded;
}

/**
 * Which loopback port the container's OpenCode port is published on.
 *
 * The port is chosen by the kernel at every container start (`-p
 * 127.0.0.1:0:4096`), so it is cached rather than resolved per request — and
 * cached for seconds rather than for the life of the container. The window this
 * bounds is narrow but real: if a container went down without the agent
 * stopping it (a crash, then the restart policy), the port it held is released
 * and could in principle be handed to a different session's container, and a
 * stale entry would proxy one session's traffic into another's workspace. Every
 * lifecycle call clears the entry outright; the TTL is what covers the paths
 * that do not go through one.
 */
const PORT_CACHE_TTL_MS = 3_000;

function portKey(sessionId, containerPort) {
  return `${sessionId}:${containerPort}`;
}

async function resolvePublishedPort(context, sessionId, containerPort, options = {}) {
  const key = portKey(sessionId, containerPort);
  const cached = context.ports.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < PORT_CACHE_TTL_MS) {
    return cached.port;
  }
  const result = await runDocker(
    ['port', containerName(sessionId), `${containerPort}/tcp`],
    { timeoutMs: 15_000 }
  );
  if (result.code !== 0) {
    context.ports.delete(key);
    throw new HostRequestError(
      'CONTAINER_NOT_RUNNING',
      'The session container is not running'
    );
  }
  const port = parsePublishedPort(result.stdout.toString('utf8'));
  if (!port) {
    throw new HostRequestError(
      'HOST_ERROR',
      `The container publishes no loopback port for ${containerPort}/tcp`
    );
  }
  context.ports.set(key, { port, at: Date.now() });
  return port;
}

function forgetPorts(context, sessionId) {
  for (const key of context.ports.keys()) {
    if (key.startsWith(`${sessionId}:`)) {
      context.ports.delete(key);
    }
  }
}

// --- plumbing --------------------------------------------------------------

/**
 * Serialize the calls that change a container's existence.
 *
 * Two `ensure`s that raced would both see no container and both try to create
 * one; the loser fails with a name conflict for no reason. Primitives are
 * deliberately outside the queue — they are the fast path, and a `docker exec`
 * against a container being stopped is already an honest 503.
 */
function withSessionLock(context, sessionId, work) {
  const previous = context.locks.get(sessionId) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => {},
    () => {}
  );
  context.locks.set(sessionId, settled);
  settled.then(() => {
    if (context.locks.get(sessionId) === settled) {
      context.locks.delete(sessionId);
    }
  });
  return next;
}

async function mustRun(args, what, options) {
  const result = await runDocker(args, options);
  if (result.code !== 0) {
    throw new HostRequestError(
      'HOST_ERROR',
      `Could not ${what}: ${result.stderr.toString('utf8').trim() || `docker exited ${result.code}`}`
    );
  }
  return result;
}

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

/**
 * Constant-time bearer comparison.
 *
 * Both sides are hashed first so the buffers are the same length whatever the
 * caller sent — `timingSafeEqual` throws on a length mismatch, and throwing on
 * "wrong length" is itself the leak it exists to prevent.
 */
function authorized(context, request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), context.tokenDigest);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new HostRequestError('INVALID_REQUEST', 'Body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        reject(new HostRequestError('INVALID_REQUEST', 'Body is not valid JSON'));
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(
          new HostRequestError('INVALID_REQUEST', 'Body must be a JSON object')
        );
        return;
      }
      resolve(parsed);
    });
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  response.end(payload);
}

function sendError(response, code, message) {
  sendJson(response, ERROR_STATUS[code] ?? 500, { code, message });
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultLog(level, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

// --- body validation (mirrors host/support.ts) -----------------------------

function requiredString(body, field) {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" is required`);
  }
  return value;
}

function optionalString(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" must be a string`);
  }
  return value;
}

function optionalNumber(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" must be a number`);
  }
  return value;
}

function optionalBoolean(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" must be a boolean`);
  }
  return value;
}

function optionalRepoKey(body) {
  const value = optionalString(body, 'repoKey');
  if (value !== undefined && !REPO_KEY_PATTERN.test(value)) {
    throw new HostRequestError('INVALID_REQUEST', '"repoKey" is not a valid repo key');
  }
  return value;
}

function requiredRepoKey(body) {
  const value = requiredString(body, 'repoKey');
  if (!REPO_KEY_PATTERN.test(value)) {
    throw new HostRequestError('INVALID_REQUEST', '"repoKey" is not a valid repo key');
  }
  return value;
}

/** The promote body's `exclude`: workspace-relative paths, validated later. */
function excludeList(body) {
  const value = body.exclude;
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new HostRequestError(
      'INVALID_REQUEST',
      '"exclude" must be an array of strings'
    );
  }
  return value;
}

function stringMap(body, field) {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HostRequestError(
      'INVALID_REQUEST',
      `"${field}" must be an object of strings`
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"${field}.${key}" must be a string`
      );
    }
  }
  return { ...value };
}

function parseWriteBatch(body) {
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new HostRequestError(
      'INVALID_REQUEST',
      '"files" must be a non-empty array'
    );
  }
  return files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HostRequestError('INVALID_REQUEST', 'Each file must be an object');
    }
    const path = requiredString(entry, 'path');
    if (!path.startsWith('/')) {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `File path must be absolute: ${path}`
      );
    }
    if (typeof entry.content !== 'string') {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"content" is required for ${path}`
      );
    }
    const encoding = optionalString(entry, 'encoding') ?? 'utf-8';
    if (encoding !== 'utf-8' && encoding !== 'base64') {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `Unsupported encoding for ${path}: ${encoding}`
      );
    }
    const mode = optionalString(entry, 'mode');
    if (mode !== undefined && !/^[0-7]{3,4}$/.test(mode)) {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"mode" must be an octal string for ${path}`
      );
    }
    return { path, content: entry.content, encoding, mode };
  });
}

// --- entry point -----------------------------------------------------------

/** Start the agent. Returns the listening server. */
export function startAgent(options = {}) {
  const server = createAgentServer(options);
  const port = Number(options.port ?? process.env.OC_AGENT_PORT ?? 8787);
  const host = options.host ?? process.env.OC_AGENT_HOST ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

/** The token, from the environment or from a file launchd can keep at 0600. */
export async function resolveToken() {
  if (process.env.OC_AGENT_TOKEN) {
    return process.env.OC_AGENT_TOKEN.trim();
  }
  if (process.env.OC_AGENT_TOKEN_FILE) {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(process.env.OC_AGENT_TOKEN_FILE, 'utf8')).trim();
  }
  return '';
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const token = await resolveToken();
  if (!token) {
    console.error(
      'Set OC_AGENT_TOKEN or OC_AGENT_TOKEN_FILE to the bearer token the site sends.'
    );
    process.exit(1);
  }
  const server = await startAgent({ token });
  const address = server.address();
  console.log(
    `[${new Date().toISOString()}] opencode-sandbox-agent listening on ${
      address.address
    }:${address.port}`
  );
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // Close the listener but let in-flight requests — a clone, an export —
      // finish; nothing here decides a container's fate.
      server.close(() => process.exit(0));
    });
  }
}
