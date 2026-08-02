/**
 * The Cloudflare sandbox host: one Durable Object per session container.
 *
 * This class is deliberately dumb. It owns no session state beyond what it
 * needs to answer `GET /sessions/:id` (does this session exist, when did it
 * start, which port is OpenCode on), holds no credentials past the request
 * that carries them, and makes no lifecycle decisions — the site worker keeps
 * the runtime gate, the epoch, the backup ledger and every policy. Everything
 * here is a primitive from the sandbox SDK behind the HTTP contract in
 * [PROTOCOL.md](../protocol/PROTOCOL.md).
 *
 * It extends the SDK's `Sandbox` rather than wrapping one because the class
 * *is* the container binding: `containerFetch`, `exec`, the file APIs and
 * `createBackup`/`restoreBackup` are all instance methods of that base.
 */
import { Sandbox as BaseSandbox, type DirectoryBackup } from '@cloudflare/sandbox';
import { createOpencodeServer } from '@cloudflare/sandbox/opencode';
import { matchSessionRoute, type RouteMatch } from '../protocol/routes.ts';
import {
  type EnsureResponse,
  type ExecResponse,
  type ExistsResponse,
  type HostFileInfo,
  type ListFilesResponse,
  type OpencodeStartResponse,
  type ReadFileResponse,
  type RemoveResponse,
  type SessionStateResponse,
  type SnapshotResponse,
  type SnapshotRestoreResponse,
  type StopResponse,
  type WriteBatchResponse
} from '../protocol/types.ts';
import {
  HostRequestError,
  capOutput,
  errorToResponse,
  forwardedHeaders,
  isExecTimeout,
  jsonResponse,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parentDirectory,
  parseWriteBatch,
  proxyTargetUrl,
  readJsonBody,
  requiredString,
  shellQuote,
  stringMap
} from './support.ts';

/** Set on ensure, cleared by DELETE: what `exists` reports. */
const SESSION_STORAGE_KEY = 'host:session';
/** Which port the last `opencode/start` used, so proxy knows where to go. */
const OPENCODE_PORT_STORAGE_KEY = 'host:opencode-port';

/** The port the site serves OpenCode on, and the proxy default. */
const DEFAULT_OPENCODE_PORT = 4096;
/** Bound on the exec that boots the container during `ensure`. */
const ENSURE_TIMEOUT_MS = 120_000;
/** Bound on the monitor wait after a signal, per escalation step. */
const TERMINATION_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_GRACE_SEC = 5;

interface StoredSession {
  createdAt: string;
  startedAt?: string;
}

