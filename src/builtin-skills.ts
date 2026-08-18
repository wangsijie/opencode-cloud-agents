import { ARTIFACTS_ROOT } from './repos.ts';
import type { SkillSetting } from './settings';

/**
 * Skills every container receives, written by the wake beside the settings
 * skills (`credentialFiles` in container-credentials.ts). They live here
 * rather than in the image because the Cloudflare container wipes /root on
 * every boot — and because a skill edit should be a site deploy, not an image
 * rollout. A settings skill with the same name replaces the built-in, which
 * is the customization escape hatch.
 *
 * The container images carry the binaries these skills call (cloudflared and
 * Playwright in both Dockerfiles); a built-in skill and its binary version
 * move together.
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
  },
  {
    name: 'browse-web',
    content: `---
name: browse-web
description: Drive a real Chromium browser from this container with the preinstalled Playwright — load a page, read the rendered DOM, capture console and network errors, take a screenshot. Use when debugging a web page or a local dev server, when a page's behavior depends on JavaScript, or whenever you would otherwise be guessing at what a page renders. Not for fetching plain documents, which curl does faster.
---

# Browse the web

Playwright and Chromium are preinstalled. Nothing needs installing, and
nothing needs downloading — if you find yourself running
\`npm install playwright\` or \`playwright install\`, stop: the browser is
already here and a download would land in the workspace and be snapshotted.

Reach for this when the answer depends on what a browser *does* with a page:
a dev server you just changed, an app whose content is rendered by JavaScript,
a layout you want to see, an error that only appears in the console. For a
static file or a JSON API, \`curl\` is faster and this is overkill.

## Run it

Write a script and run it with \`node\`. \`playwright\` resolves as a bare
import from any directory, in both module systems, with no \`NODE_PATH\` and
no \`package.json\`:

\`\`\`bash
cat > /tmp/browse.mjs <<'EOF'
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Collect the diagnostics before navigating, or you miss the ones that fire
// during load — which are usually the interesting ones.
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text());
});
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => problems.push('requestfailed: ' + r.url() + ' ' + r.failure()?.errorText));

const response = await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
console.log('status:', response?.status());
console.log('title:', await page.title());
console.log('text:', (await page.locator('body').innerText()).slice(0, 2000));
console.log('problems:', problems);

await page.screenshot({ path: '/tmp/page.png', fullPage: true });
await browser.close();
EOF
node /tmp/browse.mjs
\`\`\`

A repository that has its own Playwright in \`node_modules\` wins over the
global one when the script runs inside that checkout — which is what you want
for its tests, and a version mismatch you should expect if you mix the two.

## Read the screenshot

You can see images. After writing one, open it with your file-reading tool —
a screenshot you never look at has told you nothing.

Where it goes depends on who it is for. A shot you took to see something for
yourself belongs in \`/tmp\`: outside the workspace, so it is neither
snapshotted nor mistaken for a change the user asked for. A shot the *user*
asked for belongs in \`${ARTIFACTS_ROOT}\`, because that is the only place they
can open it — your reply is text and cannot carry the image, and a \`/tmp\`
path is one they cannot reach. Write it there under a descriptive name and say
so. Never leave one in the repository.

For a quick look with no script at all:

\`\`\`bash
playwright screenshot --viewport-size 1280,800 --full-page http://localhost:3000 /tmp/page.png
\`\`\`

## Headless only

The image carries Chromium's headless shell, not the full desktop build. This
is the one limitation worth knowing up front:

- \`chromium.launch()\` — works. This is the default and what you want.
- \`chromium.launch({ headless: false })\` — fails with
  \`Executable doesn't exist\`. There is no display and nobody could watch it;
  do not "fix" this by installing the full browser.
- \`chromium.launch({ channel: 'chrome' })\` — fails the same way. Real Chrome
  is not installed.

Firefox and WebKit are not installed either. If a bug genuinely turns on
engine differences, say so rather than downloading one.

## When a page needs more than a load

- **Wait for what you actually need**, not a timeout:
  \`await page.waitForSelector('[data-loaded]')\` or a \`waitUntil\` on the
  navigation. Sprinkling \`waitForTimeout\` produces flaky, slow scripts.
- **Interact** with \`page.click\`, \`page.fill\`, \`page.selectOption\`; then
  re-read the DOM or take another screenshot to confirm what changed.
- **Evaluate in the page** with \`page.evaluate(() => ...)\` when you need a
  value the DOM does not show, such as computed styles or app state.
- **A trace** (\`context.tracing.start({ screenshots: true, snapshots: true })\`)
  records a whole run to a zip, if a single screenshot is not explaining it.

## Close the browser

Always \`await browser.close()\`, including on the failure path — a leaked
Chromium sits on this container's memory for as long as the session lives.
Wrap the body in \`try\`/\`finally\` for anything longer than the snippet above.

## Reaching a server

\`http://localhost:<port>\` is the normal case: the browser runs in this same
container, so a dev server you started here is directly reachable and needs no
tunnel. Do not open one just to look at a page yourself — \`expose-dev-server\`
is for giving the *user* a URL.

Public sites work too, subject to this network. If a page hangs on
\`networkidle\`, retry with \`waitUntil: 'domcontentloaded'\`: analytics and
long-polling connections keep some pages from ever being idle.
`
  }
];
