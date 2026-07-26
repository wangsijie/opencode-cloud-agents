/**
 * The front door: one admin password, plus same-origin enforcement.
 *
 * The Hub used to sit behind a Cloudflare Access application and trust its JWT.
 * That application is gone, so the Worker asks for the password itself. This is
 * deliberately the smallest thing that closes the door: one operator, one
 * secret, a cookie that says the secret was presented.
 *
 * The SPA shell and its assets stay public — the sign-in form is part of them,
 * and they carry nothing worth reading. Everything under `/api/` is closed.
 */
import { isWebSocketUpgrade, json, methodNotAllowed } from './http';

/**
 * The Hub's one password.
 *
 * Hardcoded on purpose, the same way [opencode-config.ts](opencode-config.ts)
 * carries provider credentials: this is a private repository with a single
 * operator, and a secret in the code is one fewer thing to configure at deploy
 * time. Change it here and redeploy — every signed-in browser is signed out,
 * because the cookie is derived from this string.
 */
const ADMIN_PASSWORD = '9n2r2-5zme8-ozijg-6dxal';

const SESSION_COOKIE = 'hub_admin';

/** A year. One operator signing in weekly would be friction with no payoff. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * What the cookie carries: a hash of the password, never the password.
 *
 * Hashing is also how the password itself is checked, so both comparisons run
 * over fixed-length strings and neither can be probed for length.
 */
async function tokenFor(password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`opencode-hub/v1:${password}`)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Derived once per isolate: every request compares against it. */
let expectedToken: Promise<string> | undefined;
function adminToken(): Promise<string> {
  expectedToken ??= tokenFor(ADMIN_PASSWORD);
  return expectedToken;
}

function equals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

/**
 * `SameSite=Lax` because the Hub is only ever reached by typing its address or
 * following a link, and `Secure` only over HTTPS so `wrangler dev` on
 * `http://localhost` can hold a session too.
 */
function sessionCookie(value: string, url: URL, maxAge: number): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (url.protocol === 'https:') {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

async function isSignedIn(request: Request): Promise<boolean> {
  const presented = readCookie(request, SESSION_COOKIE);
  return presented !== undefined && equals(presented, await adminToken());
}

/**
 * `/api/auth`: the only route that answers without a session.
 *
 * GET reports whether this browser is signed in, so the app can render the form
 * instead of a page full of failed requests. POST takes the password. DELETE
 * signs out.
 */
export async function handleAuthApi(
  request: Request,
  url: URL
): Promise<Response> {
  if (request.method === 'GET') {
    return json({ authenticated: await isSignedIn(request) });
  }

  if (request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
    } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!equals(await tokenFor(password), await adminToken())) {
      return json({ error: 'That is not the password' }, 401);
    }
    return json(
      { authenticated: true },
      200,
      { 'Set-Cookie': sessionCookie(await adminToken(), url, SESSION_MAX_AGE) }
    );
  }

  if (request.method === 'DELETE') {
    return json({ authenticated: false }, 200, {
      'Set-Cookie': sessionCookie('', url, 0)
    });
  }

  return methodNotAllowed('GET, POST, DELETE');
}

/** Close everything else to anyone who has not presented the password. */
export async function requireAdmin(
  request: Request
): Promise<Response | undefined> {
  if (await isSignedIn(request)) {
    return undefined;
  }
  return json({ error: 'Sign in to use the Hub' }, 401);
}

/**
 * A WebSocket upgrade must be same-origin, and so must any non-GET request that
 * sends an Origin header.
 *
 * The session cookie is `SameSite=Lax`, so a cross-site form post never carries
 * it in a current browser; this is the belt to that suspenders, and it is what
 * keeps another page from opening a terminal socket into a container.
 */
export function enforceSameOrigin(
  request: Request,
  url: URL
): Response | undefined {
  if (isWebSocketUpgrade(request)) {
    if (request.headers.get('origin') !== url.origin) {
      return json({ error: 'Cross-origin WebSocket is not allowed' }, 403);
    }
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return json({ error: 'Cross-origin mutation is not allowed' }, 403);
    }
  }
  return undefined;
}
