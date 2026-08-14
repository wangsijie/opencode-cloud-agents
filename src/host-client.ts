/**
 * The site's one client for the [Sandbox Host protocol](../protocol/PROTOCOL.md).
 *
 * Every container primitive the Hub needs — start, stop, exec, file I/O, the
 * OpenCode server, the HTTP proxy, snapshots — arrives here as a typed method
 * and leaves as an HTTP request to a host. The transport is what differs per
 * provider: a Cloudflare service binding for `cloudflare` sessions, public
 * HTTPS with a bearer token for `docker` ones. Nothing above this file knows
 * which, and nothing below it knows what a Hub session is.
 *
 * This is also where the OpenCode server environment is derived. Hosts are
 * handed a finished env map and never see the stored config, so the derivation
 * the sandbox SDK used to do inside the container worker is replicated by
 * {@link opencodeServerEnv} — see the "Design grounding" section of
 * PROTOCOL.md, which records it against `@cloudflare/sandbox@0.12.3`.
 */
import {
  sessionRoutes,
  prebuildRoutes,
  HEALTHZ_ROUTE,
  assertSessionId
} from '../protocol/routes.ts';
import {
  OPENCODE_START_TIMEOUT_MS,
  type EnsureRequest,
  type EnsureResponse,
  type ExecRequest,
  type ExecResponse,
  type ExistsResponse,
  type HealthzResponse,
  type HostCapabilities,
  type HostErrorCode,
  type HostFileWrite,
  type ListFilesResponse,
  type OpencodeStartRequest,
  type OpencodeStartResponse,
  type PrebuildDeleteResponse,
  type PrebuildListResponse,
  type PrebuildPromoteRequest,
  type PrebuildPromoteResponse,
  type ReadFileResponse,
  type RemoveResponse,
  type SessionStateResponse,
  type SnapshotHandle,
  type SnapshotRequest,
  type SnapshotResponse,
  type SnapshotRestoreResponse,
  type StopResponse,
  type SessionProvider,
  type WriteBatchResponse,
  dockerHostId,
  isDockerProvider
} from '../protocol/types.ts';
import { RUNTIME_EPOCH_HEADER } from './instance-runtime.ts';
import { resolveDockerHost } from './sandbox-providers.ts';

/**
 * The origin every protocol request is addressed to.
 *
 * A service binding ignores the host name entirely and a remote transport
 * replaces it, so this exists only because `new Request` needs an absolute URL.
 */
const HOST_ORIGIN = 'http://sandbox-host';

/** A protocol error, carrying the machine-readable code the host sent. */
export class HostError extends Error {
  readonly code: HostErrorCode;
  readonly status: number;

  constructor(code: HostErrorCode, message: string, status: number) {
    super(message);
    this.name = 'HostError';
    this.code = code;
    this.status = status;
  }
}

/** True for the one error every caller branches on: the container is down. */
export function isContainerNotRunning(error: unknown): boolean {
  return error instanceof HostError && error.code === 'CONTAINER_NOT_RUNNING';
}

/**
 * How a host is reached. `path` is a protocol route (leading slash); the
 * transport supplies origin and credentials.
 */
export interface HostTransport {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/**
 * The Cloudflare host, over a private service binding.
 *
 * No credentials: the binding is not routable from the internet, so it is
 * itself the authentication boundary (PROTOCOL.md, "Auth").
 */
export function serviceBindingTransport(service: Fetcher): HostTransport {
  return {
    fetch: (path, init) => service.fetch(`${HOST_ORIGIN}${path}`, init)
  };
}

/**
 * A remote host, over public HTTPS with a bearer token.
 *
 * The token goes on every route including `/healthz`; the agent compares it in
 * constant time. `baseUrl` is an origin, so a trailing slash is dropped rather
 * than turned into a doubled one.
 */
export function remoteTransport(
  baseUrl: string,
  token: string
): HostTransport {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    fetch: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return fetch(`${origin}${path}`, { ...init, headers });
    }
  };
}

