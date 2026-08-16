/**
 * Host worker support: everything the protocol server needs that is not a
 * container call.
 *
 * Deliberately free of Workers-only globals and of the sandbox SDK, so
 * `node --test` covers the parts that are easy to get quietly wrong — the
 * status mapping, body validation, the proxy URL rewrite, shell quoting and
 * the exec output cap. See [PROTOCOL.md](../protocol/PROTOCOL.md) for the
 * contract these helpers implement.
 */
import {
  EXEC_OUTPUT_LIMIT_BYTES,
  type HostErrorBody,
  type HostErrorCode
} from '../protocol/types.ts';

/** The status each code answers with. Mirrors the table in PROTOCOL.md. */
const ERROR_STATUS: Record<HostErrorCode, number> = {
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
  HOST_ERROR: 500
};

export function hostErrorStatus(code: HostErrorCode): number {
  return ERROR_STATUS[code];
}

/** A protocol error on its way out. Anything else becomes a HOST_ERROR 500. */
export class HostRequestError extends Error {
  readonly code: HostErrorCode;

  constructor(code: HostErrorCode, message: string) {
    super(message);
    this.name = 'HostRequestError';
    this.code = code;
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export function hostErrorResponse(
  code: HostErrorCode,
  message: string
): Response {
  const body: HostErrorBody = { code, message };
  return jsonResponse(body, hostErrorStatus(code));
}

/**
 * Turn a thrown value into a protocol error response.
 *
 * SDK errors carry a `code`; the ones that mean something to the protocol are
 * translated so the client can branch on them instead of parsing messages.
 * `overrides` lets a route add its own mapping — a missing path is
 * `FILE_NOT_FOUND` when reading a file and `DIR_NOT_FOUND` when listing one.
 */
export function errorToResponse(
  error: unknown,
  overrides: Partial<Record<string, HostErrorCode>> = {}
): Response {
  if (error instanceof HostRequestError) {
    return hostErrorResponse(error.code, error.message);
  }
  const code = sdkErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  const mapped = code ? (overrides[code] ?? SDK_ERROR_CODES[code]) : undefined;
  if (mapped) {
    return hostErrorResponse(mapped, message);
  }
  console.error('Sandbox host request failed', error);
  return hostErrorResponse('HOST_ERROR', message);
}

const SDK_ERROR_CODES: Partial<Record<string, HostErrorCode>> = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  NOT_DIRECTORY: 'DIR_NOT_FOUND',
  CONTAINER_UNAVAILABLE: 'CONTAINER_NOT_RUNNING',
  OPENCODE_STARTUP_FAILED: 'OPENCODE_START_FAILED',
  PROCESS_READY_TIMEOUT: 'OPENCODE_START_FAILED',
  PROCESS_EXITED_BEFORE_READY: 'OPENCODE_START_FAILED',
  BACKUP_NOT_FOUND: 'SNAPSHOT_NOT_FOUND',
  BACKUP_EXPIRED: 'SNAPSHOT_NOT_FOUND'
};

export function sdkErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Whether a failed exec failed by running out of time.
 *
 * The SDK reports an exec timeout as a plain abort rather than a distinct
 * error code, so the exec route asks by message. A false negative only costs
 * the client the more generic HOST_ERROR.
 */
export function isExecTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s?out|timeout|aborted/i.test(message);
}

export type JsonBody = Record<string, unknown>;

export async function readJsonBody(request: Request): Promise<JsonBody> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostRequestError('INVALID_REQUEST', 'Body is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HostRequestError('INVALID_REQUEST', 'Body must be a JSON object');
  }
  return parsed as JsonBody;
}

export function requiredString(body: JsonBody, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" is required`);
  }
  return value;
}

export function optionalString(
  body: JsonBody,
  field: string
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" must be a string`);
  }
  return value;
}

export function optionalNumber(
  body: JsonBody,
  field: string
): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HostRequestError('INVALID_REQUEST', `"${field}" must be a number`);
  }
  return value;
}

export function optionalBoolean(
  body: JsonBody,
  field: string
): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new HostRequestError(
      'INVALID_REQUEST',
      `"${field}" must be a boolean`
    );
  }
  return value;
}

export function stringMap(
  body: JsonBody,
  field: string
): Record<string, string> | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new HostRequestError(
      'INVALID_REQUEST',
      `"${field}" must be an object of strings`
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries) {
    if (typeof entry !== 'string') {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"${field}.${key}" must be a string`
      );
    }
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** One entry of a write-batch, validated. */
export interface ParsedFileWrite {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mode?: string;
}

export function parseWriteBatch(body: JsonBody): ParsedFileWrite[] {
  const files = body.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new HostRequestError(
      'INVALID_REQUEST',
      '"files" must be a non-empty array'
    );
  }
  return files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HostRequestError(
        'INVALID_REQUEST',
        'Each file must be an object'
      );
    }
    const file = entry as JsonBody;
    const path = requiredString(file, 'path');
    if (!path.startsWith('/')) {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `File path must be absolute: ${path}`
      );
    }
    const content = file.content;
    if (typeof content !== 'string') {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"content" is required for ${path}`
      );
    }
    const encoding = optionalString(file, 'encoding') ?? 'utf-8';
    if (encoding !== 'utf-8' && encoding !== 'base64') {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `Unsupported encoding for ${path}: ${encoding}`
      );
    }
    const mode = optionalString(file, 'mode');
    if (mode !== undefined && !/^[0-7]{3,4}$/.test(mode)) {
      throw new HostRequestError(
        'INVALID_REQUEST',
        `"mode" must be an octal string for ${path}`
      );
    }
    return { path, content, encoding, ...(mode ? { mode } : {}) };
  });
}

/** Single-quote a value for `sh -c`. Same rule as the site's shellQuote. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The parent directory of an absolute path, or undefined at the root. */
export function parentDirectory(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  if (index <= 0) {
    return undefined;
  }
  return path.slice(0, index);
}

/**
 * Cut one output stream to the protocol's cap.
 *
 * The limit is a transport one, so it is counted in bytes. The head is what
 * survives: in a batched script the first failure is the one that explains
 * everything printed after it.
 */
export function capOutput(text: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= EXEC_OUTPUT_LIMIT_BYTES) {
    return { text, truncated: false };
  }
  const decoder = new TextDecoder('utf-8');
  return {
    text: decoder.decode(bytes.subarray(0, EXEC_OUTPUT_LIMIT_BYTES)),
    truncated: true
  };
}

/**
 * Rewrite `/sessions/:id/proxy/<path>?<query>` into the URL the container
 * sees. The port belongs to the container's OpenCode server; the host name is
 * irrelevant to `getTcpPort().fetch()` but has to be syntactically valid.
 */
export function proxyTargetUrl(
  requestUrl: string,
  proxyPath: string,
  port: number
): string {
  const source = new URL(requestUrl);
  const path = proxyPath.startsWith('/') ? proxyPath : `/${proxyPath}`;
  return `http://container:${port}${path}${source.search}`;
}

/**
 * Headers to forward to the container: everything but the hop-by-hop ones the
 * transport owns. `authorization` is the host's own bearer token — a remote
 * agent would leak it into the container otherwise — and `host` names this
 * worker rather than the container.
 */
export function forwardedHeaders(headers: Headers): Headers {
  const forwarded = new Headers(headers);
  forwarded.delete('authorization');
  forwarded.delete('host');
  return forwarded;
}
