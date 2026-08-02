/**
 * The front door: one admin password, plus same-origin enforcement.
 *
 * The password lives in the `settings` table as a salted PBKDF2 record — set
 * on first run through `/api/setup`, changed from the settings page. A
 * successful sign-in issues a random token whose hash is a row in
 * `admin_sessions`; the cookie carries the raw token, so the database alone
 * grants nothing, and revoking a browser is deleting its row.
 *
 * The SPA shell and its assets stay public — the sign-in form is part of them,
 * and they carry nothing worth reading. Everything under `/api/` is closed.
 */
import { isWebSocketUpgrade, json, methodNotAllowed } from './http';
import {
  generateSessionToken,
  hashPassword,
  hashToken,
  verifyPassword
} from './password';
import { SETTING_KEYS, readSetting, writeSetting } from './settings';
import type { PasswordRecord } from './settings';

const SESSION_COOKIE = 'hub_admin';

/** A year. One operator signing in weekly would be friction with no payoff. */
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

export const MIN_PASSWORD_LENGTH = 8;

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

async function readPasswordRecord(env: Env): Promise<PasswordRecord | undefined> {
  return readSetting<PasswordRecord>(env, SETTING_KEYS.adminPassword);
}

/**
 * Issue a browser session: one row in `admin_sessions`, the raw token in the
 * cookie. Expired rows are swept here rather than on a schedule — sign-in is
 * rare enough that the sweep is free, and the expiry check on every read means
 * a stale row was never a live session anyway.
 */
export async function createAdminSession(
  env: Env,
  url: URL
): Promise<{ cookie: string }> {
  const token = generateSessionToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_MAX_AGE * 1000);
  await env.DB.prepare(
    'DELETE FROM admin_sessions WHERE expires_at < ?1'
  )
    .bind(now.toISOString())
    .run();
  await env.DB.prepare(
    `INSERT INTO admin_sessions (token_hash, created_at, expires_at)
     VALUES (?1, ?2, ?3)`
  )
    .bind(await hashToken(token), now.toISOString(), expires.toISOString())
    .run();
  return { cookie: sessionCookie(token, url, SESSION_MAX_AGE) };
}

async function isSignedIn(request: Request, env: Env): Promise<boolean> {
  const presented = readCookie(request, SESSION_COOKIE);
  if (!presented) {
    return false;
  }
  const row = await env.DB.prepare(
    'SELECT 1 AS live FROM admin_sessions WHERE token_hash = ?1 AND expires_at > ?2'
  )
    .bind(await hashToken(presented), new Date().toISOString())
    .first<{ live: number }>();
  return row !== null;
}

/**
 * `/api/auth`: answers without a session.
 *
 * GET reports whether this browser is signed in and whether a password exists
 * at all, so the app can render the sign-in form — or the first-run setup —
 * instead of a page full of failed requests. POST takes the password. DELETE
 * signs out this browser.
 */
export async function handleAuthApi(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (request.method === 'GET') {
    const [authenticated, record] = await Promise.all([
      isSignedIn(request, env),
      readPasswordRecord(env)
    ]);
    return json({ authenticated, passwordConfigured: record !== undefined });
  }

  if (request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as {
      password?: unknown;
    } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    const record = await readPasswordRecord(env);
    if (!record) {
      return json({ error: 'No password is set yet — complete setup first' }, 409);
    }
    if (!(await verifyPassword(record, password))) {
      return json({ error: 'That is not the password' }, 401);
    }
    const session = await createAdminSession(env, url);
    return json({ authenticated: true }, 200, { 'Set-Cookie': session.cookie });
  }

  if (request.method === 'DELETE') {
    const presented = readCookie(request, SESSION_COOKIE);
    if (presented) {
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?1')
        .bind(await hashToken(presented))
        .run();
    }
    return json({ authenticated: false }, 200, {
      'Set-Cookie': sessionCookie('', url, 0)
    });
  }

  return methodNotAllowed('GET, POST, DELETE');
}

/**
 * `/api/setup`: sets the very first password, and only the first.
 *
 * Once a record exists the route answers 409 forever — changing the password
 * is `/api/settings/password`, which demands the current one. Setting the
 * password signs the browser in: making somebody type the password they chose
 * two seconds ago proves nothing.
 */
export async function handleSetupApi(
  request: Request,
  url: URL,
  env: Env
): Promise<Response> {
  if (request.method !== 'POST') {
    return methodNotAllowed('POST');
  }
  const body = (await request.json().catch(() => null)) as {
    password?: unknown;
  } | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json(
      { error: `The password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }
  if (await readPasswordRecord(env)) {
    return json({ error: 'A password is already set' }, 409);
  }
  await writeSetting(env, SETTING_KEYS.adminPassword, await hashPassword(password));
  const session = await createAdminSession(env, url);
  return json({ authenticated: true }, 200, { 'Set-Cookie': session.cookie });
}

/** Close everything else to anyone who has not presented the password. */
export async function requireAdmin(
  request: Request,
  env: Env
): Promise<Response | undefined> {
  if (await isSignedIn(request, env)) {
    return undefined;
  }
  return json({ error: 'Sign in to use the Hub' }, 401);
}

/**
 * A WebSocket upgrade must be same-origin, and so must any non-GET request that
 * sends an Origin header.
 *
 * The session cookie is `SameSite=Lax`, so a cross-site form post never carries
 * it in a current browser; this is the belt to that suspenders. No route
 * upgrades a WebSocket today — the terminal that did is gone — but the check
 * stays: it is the rule, not a fixture of whichever routes currently exist.
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