/**
 * What the protocol calls between two {@link HostClient.resetCallStats} marks
 * cost, in wall clock.
 *
 * `minMs` is the interesting one. Every route here is one request and one
 * response, so the cheapest call observed is the closest thing to a bare round
 * trip that costs nothing extra to measure — an `exists` is a few tens of
 * milliseconds of work on the host and everything else is the wire. Which is
 * the number that decides whether a slow wake is the host being slow or the
 * host being far away, and it is not a question a `/healthz` probe should be
 * added to answer, because the probe would itself be one more round trip.
 */
export interface HostCallStats {
  calls: number;
  totalMs: number;
  /** `undefined` before the first call completes. */
  minMs?: number;
}

/**
 * One session's host, bound to one transport.
 *
 * Every method maps to exactly one protocol route. Failures raise
 * {@link HostError} with the host's own code, so orchestration branches on
 * `CONTAINER_NOT_RUNNING` and `SNAPSHOT_UNSUPPORTED` instead of parsing
 * messages.
 */
export class HostClient {
  readonly sessionId: string;
  private readonly transport: HostTransport;
  private readonly capabilities: HostCapabilities;
  private readonly image: string | undefined;
  private calls = 0;
  private callTotalMs = 0;
  private callMinMs: number | undefined;

  constructor(
    transport: HostTransport,
    sessionId: string,
    capabilities: HostCapabilities,
    /**
     * The image a boot should use. Only hosts that run an operator-chosen image
     * have one; the Cloudflare host's is baked into its own deployment and it
     * ignores the field.
     */
    image?: string
  ) {
    this.transport = transport;
    this.sessionId = assertSessionId(sessionId);
    this.capabilities = capabilities;
    this.image = image;
  }

  /** Whether this host can archive the workspace to durable storage. */
  get supportsSnapshots(): boolean {
    return this.capabilities.snapshots;
  }

  /** Whether this host holds per-repo prebuilds and can seed from them. */
  get supportsPrebuilds(): boolean {
    return this.capabilities.prebuilds;
  }

  /** What the protocol calls since the last reset cost. */
  get callStats(): HostCallStats {
    return {
      calls: this.calls,
      totalMs: this.callTotalMs,
      ...(this.callMinMs === undefined ? {} : { minMs: this.callMinMs })
    };
  }

  /**
   * Start a fresh measurement window.
   *
   * A client is cached across requests, so the window has to be opened by
   * whoever wants to attribute a stretch of work — in practice the wake, which
   * holds the lifecycle mutation lock and is therefore the only thing calling
   * this host while it runs.
   */
  resetCallStats(): void {
    this.calls = 0;
    this.callTotalMs = 0;
    this.callMinMs = undefined;
  }

  healthz(): Promise<HealthzResponse> {
    return this.json<HealthzResponse>('GET', HEALTHZ_ROUTE);
  }

  ensure(body: EnsureRequest = {}): Promise<EnsureResponse> {
    return this.json<EnsureResponse>(
      'POST',
      sessionRoutes.ensure(this.sessionId),
      { ...(this.image ? { image: this.image } : {}), ...body }
    );
  }

  /** Platform truth. Never boots anything, so it is safe on any poll beat. */
  state(): Promise<SessionStateResponse> {
    return this.json<SessionStateResponse>(
      'GET',
      sessionRoutes.state(this.sessionId)
    );
  }

  stop(timeoutSec?: number): Promise<StopResponse> {
    return this.json<StopResponse>(
      'POST',
      sessionRoutes.stop(this.sessionId),
      timeoutSec === undefined ? {} : { timeoutSec }
    );
  }

  remove(): Promise<RemoveResponse> {
    return this.json<RemoveResponse>(
      'DELETE',
      sessionRoutes.remove(this.sessionId)
    );
  }

  exec(command: string, options: Omit<ExecRequest, 'command'> = {}): Promise<ExecResponse> {
    return this.json<ExecResponse>('POST', sessionRoutes.exec(this.sessionId), {
      command,
      ...options
    });
  }

  writeBatch(files: HostFileWrite[]): Promise<WriteBatchResponse> {
    return this.json<WriteBatchResponse>(
      'POST',
      sessionRoutes.writeBatch(this.sessionId),
      { files }
    );
  }

  readFile(path: string): Promise<ReadFileResponse> {
    return this.json<ReadFileResponse>(
      'POST',
      sessionRoutes.readFile(this.sessionId),
      { path }
    );
  }

