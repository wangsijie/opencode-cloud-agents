/**
 * `opencode-sandbox-host` — the Cloudflare implementation of the Sandbox Host
 * protocol.
 *
 * A second Worker, deployed beside the site, whose only job is to run session
 * containers. The site reaches it over a private service binding; it has no
 * public route, no D1, no settings, and no idea what a Hub session is. One
 * Durable Object per session id, named by that id, so routing is the whole of
 * this file — every operation lives in [host.ts](host.ts).
 *
 * `ContainerProxy` is re-exported because the sandbox SDK creates outbound
 * fetchers that reference it by class name from the Worker's entrypoint.
 */
import { ContainerProxy } from '@cloudflare/sandbox';
import { HEALTHZ_ROUTE, matchSessionRoute } from '../protocol/routes.ts';
import {
  PROTOCOL_VERSION,
  type HealthzResponse
} from '../protocol/types.ts';
import { CloudflareSandboxHost } from './host.ts';
import { hostErrorResponse, jsonResponse } from './support.ts';

export { ContainerProxy, CloudflareSandboxHost };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === HEALTHZ_ROUTE) {
      // No auth: the service binding is the boundary, and this worker is not
      // routable from the internet.
      const body: HealthzResponse = {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        provider: 'cloudflare',
        // R2 through the SDK's backup API. Cloudflare containers are
        // ephemeral, so a session that is not snapshotted is a session lost.
        // Prebuilds are the Docker host's for now; phase 2 of
        // docs/prebuild-design.md brings them here.
        capabilities: { snapshots: true, prebuilds: false }
      };
      return jsonResponse(body);
    }

    const match = matchSessionRoute(request.method, url.pathname);
    if (!match) {
      return hostErrorResponse(
        'INVALID_REQUEST',
        `Unknown route: ${request.method} ${url.pathname}`
      );
    }

    // The session id is the Durable Object name, which is what makes one
    // container per session true by construction rather than by bookkeeping.
    const id = env.SANDBOX_HOST.idFromName(match.sessionId);
    return await env.SANDBOX_HOST.get(id).fetch(request);
  }
} satisfies ExportedHandler<Env>;
