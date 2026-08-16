/**
 * Sandbox Host protocol — shared types.
 *
 * The protocol is one HTTP API implemented by every sandbox host:
 *  - the Cloudflare host worker (`host/`), reached over a service binding, and
 *  - the remote Docker agent (`agent/`), reached over public HTTPS + bearer.
 *
 * The site worker holds the only client. Hosts are dumb primitive servers:
 * they run containers, execute commands, move files, and proxy HTTP — they
 * never hold business logic, session state, or credentials beyond one request.
 *
 * See PROTOCOL.md in this directory for the full contract; these types are the
 * source of truth for request/response shapes.
 */

/**
 * Which sandbox host runs a session's container.
 *
 * `cloudflare` is the host worker deployed from this repository — there is
 * exactly one. Docker hosts are the operator's own boxes and there may be
 * several, so a Docker provider names which one: `docker:<hostId>`, the id
 * being the one stored in the `docker.hosts` setting.
 *
 * Bare `docker` is the spelling from before multiple hosts, still written on
 * every session created then. It resolves to the first configured host, which
 * is the one those sessions were created against. New sessions are never
 * stored with it.
 */
export type SessionProvider = 'cloudflare' | 'docker' | `docker:${string}`;

/** Prefix a provider carries when it names one of the operator's Docker hosts. */
export const DOCKER_PROVIDER_PREFIX = 'docker:';

/** Whether this provider runs on a Docker host — either spelling. */
export function isDockerProvider(provider: string): boolean {
  return provider === 'docker' || provider.startsWith(DOCKER_PROVIDER_PREFIX);
}

/**
 * The host id a Docker provider names, or `undefined` for bare `docker` —
 * which names no host in particular and means "the first one configured".
 */
export function dockerHostId(provider: string): string | undefined {
  return provider.startsWith(DOCKER_PROVIDER_PREFIX)
    ? provider.slice(DOCKER_PROVIDER_PREFIX.length)
    : undefined;
}

/** The provider value for one configured Docker host. */
export function dockerProvider(hostId: string): SessionProvider {
  return `${DOCKER_PROVIDER_PREFIX}${hostId}`;
}

/** Session ids must match this before they touch a path segment. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const PROTOCOL_VERSION = 1;

/** Machine-readable error codes carried by every non-2xx JSON body. */
export type HostErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_REQUEST'
  | 'SESSION_NOT_FOUND'
  | 'FILE_NOT_FOUND'
  | 'DIR_NOT_FOUND'
  | 'CONTAINER_NOT_RUNNING'
  | 'EXEC_TIMEOUT'
  | 'OPENCODE_START_FAILED'
  | 'SNAPSHOT_UNSUPPORTED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'HOST_ERROR';

export interface HostErrorBody {
  code: HostErrorCode;
  message: string;
}

/** GET /healthz */
export interface HealthzResponse {
  ok: boolean;
  protocolVersion: number;
  provider: SessionProvider;
  capabilities: HostCapabilities;
  /** Free-form host details (docker version, image presence, …). */
  runtime?: Record<string, string>;
}

export interface HostCapabilities {
  /**
   * Whether the host supports snapshot/restore of the workspace to durable
   * storage. Cloudflare containers are ephemeral, so their host offers
   * snapshots; the Docker host persists workspaces on named volumes and does
   * not.
   */
  snapshots: boolean;
}

/** POST /sessions/:id/ensure */
export interface EnsureRequest {
  /** Container image reference. Hosts with a fixed image ignore it. */
  image?: string;
}

export interface EnsureResponse {
  running: true;
  /** True when this call cold-started the container. */
  created: boolean;
  /**
   * True when the workspace storage backing this session did not exist before
   * this call. On volume-persistent hosts a `true` here after the first wake
   * means the volume was lost and recreated; the orchestrator turns that into
   * a workspace-loss marker. Ephemeral hosts mirror `created`.
   */
  workspaceCreated: boolean;
}

