import type { SkillSetting } from './settings';

/**
 * Skills every container receives, written by the wake beside the settings
 * skills (`credentialFiles` in container-credentials.ts). They live here
 * rather than in the image because the Cloudflare container wipes /root on
 * every boot — and because a skill edit should be a site deploy, not an image
 * rollout. A settings skill with the same name replaces the built-in, which
 * is the customization escape hatch.
 *
 * The container images carry the binaries these skills call (cloudflared in
 * both Dockerfiles); a built-in skill and its binary version move together.
 */
export const BUILTIN_SKILLS: SkillSetting[] = [
  {
    name: 'expose-dev-server',
    content: `---
name: expose-dev-server
description: Give the user a public HTTPS URL for an HTTP server running in this container, via a Cloudflare quick tunnel. Use only when the user explicitly asks for a public, external, or phone-reachable URL. Never open a tunnel on your own initiative.
---

# Expose a dev server

\`cloudflared\` is preinstalled. A quick tunnel maps a random public
\`https://….trycloudflare.com\` URL onto a local port. The URL is public and
unauthenticated — the random subdomain is its only protection — which is why
this is strictly manual: only when the user has explicitly asked for an
external URL, never merely because a dev server is running.

## Start

Always pass \`--protocol http2\`. QUIC (cloudflared's default) is blocked on
this network, and the failure is silent in a misleading way: startup prints
\`SUMMARY: Environment ready with degraded transport … will proceed using
'http2'\`, then cloudflared dials QUIC anyway and every request comes back
530. The self-check's conclusion does not match its behavior, so do not rely
on an automatic fallback.

With the server listening on, say, port 3000:

\`\`\`bash
nohup cloudflared tunnel --protocol http2 --url http://localhost:3000 >/tmp/cloudflared-3000.log 2>&1 &
\`\`\`

The URL appears in the log banner within a few seconds:

\`\`\`bash
sleep 3 && grep -o 'https://[a-z0-9-]*\\.trycloudflare\\.com' /tmp/cloudflared-3000.log | head -1
\`\`\`

If grep prints nothing, wait a moment and run it again.

## Verify before reporting

The banner prints the URL even when the tunnel cannot carry traffic. A
printed URL is not a working URL — curl it yourself first:

\`\`\`bash
curl -sS -o /dev/null -w '%{http_code}\\n' https://<subdomain>.trycloudflare.com
\`\`\`

530 means the tunnel is up on Cloudflare's side but has no working edge
connection — almost always the QUIC problem above; kill it and restart with
\`--protocol http2\`. 502/504 means the tunnel works and the local server does
not. Only once you get the status the local server actually returns should
you report the URL to the user, verbatim, with the caveats below.

## The visitor is not on localhost

Through the tunnel the browser's origin is \`https://….trycloudflare.com\`,
not \`http://localhost:<port>\`. Before reporting the URL, check for what that
breaks — and prefer the smallest edit, clearly marked or reverted once the
tunnel closes:

- **Host allow-list.** Vite rejects requests for hosts it does not know: add
  the tunnel hostname to \`server.allowedHosts\` in the dev config (or set it
  to \`true\` while debugging).
- **Frontend and backend on different ports.** One tunnel maps one port.
  Either route the API through the frontend dev server's own proxy so a
  single tunnel serves both same-origin, or open a second tunnel for the
  backend (its own log file and its own \`--protocol http2\`) and point the
  frontend's API base URL at it. Two tunnels is a normal choice, not a
  fallback: it needs no proxy config, and a dev/test server that echoes the
  request origin back in \`Access-Control-Allow-Origin\` makes CORS work with
  no configuration at all. Check that echo before assuming CORS is free.
- OAuth callbacks and cookie domains registered for localhost will not work
  through the tunnel — say so rather than chasing them.

## Stop

\`\`\`bash
pkill cloudflared
\`\`\`

That kills every tunnel; a single one can be stopped by the port instead:
\`pkill -f 'tunnel --url http://localhost:3000'\`.

Stop the tunnel when the debugging it was opened for is over, or whenever the
user asks.

## Tell the user

- The URL is public: anyone who has it reaches the server, with no
  authentication in front.
- The tunnel dies when this container sleeps, and a reopened tunnel gets a
  different URL.
`
  }
];