  exists(path: string): Promise<ExistsResponse> {
    return this.json<ExistsResponse>(
      'POST',
      sessionRoutes.exists(this.sessionId),
      { path }
    );
  }

  listFiles(path: string, includeHidden = true): Promise<ListFilesResponse> {
    return this.json<ListFilesResponse>(
      'POST',
      sessionRoutes.listFiles(this.sessionId),
      { path, includeHidden }
    );
  }

  /**
   * Start (or adopt) the OpenCode server and wait for it to answer.
   *
   * The host's own budget is {@link OPENCODE_START_TIMEOUT_MS}; nothing here
   * races it, because a client-side abort would leave a half-started server
   * the next call would have to reason about.
   */
  opencodeStart(input: OpencodeStartRequest): Promise<OpencodeStartResponse> {
    return this.json<OpencodeStartResponse>(
      'POST',
      sessionRoutes.opencodeStart(this.sessionId),
      input
    );
  }

  snapshot(input: SnapshotRequest): Promise<SnapshotResponse> {
    return this.json<SnapshotResponse>(
      'POST',
      sessionRoutes.snapshot(this.sessionId),
      input
    );
  }

  snapshotRestore(handle: SnapshotHandle): Promise<SnapshotRestoreResponse> {
    return this.json<SnapshotRestoreResponse>(
      'POST',
      sessionRoutes.snapshotRestore(this.sessionId),
      { handle }
    );
  }

  /** Archive this session's stopped workspace as its repo's prebuild. */
  prebuildPromote(
    input: PrebuildPromoteRequest
  ): Promise<PrebuildPromoteResponse> {
    return this.json<PrebuildPromoteResponse>(
      'POST',
      sessionRoutes.prebuildPromote(this.sessionId),
      input
    );
  }

  /** Host-level prebuild inventory. Not session-scoped, but same transport. */
  prebuildList(): Promise<PrebuildListResponse> {
    return this.json<PrebuildListResponse>('GET', prebuildRoutes.list());
  }

  prebuildRemove(repoKey: string): Promise<PrebuildDeleteResponse> {
    return this.json<PrebuildDeleteResponse>(
      'DELETE',
      prebuildRoutes.remove(repoKey)
    );
  }

