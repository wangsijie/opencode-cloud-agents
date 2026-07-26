/**
 * The front door: Cloudflare Access plus same-origin enforcement.
 *
 * Every request carries an Access JWT, except when the Worker runs locally
 * against a local bucket. The JWKS is cached per team domain for the isolate's
 * lifetime because verification happens on every single request.
 *
 * Origin checks run after authentication: a WebSocket upgrade must be
 * same-origin, and so must any non-GET request that sends an Origin header.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { isWebSocketUpgrade } from './http';

const ACCESS_JWKS = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

interface AccessEnv {
  ACCESS_POLICY_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
}

export async function validateHubAccess(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | undefined> {
  const localBypass =
    env.PERSISTENCE_LOCAL_BUCKET === 'true' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]');

  if (!localBypass) {
    const accessEnv = env as Env & AccessEnv;
    const issuer = accessEnv.ACCESS_TEAM_DOMAIN?.replace(/\/$/, '');
    const audience = accessEnv.ACCESS_POLICY_AUD;
    if (!issuer || !audience) {
      return Response.json(
        { error: 'Cloudflare Access is not configured for this Hub' },
        { status: 503 }
      );
    }

    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) {
      return Response.json(
        { error: 'Cloudflare Access authentication is required' },
        { status: 403 }
      );
    }

    try {
      let jwks = ACCESS_JWKS.get(issuer);
      if (!jwks) {
        jwks = createRemoteJWKSet(
          new URL(`${issuer}/cdn-cgi/access/certs`)
        );
        ACCESS_JWKS.set(issuer, jwks);
      }
      await jwtVerify(token, jwks, {
        algorithms: ['RS256'],
        issuer,
        audience
      });
    } catch (error) {
      console.warn('Cloudflare Access JWT validation failed', error);
      return Response.json(
        { error: 'Cloudflare Access token is invalid' },
        { status: 403 }
      );
    }
  }

  if (isWebSocketUpgrade(request)) {
    if (request.headers.get('origin') !== url.origin) {
      return Response.json(
        { error: 'Cross-origin WebSocket is not allowed' },
        { status: 403 }
      );
    }
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return Response.json(
        { error: 'Cross-origin mutation is not allowed' },
        { status: 403 }
      );
    }
  }
  return undefined;
}