/** GET /sessions/:id */
export interface SessionStateResponse {
  exists: boolean;
  running: boolean;
  startedAt?: string;
  /** Last observed run-state transition, ISO 8601. */
  changedAt?: string;
  exitCode?: number;
}

/** POST /sessions/:id/stop */
export interface StopRequest {
  /** Grace period before the host escalates to SIGKILL. */
  timeoutSec?: number;
}

export interface StopResponse {
  /** False means termination is still pending; the caller retries. */
  stopped: boolean;
}

/** DELETE /sessions/:id */
export interface RemoveResponse {
  /** Idempotent: true even when nothing existed. */
  removed: boolean;
}

/** POST /sessions/:id/exec */
export interface ExecRequest {
  /** Run via `sh -lc`, so a full multi-line script is one round trip. */
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Mirrors the shape site code already consumes from the Cloudflare SDK. */
export interface ExecResponse {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when a stream hit the host's output cap and was cut. */
  truncated?: { stdout: boolean; stderr: boolean };
}

/** Byte cap per output stream before hosts truncate. */
export const EXEC_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export type FileEncoding = 'utf-8' | 'base64';

/** POST /sessions/:id/files/write-batch */
export interface WriteBatchRequest {
  files: HostFileWrite[];
}

export interface HostFileWrite {
  /** Absolute path inside the container. Parent directories are created. */
  path: string;
  content: string;
  /** Defaults to utf-8. */
  encoding?: FileEncoding;
  /** Octal chmod string, e.g. "600". */
  mode?: string;
}

export interface WriteBatchResponse {
  written: number;
}

/** POST /sessions/:id/files/read */
export interface ReadFileRequest {
  path: string;
}

export interface ReadFileResponse {
  content: string;
  /** base64 when the content is not valid UTF-8 text. */
  encoding: FileEncoding;
}

/** POST /sessions/:id/files/exists */
export interface ExistsRequest {
  path: string;
}

export interface ExistsResponse {
  exists: boolean;
}

/** POST /sessions/:id/files/list */
export interface ListFilesRequest {
  path: string;
  /** Include dotfiles. Defaults to true. */
  includeHidden?: boolean;
}

export type HostFileType = 'file' | 'directory' | 'symlink' | 'other';

/** Matches ContainerFileInfo consumed by src/workspace-files.ts. */
export interface HostFileInfo {
  name: string;
  type: HostFileType;
  size: number;
  modifiedAt?: string;
}

export interface ListFilesResponse {
  files: HostFileInfo[];
}

/** POST /sessions/:id/opencode/start */
export interface OpencodeStartRequest {
  port: number;
  /** Working directory the server is launched from (`cd` before serve). */
  directory?: string;
  /**
   * Full environment for the server process. The client derives it
   * (OPENCODE_CONFIG_CONTENT, provider API keys, XDG redirects); hosts pass it
   * through untouched.
   */
  env: Record<string, string>;
}

export interface OpencodeStartResponse {
  started: boolean;
  /** True when a live server on that port was reused instead of spawned. */
  reused: boolean;
}

/** Readiness: poll GET /path on the opencode port until 200, up to this. */
export const OPENCODE_START_TIMEOUT_MS = 180_000;

/**
 * POST /sessions/:id/snapshot — hosts with `capabilities.snapshots` only.
 * The handle is opaque to the protocol: the client stores it and hands it
 * back verbatim. (The Cloudflare host uses the SDK's DirectoryBackup shape.)
 */
export interface SnapshotRequest {
  /** Directory to archive. */
  dir: string;
  name?: string;
  ttlSeconds?: number;
}

export type SnapshotHandle = Record<string, unknown>;

export interface SnapshotResponse {
  handle: SnapshotHandle;
}

/** POST /sessions/:id/snapshot/restore */
export interface SnapshotRestoreRequest {
  handle: SnapshotHandle;
}

export interface SnapshotRestoreResponse {
  restored: boolean;
}