  /**
   * Forward one request to the container's OpenCode server.
   *
   * The request is addressed to the container as if it were local
   * (`http://localhost:4096/...`); only its path and query survive, appended to
   * the proxy route. The runtime epoch header is the site's own bookkeeping and
   * is stripped here — it gates the call on this side of the protocol and means
   * nothing to a host or to OpenCode.
   *
   * The response is returned as it arrives, unbuffered, which is what keeps
   * `/event` streaming across the binding.
   */
  proxyFetch(request: Request, signal?: AbortSignal): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.delete(RUNTIME_EPOCH_HEADER);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    return this.transport.fetch(
      sessionRoutes.proxy(this.sessionId, `${url.pathname}${url.search}`),
      {
        method: request.method,
        headers,
        ...(signal ? { signal } : {}),
        ...(hasBody
          ? ({ body: request.body, duplex: 'half' } as RequestInit)
          : {})
      }
    );
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    // Measured around the whole exchange, failures included: a call that ends
    // in a `HostError` still spent the round trip, and a window that quietly
    // dropped those would read as faster than the wake actually was.
    const startedAt = Date.now();
    let response: Response;
    let text: string;
    try {
      response = await this.transport.fetch(path, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body)
            })
      });
      text = await response.text();
    } finally {
      this.recordCall(Date.now() - startedAt);
    }
    if (!response.ok) {
      throw hostErrorFrom(response.status, text, `${method} ${path}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HostError(
        'HOST_ERROR',
        `Host answered ${method} ${path} with a non-JSON body`,
        response.status
      );
    }
  }

  private recordCall(durationMs: number): void {
    this.calls += 1;
    this.callTotalMs += durationMs;
    if (this.callMinMs === undefined || durationMs < this.callMinMs) {
      this.callMinMs = durationMs;
    }
  }
}

/**
 * Raised when a session's provider exists but this deployment cannot reach it.
 *
 * Distinct from an unknown provider: the sessions are already on record, so an
 * operator who clears the Docker settings gets a legible failure on every wake
 * rather than a type error.
 */
export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostUnavailableError';
  }
}

/**
 * The host that runs one session's container.
 *
 * `cloudflare` is the service binding to the sandbox host worker, whose
 * capabilities are fixed by its implementation rather than read at request
 * time: it is deployed from this repository in lockstep with this file, and a
 * `/healthz` round trip on every wake would buy nothing. A `docker:<id>`
 * provider is the opposite case — an operator-supplied origin, token and
 * image, all of which can change under a live session, and now one of several
 * hosts — so the entry is read from settings here, and the caller is the one
 * that decides how long to hold the result.
 *
 * Its capabilities are declared, not probed, for the same reason: `snapshots:
 * false` is a property of the Docker design (the workspace lives on a named
 * volume that outlives the container), not something an agent could answer
 * differently.
 */
export async function resolveHostClient(
  env: Env,
  sessionId: string,
  provider: SessionProvider = 'cloudflare'
): Promise<HostClient> {
  if (provider === 'cloudflare') {
    return new HostClient(
      serviceBindingTransport(env.SANDBOX_HOST),
      sessionId,
      { snapshots: true, prebuilds: false }
    );
  }
  if (isDockerProvider(provider)) {
    const host = await resolveDockerHost(env, provider);
    if (!host) {
      // Either no Docker host is configured at all, or this session's host was
      // removed or had its id edited — from here those are the same thing, and
      // both are fixed on the settings page.
      throw new HostUnavailableError(
        `This session runs on Docker sandbox host "${dockerHostId(provider) ?? 'default'}", which is not configured. Add it back on the settings page.`
      );
    }
    return new HostClient(
      remoteTransport(host.baseUrl, host.token),
      sessionId,
      { snapshots: false, prebuilds: true },
      host.image
    );
  }
  throw new Error(`Unsupported sandbox provider: ${String(provider)}`);
}

/**
 * Turn a non-2xx protocol response into a {@link HostError}.
 *
 * A host that answers with something other than the documented
 * `{code, message}` body — a platform error page, a proxy in front of a remote
 * agent — still has to become a typed error, so the status is what decides in
 * that case.
 */
function hostErrorFrom(
  status: number,
  body: string,
  route: string
): HostError {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === 'string') {
      return new HostError(
        parsed.code as HostErrorCode,
        typeof parsed.message === 'string' ? parsed.message : body,
        status
      );
    }
  } catch {
    // Fall through to the status-derived code.
  }
  return new HostError(
    status === 503 ? 'CONTAINER_NOT_RUNNING' : 'HOST_ERROR',
    `Host answered ${route} with HTTP ${status}: ${body.slice(0, 600)}`,
    status
  );
}

/**
 * The environment an OpenCode server is started with, derived from the stored
 * config.
 *
 * The sandbox SDK used to do this inside the worker that owned the container.
 * Hosts are dumb now, so the site derives it and passes a finished map: the
 * whole config as `OPENCODE_CONFIG_CONTENT`, one `<PROVIDER>_API_KEY` per
 * configured provider, and the AI-gateway triple. `extra` is the operator's own
 * variables plus the XDG redirects, merged last so it wins — the same order the
 * SDK used.
 */
export function opencodeServerEnv(
  config: Record<string, unknown>,
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
  };
  const providers = config.provider;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [id, value] of Object.entries(
      providers as Record<string, unknown>
    )) {
      if (id === 'cloudflare-ai-gateway') {
        continue;
      }
      const provider = asRecord(value);
      const apiKey =
        asRecord(provider?.options)?.apiKey ?? provider?.apiKey;
      if (typeof apiKey === 'string') {
        env[`${id.toUpperCase()}_API_KEY`] = apiKey;
      }
    }
    const gateway = asRecord(
      (providers as Record<string, unknown>)['cloudflare-ai-gateway']
    );
    const options = asRecord(gateway?.options);
    if (options) {
      if (typeof options.accountId === 'string') {
        env.CLOUDFLARE_ACCOUNT_ID = options.accountId;
      }
      if (typeof options.gatewayId === 'string') {
        env.CLOUDFLARE_GATEWAY_ID = options.gatewayId;
      }
      if (typeof options.apiToken === 'string') {
        env.CLOUDFLARE_API_TOKEN = options.apiToken;
      }
    }
  }
  return { ...env, ...extra };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