export class CloudflareSandboxHost extends BaseSandbox<Env> {
  /**
   * Serve the protocol.
   *
   * The entry worker has already routed by session id, so this re-parses only
   * to pick the operation. Every failure below leaves through
   * {@link errorToResponse}, which is what keeps `{code, message}` on the wire
   * instead of a stack trace.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = matchSessionRoute(request.method, url.pathname);
    if (!match) {
      return errorToResponse(
        new HostRequestError(
          'INVALID_REQUEST',
          `Unknown route: ${request.method} ${url.pathname}`
        )
      );
    }
    try {
      return await this.dispatch(match, request, url);
    } catch (error) {
      return errorToResponse(error, ROUTE_ERROR_CODES[match.route]);
    }
  }

  private async dispatch(
    match: RouteMatch,
    request: Request,
    url: URL
  ): Promise<Response> {
    switch (match.route) {
      case 'state':
        return jsonResponse(await this.sessionState());
      case 'ensure':
        await readJsonBody(request); // `image` is fixed by wrangler here.
        return jsonResponse(await this.ensureSession());
      case 'stop': {
        const body = await readJsonBody(request);
        const timeoutSec = optionalNumber(body, 'timeoutSec');
        return jsonResponse(await this.stopSession(timeoutSec));
      }
      case 'remove':
        return jsonResponse(await this.removeSession());
      case 'exec':
        return jsonResponse(await this.execCommand(request));
      case 'write-batch':
        return jsonResponse(await this.writeBatch(request));
      case 'read':
        return jsonResponse(await this.readSessionFile(request));
      case 'exists':
        return jsonResponse(await this.fileExists(request));
      case 'list':
        return jsonResponse(await this.listSessionFiles(request));
      case 'opencode-start':
        return jsonResponse(await this.startOpencode(request));
      case 'proxy':
        return await this.proxy(request, url, match.proxyPath ?? '/');
      case 'snapshot':
        return jsonResponse(await this.snapshot(request));
      case 'snapshot-restore':
        return jsonResponse(await this.restoreSnapshot(request));
      case 'prebuild-promote':
        // The site branches on `capabilities.prebuilds`, so like the Docker
        // host's snapshot routes this is the path nobody should reach.
        throw new HostRequestError(
          'PREBUILD_UNSUPPORTED',
          'This host holds no prebuilds yet'
        );
    }
  }

  // --- lifecycle ---------------------------------------------------------

  private async ensureSession(): Promise<EnsureResponse> {
    const running = this.isRunning();
    const stored =
      await this.ctx.storage.get<StoredSession>(SESSION_STORAGE_KEY);
    // Without this the SDK's idle alarm would stop a container the site still
    // considers awake; sleeping is the site's decision, made from OpenCode
    // activity rather than from HTTP traffic.
    await this.setKeepAlive(true);
    if (!running) {
      // The first control-plane call is what boots the container and waits for
      // it to answer; `true` is the cheapest one that does.
      await this.exec('true', { timeout: ENSURE_TIMEOUT_MS });
    }
    const session: StoredSession = {
      createdAt: stored?.createdAt ?? new Date().toISOString(),
      startedAt: running
        ? stored?.startedAt ?? new Date().toISOString()
        : new Date().toISOString()
    };
    await this.ctx.storage.put(SESSION_STORAGE_KEY, session);
    return {
      running: true,
      created: !running,
      // Cloudflare containers are ephemeral and nothing outside one survives
      // it, so a container this call had to start is by definition a fresh
      // workspace. Putting a snapshot back is the caller's next step, not ours.
      workspaceCreated: !running
    };
  }

  private async sessionState(): Promise<SessionStateResponse> {
    const stored =
      await this.ctx.storage.get<StoredSession>(SESSION_STORAGE_KEY);
    const running = this.isRunning();
    const state = await this.getState();
    const changedAt =
      typeof state.lastChange === 'number' && state.lastChange > 0
        ? new Date(state.lastChange).toISOString()
        : undefined;
    const exitCode =
      state.status === 'stopped_with_code' ? state.exitCode : undefined;
    return {
      exists: stored !== undefined || running,
      running,
      ...(running && stored?.startedAt ? { startedAt: stored.startedAt } : {}),
      ...(changedAt ? { changedAt } : {}),
      ...(exitCode === undefined ? {} : { exitCode })
    };
  }

  private async stopSession(timeoutSec?: number): Promise<StopResponse> {
    const container = this.ctx.container;
    if (!container || container.running !== true) {
      return { stopped: true };
    }
    const grace = Math.max(0, timeoutSec ?? DEFAULT_STOP_GRACE_SEC) * 1000;
    if (grace > 0 && (await this.signalAndWait(15, grace))) {
      return { stopped: true };
    }
    return { stopped: await this.signalAndWait(9, TERMINATION_TIMEOUT_MS) };
  }

  /**
   * Destroy the container and forget the session.
   *
   * The R2 objects behind any snapshot are not touched: the caller owns the
   * ledger of handles and the same bucket, and deleting from here would mean
   * this object had to keep one too. `removed: false` means the container is
   * still terminating and the call should be repeated.
   */
  private async removeSession(): Promise<RemoveResponse> {
    if (this.isRunning() && !(await this.signalAndWait(9, TERMINATION_TIMEOUT_MS))) {
      return { removed: false };
    }
    await this.ctx.storage.deleteAll();
    return { removed: true };
  }

  /**
   * Signal the container and wait, bounded, for the monitor to agree.
   *
   * SIGKILL surfaces on the monitor as an exit-code rejection, which is still
   * a successful termination once the physical state agrees — the same reason
   * the site never calls the SDK's unbounded `destroy()`.
   */
  private async signalAndWait(
    signal: number,
    timeoutMs: number
  ): Promise<boolean> {
    const container = this.ctx.container;
    if (!container || container.running !== true) {
      return true;
    }
    const monitor = container.monitor();
    container.signal(signal);
    try {
      const settled = await Promise.race([
        monitor.then(() => true),
        scheduler.wait(timeoutMs).then(() => false)
      ]);
      return settled && this.ctx.container?.running !== true;
    } catch {
      return this.ctx.container?.running !== true;
    }
  }

  // --- primitives --------------------------------------------------------

