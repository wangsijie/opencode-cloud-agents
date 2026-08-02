/**
 * Router-level HTTP primitives shared by every request handler.
 *
 * Nothing here knows about instances, sessions or containers: these are the
 * response shapes and the route-segment validators the Worker applies before
 * any of that logic runs.
 */

/**
 * An error carrying the status the router should answer with.
 *
 * `status` is declared as a plain field rather than a constructor parameter
 * property because the tests run this file through Node's type stripping,
 * which refuses parameter properties.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

export function methodNotAllowed(allowedMethods: string): Response {
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { Allow: allowedMethods }
  });
}

export function decodeRouteSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, 'Malformed route');
  }
}

export function isSafeInstanceId(value: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function isSafeRuntimeEpoch(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function acceptsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

export function isWebSocketUpgrade(request: Request): boolean {
  return (
    request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
    (request.headers.get('connection') ?? '')
      .toLowerCase()
      .split(',')
      .some((value) => value.trim() === 'upgrade')
  );
}

/**
 * Strip the Hub's own front-door credentials from a request being forwarded
 * into a container. Front-door identity ends at the Worker: nothing inside the
 * sandbox needs it, and forwarding it would hand a session's shell a token for
 * the Hub itself. The `cf-access-*` entries are vestigial — the Worker no
 * longer sits behind Cloudflare Access — and cost nothing to keep stripping.
 */
const FORWARD_BLOCKED_COOKIES = ['cf_authorization=', 'hub_admin='];

export function stripAccessCredentials(headers: Headers): Headers {
  for (const name of [...headers.keys()]) {
    const lower = name.toLowerCase();
    if (lower.startsWith('cf-access-') || lower === 'cf-authorization') {
      headers.delete(name);
    }
  }
  const cookie = headers.get('cookie');
  if (cookie) {
    const sanitized = cookie
      .split(';')
      .map((part) => part.trim())
      .filter(
        (part) =>
          !FORWARD_BLOCKED_COOKIES.some((blocked) =>
            part.toLowerCase().startsWith(blocked)
          )
      )
      .join('; ');
    if (sanitized) {
      headers.set('cookie', sanitized);
    } else {
      headers.delete('cookie');
    }
  }
  return headers;
}

export function truncateOutput(value: string, limit = 600): string {
  const collapsed = value.trim();
  return collapsed.length > limit
    ? `${collapsed.slice(0, limit)}…`
    : collapsed;
}