  private async execCommand(request: Request): Promise<ExecResponse> {
    const body = await readJsonBody(request);
    const command = requiredString(body, 'command');
    const cwd = optionalString(body, 'cwd');
    const env = stringMap(body, 'env');
    const timeout = optionalNumber(body, 'timeoutMs');
    this.requireRunning();
    let result;
    try {
      result = await this.exec(command, {
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        ...(timeout ? { timeout } : {})
      });
    } catch (error) {
      if (isExecTimeout(error)) {
        throw new HostRequestError(
          'EXEC_TIMEOUT',
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
    const stdout = capOutput(result.stdout ?? '');
    const stderr = capOutput(result.stderr ?? '');
    return {
      success: result.success,
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      ...(stdout.truncated || stderr.truncated
        ? { truncated: { stdout: stdout.truncated, stderr: stderr.truncated } }
        : {})
    };
  }

  /**
   * Write N files in one round trip: parents first in a single shell command,
   * then the contents, then the modes together. `writeFile` promises nothing
   * about permissions, and OpenSSH refuses a private key other users could
   * read — hence the explicit chmod rather than trusting the umask.
   */
  private async writeBatch(request: Request): Promise<WriteBatchResponse> {
    const files = parseWriteBatch(await readJsonBody(request));
    this.requireRunning();
    const directories = [
      ...new Set(
        files
          .map((file) => parentDirectory(file.path))
          .filter((dir): dir is string => Boolean(dir))
      )
    ];
    if (directories.length > 0) {
      await this.mustExec(
        `mkdir -p ${directories.map(shellQuote).join(' ')}`
      );
    }
    for (const file of files) {
      await this.writeFile(file.path, file.content, {
        encoding: file.encoding
      });
    }
    const modes = files.filter((file) => file.mode);
    if (modes.length > 0) {
      await this.mustExec(
        modes
          .map((file) => `chmod ${file.mode} ${shellQuote(file.path)}`)
          .join(' && ')
      );
    }
    return { written: files.length };
  }

  private async readSessionFile(request: Request): Promise<ReadFileResponse> {
    const path = requiredString(await readJsonBody(request), 'path');
    this.requireRunning();
    const result = await this.readFile(path);
    if (!result.success) {
      throw new HostRequestError('FILE_NOT_FOUND', `No such file: ${path}`);
    }
    return {
      content: result.content,
      encoding: result.encoding === 'base64' ? 'base64' : 'utf-8'
    };
  }

  private async fileExists(request: Request): Promise<ExistsResponse> {
    const path = requiredString(await readJsonBody(request), 'path');
    this.requireRunning();
    const result = await this.exists(path);
    return { exists: result.exists };
  }

  private async listSessionFiles(
    request: Request
  ): Promise<ListFilesResponse> {
    const body = await readJsonBody(request);
    const path = requiredString(body, 'path');
    const includeHidden = optionalBoolean(body, 'includeHidden') ?? true;
    this.requireRunning();
    const result = await this.listFiles(path, { includeHidden });
    if (!result.success) {
      throw new HostRequestError('DIR_NOT_FOUND', `No such directory: ${path}`);
    }
    const files: HostFileInfo[] = result.files.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {})
    }));
    return { files };
  }

  // --- OpenCode ----------------------------------------------------------

  /**
   * Start (or adopt) the OpenCode server.
   *
   * The environment arrives fully derived from the client — this host never
   * sees the stored OpenCode config, only the variables it produced — so the
   * SDK is asked for `env` alone and never for `config`. Reuse is reported
   * because a wake that only restarted the server is not a cold start, and the
   * site's timings say so.
   *
   * Readiness — `GET /path` on the serve port until 200 — is the SDK's, and its
   * budget is the protocol's `OPENCODE_START_TIMEOUT_MS` (180 s).
   */
  private async startOpencode(
    request: Request
  ): Promise<OpencodeStartResponse> {
    const body = await readJsonBody(request);
    const port = optionalNumber(body, 'port') ?? DEFAULT_OPENCODE_PORT;
    const directory = optionalString(body, 'directory');
    const env = stringMap(body, 'env') ?? {};
    this.requireRunning();
    const reused = await this.hasOpencodeProcess(port);
    try {
      await createOpencodeServer(this, {
        port,
        ...(directory ? { directory } : {}),
        env
      });
    } catch (error) {
      throw new HostRequestError(
        'OPENCODE_START_FAILED',
        describeStartupFailure(error)
      );
    }
    await this.ctx.storage.put(OPENCODE_PORT_STORAGE_KEY, port);
    return { started: true, reused };
  }

  private async hasOpencodeProcess(port: number): Promise<boolean> {
    const serve = `opencode serve --port ${port}`;
    try {
      const processes = await this.listProcesses();
      return processes.some(
        (process) =>
          process.command.includes(serve) &&
          (process.status === 'running' || process.status === 'starting')
      );
    } catch {
      // Only the `reused` flag depends on this; a failed listing must not fail
      // the start that follows it.
      return false;
    }
  }

  /**
   * Reverse-proxy to the container's OpenCode port.
   *
   * `getTcpPort(port).fetch` rather than `containerFetch`: the latter starts a
   * stopped container, and a passive UI retry or a reconnecting SSE stream
   * must never be what wakes a session. The response body is returned as it
   * arrives, unbuffered, which is what keeps `/event` streaming.
   */
  private async proxy(
    request: Request,
    url: URL,
    proxyPath: string
  ): Promise<Response> {
    const container = this.ctx.container;
    if (!container || container.running !== true) {
      throw new HostRequestError(
        'CONTAINER_NOT_RUNNING',
        'The session container is not running'
      );
    }
    const port =
      (await this.ctx.storage.get<number>(OPENCODE_PORT_STORAGE_KEY)) ??
      DEFAULT_OPENCODE_PORT;
    const target = proxyTargetUrl(url.toString(), proxyPath, port);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const forwarded = new Request(target, {
      method: request.method,
      headers: forwardedHeaders(request.headers),
      ...(hasBody
        ? ({ body: request.body, duplex: 'half' } as RequestInit)
        : {})
    });
    return await container.getTcpPort(port).fetch(forwarded);
  }

  // --- snapshots ---------------------------------------------------------

  private async snapshot(request: Request): Promise<SnapshotResponse> {
    const body = await readJsonBody(request);
    const dir = requiredString(body, 'dir');
    const name = optionalString(body, 'name');
    const ttl = optionalNumber(body, 'ttlSeconds');
    this.requireRunning();
    // Nothing is left out of the workspace snapshot, and the protocol has no
    // way to ask for it. This once excluded `.opencode-state/cache`, and that
    // one entry silently dropped the whole `.opencode-state` tree from every
    // archive — including `data/opencode/opencode.db`, which is the entire
    // conversation. Every session that slept between 2026-07-26 08:15 UTC and
    // the fix came back to a container that had never heard of it, and answered
    // the next prompt with a 404.
    //
    // The mechanism is here rather than in the caller. `createArchive` expands
    // every exclude into two patterns — the pattern itself and
    // `... <pattern>`, the match-at-any-depth form — and writes both into an
    // `-ef` file. Verified inside `cloudflare/sandbox:0.12.3`, whose mksquashfs
    // is 4.5:
    //
    //   .opencode-state/cache        → drops the cache, correctly
    //   ... .opencode-state/cache    → drops all of .opencode-state
    //
    // So any exclude with a `/` in it takes its parent directory with it. (4.6
    // locally does not, which is what makes this so easy to miss.) Do not add
    // one back without unpacking a real archive afterwards to see what
    // survived: the checkpoint succeeds, the restore succeeds, the handle is
    // stored, and the only symptom arrives one wake later as somebody else's
    // 404. The cache it was saving was 3 MB of a 165 MB archive.
    const backup = await this.createBackup({
      dir,
      ...(name ? { name } : {}),
      ...(ttl ? { ttl } : {}),
      localBucket: this.env.PERSISTENCE_LOCAL_BUCKET === 'true'
    });
    return { handle: backup as unknown as Record<string, unknown> };
  }

  private async restoreSnapshot(
    request: Request
  ): Promise<SnapshotRestoreResponse> {
    const body = await readJsonBody(request);
    const handle = body.handle;
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
      throw new HostRequestError('INVALID_REQUEST', '"handle" is required');
    }
    const result = await this.restoreBackup(handle as DirectoryBackup);
    return { restored: result.success };
  }

  // --- helpers -----------------------------------------------------------

  private isRunning(): boolean {
    return this.ctx.container?.running === true;
  }

  private requireRunning(): void {
    if (!this.isRunning()) {
      throw new HostRequestError(
        'CONTAINER_NOT_RUNNING',
        'The session container is not running'
      );
    }
  }

  /** `exec` that treats a non-zero exit as the failure it is. */
  private async mustExec(command: string): Promise<void> {
    const result = await this.exec(command);
    if (!result.success) {
      throw new Error(
        `Container command failed (${command}): ${capOutput(result.stderr ?? '').text}`
      );
    }
  }
}

/** Per-route reinterpretation of SDK error codes. */
const ROUTE_ERROR_CODES: Partial<
  Record<RouteMatch['route'], Partial<Record<string, 'DIR_NOT_FOUND'>>>
> = {
  list: { FILE_NOT_FOUND: 'DIR_NOT_FOUND' }
};

function describeStartupFailure(error: unknown): string {
  const stderr = (error as { context?: { stderr?: unknown } } | null)?.context
    ?.stderr;
  const message = error instanceof Error ? error.message : String(error);
  const detail = typeof stderr === 'string' && stderr ? ` Stderr: ${stderr}` : '';
  return `${message}${detail}`.slice(0, 4096);
}
