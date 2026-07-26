/**
 * Stock OpenCode web UI, served as a transitional escape hatch.
 *
 * The stock client assumes "one server, many projects, many sessions", which is
 * the transpose of this Hub's "many containers, one session each". Taming it
 * needs a bootstrap that virtualizes localStorage, a regex patch of its entry
 * bundle, and a path-scoped asset graph — all version-locked and fragile.
 *
 * Per decision D6 the self-built SPA replaces it, and this whole module plus
 * the `/ui/`, `/assets/` and `/gateway/` routes are deleted in M6. Keeping it
 * in one file is what makes that deletion a file removal.
 */
import {
  HttpError,
  decodeRouteSegment,
  isSafeInstanceId,
  isSafeRuntimeEpoch,
  isWebSocketUpgrade,
  json
} from './http';
import {
  lifecycleUnavailableResponse,
  rejectUnlessRuntimeAdmitted,
  requireReadyInstance,
  resolveLifecycle,
  resolveSandbox
} from './instance-access';
import type { Sandbox } from './sandbox';
import {
  OPENCODE_PORT,
  RUNTIME_EPOCH_HEADER
} from './instance-runtime';
import { openCodeRouteRequiresWorkLease } from './opencode-activity';

export const UI_INSTANCE_PARAM = '_hub';
export const UI_RUNTIME_PARAM = '_runtime';
export const UI_COMPAT_VERSION = '4';
export const UI_ASSET_VERSION_SEGMENT = `__hub-v${UI_COMPAT_VERSION}`;

export async function proxyGatewayRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/gateway\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'Gateway route not found');
  }

  const id = decodeRouteSegment(match[1]);
  const runtimeEpoch = decodeRouteSegment(match[2]);
  if (!isSafeRuntimeEpoch(runtimeEpoch)) {
    throw new HttpError(410, 'Runtime epoch is stale');
  }
  const instance = await requireReadyInstance(env, id);
  const lifecycle = resolveLifecycle(env, instance.id);
  const admission = await lifecycle.admit(runtimeEpoch);
  if (!admission.admitted) {
    return lifecycleUnavailableResponse(admission.reason, admission.phase);
  }
  url.pathname = match[3] || '/';
  const rewritten = createContainerRequest(url, request, runtimeEpoch);
  const sandbox = resolveSandbox(env, instance);
  if (isWebSocketUpgrade(request)) {
    return sandbox.wsConnect(rewritten, OPENCODE_PORT);
  }
  const requiresLease = openCodeRouteRequiresWorkLease({
    method: rewritten.method,
    url: rewritten.url
  });
  const lease = requiresLease
    ? await lifecycle.beginWork(runtimeEpoch)
    : undefined;
  if (lease && !lease.admitted) {
    return lifecycleUnavailableResponse(lease.reason, lease.phase);
  }
  try {
    const upstream = await proxyRunningContainerRequest(sandbox, rewritten);
    return rewriteGatewayResponse(
      upstream,
      gatewayPrefix(instance.id, runtimeEpoch),
      new URL(request.url).origin
    );
  } finally {
    if (lease?.admitted) {
      await lifecycle.endWork(runtimeEpoch, lease.leaseId);
    }
  }
}

export async function serveOpencodeUi(
  request: Request,
  env: Env,
  id: string,
  runtimeEpoch: string
): Promise<Response> {
  const instance = await requireReadyInstance(env, id);
  const denied = await rejectUnlessRuntimeAdmitted(
    env,
    instance.id,
    runtimeEpoch
  );
  if (denied) {
    return denied;
  }
  const upstreamUrl = new URL(request.url);
  upstreamUrl.pathname = '/';
  upstreamUrl.search = '';
  upstreamUrl.hash = '';
  const upstream = await proxyRunningContainerRequest(
    resolveSandbox(env, instance),
    createContainerRequest(upstreamUrl, request, runtimeEpoch)
  );

  if (!upstream.ok) {
    return upstream;
  }
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    return upstream;
  }

  const scope = scopedUiPrefix(instance.id, runtimeEpoch);
  const bootstrap = `/hub/bootstrap.js?${UI_INSTANCE_PARAM}=${encodeURIComponent(instance.id)}&${UI_RUNTIME_PARAM}=${encodeURIComponent(runtimeEpoch)}&v=${UI_COMPAT_VERSION}`;
  let html = await upstream.text();
  html = html
    .replaceAll('src="/', `src="${scope}/`)
    .replaceAll("src='/", `src='${scope}/`)
    .replaceAll('href="/', `href="${scope}/`)
    .replaceAll("href='/", `href='${scope}/`)
    .replace(
      '<head>',
      `<head><script src="${bootstrap}"></script>`
    );

  const headers = new Headers(upstream.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.set('Cache-Control', 'no-store');
  return new Response(html, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

export async function proxyScopedUiAsset(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/ui\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) {
    throw new HttpError(404, 'UI asset route not found');
  }
  const instance = await requireReadyInstance(
    env,
    decodeRouteSegment(match[1])
  );
  const runtimeEpoch = decodeRouteSegment(match[2]);
  if (!isSafeRuntimeEpoch(runtimeEpoch)) {
    throw new HttpError(410, 'Runtime epoch is stale');
  }
  const denied = await rejectUnlessRuntimeAdmitted(
    env,
    instance.id,
    runtimeEpoch
  );
  if (denied) {
    return denied;
  }
  const scopedPath = match[3] || '/';
  const versionRoot = `/${UI_ASSET_VERSION_SEGMENT}`;
  url.pathname =
    scopedPath === versionRoot
      ? '/'
      : scopedPath.startsWith(`${versionRoot}/`)
        ? scopedPath.slice(versionRoot.length)
        : scopedPath;
  // v2 used this query parameter to bust the entry bundle cache. That gave
  // the entry module a different URL from the copy imported by lazy chunks,
  // so framework contexts were duplicated. Version the entire asset path
  // instead, keeping every relative ESM import in one module graph.
  url.searchParams.delete('hub-ui');
  const rewritten = createContainerRequest(url, request, runtimeEpoch);
  const upstream = await proxyRunningContainerRequest(
    resolveSandbox(env, instance),
    rewritten
  );
  if (
    upstream.ok &&
    /^\/assets\/index-[^/]+\.js$/.test(url.pathname) &&
    (upstream.headers.get('content-type') ?? '').includes('javascript')
  ) {
    // The stock web build always injects location.origin as a built-in local
    // server. Under a single-domain Hub that creates a second, unscoped server
    // next to the instance gateway and opens a failing event stream at `/`.
    // Keep the persisted, tab-local gateway supplied by our bootstrap as the
    // only server. This small compatibility patch is deliberately limited to
    // the entry bundle and fails open when a future OpenCode build changes.
    const source = await upstream.text();
    const serverPattern =
      /servers:\[[A-Za-z_$][\w$]*\],disableHealthCheck:!0/g;
    const matches = source.match(serverPattern);
    const headers = new Headers(upstream.headers);
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    headers.delete('ETag');
    headers.delete('Last-Modified');
    headers.delete('Content-Digest');
    headers.delete('Digest');
    if (matches?.length !== 1) {
      console.error('OpenCode entry bundle server patch did not match once');
      headers.set('Cache-Control', 'no-store');
      return new Response(
        'throw new Error("OpenCode Hub UI compatibility check failed")',
        { status: 502, headers }
      );
    }
    const patched = source.replace(
      serverPattern,
      'servers:[],disableHealthCheck:!0'
    );
    headers.set('Cache-Control', 'private, max-age=31536000, immutable');
    return new Response(patched, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  }
  if (
    url.pathname === '/site.webmanifest' &&
    upstream.ok &&
    (upstream.headers.get('content-type') ?? '').includes('application/manifest')
  ) {
    const scope = scopedUiPrefix(instance.id, runtimeEpoch);
    const manifest = (await upstream.text())
      .replace('"id": "/"', `"id": "/instances/${encodeURIComponent(instance.id)}"`)
      .replace(
        '"start_url": "/"',
        `"start_url": "/?${UI_INSTANCE_PARAM}=${encodeURIComponent(instance.id)}&${UI_RUNTIME_PARAM}=${encodeURIComponent(runtimeEpoch)}"`
      )
      .replaceAll('"src": "/', `"src": "${scope}/`);
    const headers = new Headers(upstream.headers);
    headers.delete('Content-Length');
    headers.delete('Content-Encoding');
    return new Response(manifest, { status: upstream.status, headers });
  }
  return upstream;
}

export async function proxyGlobalUiAsset(
  request: Request,
  env: Env
): Promise<Response> {
  const context = instanceContextFromReferrer(request.headers.get('referer'));
  if (!context) {
    throw new HttpError(404, 'UI asset has no instance context');
  }
  const instance = await requireReadyInstance(env, context.id);
  const denied = await rejectUnlessRuntimeAdmitted(
    env,
    instance.id,
    context.runtimeEpoch
  );
  if (denied) {
    return denied;
  }
  const response = await proxyRunningContainerRequest(
    resolveSandbox(env, instance),
    createContainerRequest(new URL(request.url), request, context.runtimeEpoch)
  );
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.append('Vary', 'Referer');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function serveUiBootstrap(url: URL): Response {
  const id = url.searchParams.get(UI_INSTANCE_PARAM);
  const runtimeEpoch = url.searchParams.get(UI_RUNTIME_PARAM);
  if (
    !id ||
    !isSafeInstanceId(id) ||
    !runtimeEpoch ||
    !isSafeRuntimeEpoch(runtimeEpoch)
  ) {
    return new Response('Invalid instance id', { status: 400 });
  }

  const encodedId = JSON.stringify(id);
  const encodedParam = JSON.stringify(UI_INSTANCE_PARAM);
  const encodedRuntimeEpoch = JSON.stringify(runtimeEpoch);
  const encodedRuntimeParam = JSON.stringify(UI_RUNTIME_PARAM);
  const source = String.raw`(() => {
  const instanceId = ${encodedId};
  const instanceParam = ${encodedParam};
  const runtimeEpoch = ${encodedRuntimeEpoch};
  const runtimeParam = ${encodedRuntimeParam};
  const gateway = location.origin + "/gateway/" + encodeURIComponent(instanceId) + "/" + encodeURIComponent(runtimeEpoch);
  const defaultServerKey = "opencode.settings.dat:defaultServerUrl";
  const serverStoreKey = "opencode.global.dat:server";
  const physicalDefaultServerKey = "opencode.hub.dat:" + instanceId + ":default-server";
  const physicalServerStoreKey = "opencode.hub.dat:" + instanceId + ":server";

  // OpenCode's web bootstrap accepts a default server key only when that
  // server is also present in its persisted server list. Supply a tab-local
  // view of both values before the deferred main module runs. The override is
  // scoped to this Window, so two Hub instances open in separate tabs cannot
  // change each other's active backend.
  const nativeGetItem = Storage.prototype.getItem;
  const nativeSetItem = Storage.prototype.setItem;
  const nativeRemoveItem = Storage.prototype.removeItem;
  let persisted = null;
  try {
    persisted = nativeGetItem.call(localStorage, physicalServerStoreKey)
      || nativeGetItem.call(localStorage, serverStoreKey);
  } catch {}
  let serverState = { list: [], projects: {}, lastProject: {}, recentlyClosed: {} };
  try {
    const parsed = JSON.parse(persisted || "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      serverState = { ...serverState, ...parsed };
    }
  } catch {}
  const storedUrl = (entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object") return "";
    if (entry.type === "http") return entry.http?.url || "";
    return entry.http?.url || entry.url || "";
  };
  const hubGatewayPrefix = location.origin + "/gateway/";
  const list = Array.isArray(serverState.list)
    ? serverState.list.filter((entry) => {
        const url = storedUrl(entry).replace(/\/$/, "");
        return !url.startsWith(hubGatewayPrefix) && url !== location.origin;
      })
    : [];
  list.push({
    type: "http",
    displayName: "Hub · " + instanceId,
    http: { url: gateway }
  });
  let virtualServerState = JSON.stringify({ ...serverState, list });
  Storage.prototype.getItem = function(key) {
    if (this === localStorage && key === defaultServerKey) return gateway;
    if (this === localStorage && key === serverStoreKey) return virtualServerState;
    return nativeGetItem.call(this, key);
  };
  Storage.prototype.setItem = function(key, value) {
    if (this === localStorage && key === defaultServerKey) {
      return nativeSetItem.call(this, physicalDefaultServerKey, String(value));
    }
    if (this === localStorage && key === serverStoreKey) {
      virtualServerState = String(value);
      return nativeSetItem.call(this, physicalServerStoreKey, virtualServerState);
    }
    return nativeSetItem.call(this, key, value);
  };
  Storage.prototype.removeItem = function(key) {
    if (this === localStorage && key === defaultServerKey) {
      return nativeRemoveItem.call(this, physicalDefaultServerKey);
    }
    if (this === localStorage && key === serverStoreKey) {
      virtualServerState = JSON.stringify({ list: [], projects: {}, lastProject: {}, recentlyClosed: {} });
      return nativeRemoveItem.call(this, physicalServerStoreKey);
    }
    return nativeRemoveItem.call(this, key);
  };

  const preserveInstance = (value) => {
    if (value === undefined || value === null) return value;
    try {
      const next = new URL(String(value), location.href);
      if (next.origin !== location.origin) return value;
      next.searchParams.set(instanceParam, instanceId);
      next.searchParams.set(runtimeParam, runtimeEpoch);
      return next.pathname + next.search + next.hash;
    } catch { return value; }
  };

  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function(state, unused, next) {
    return pushState.call(this, state, unused, preserveInstance(next));
  };
  history.replaceState = function(state, unused, next) {
    return replaceState.call(this, state, unused, preserveInstance(next));
  };

  const current = new URL(location.href);
  if (
    current.searchParams.get(instanceParam) !== instanceId ||
    current.searchParams.get(runtimeParam) !== runtimeEpoch
  ) {
    current.searchParams.set(instanceParam, instanceId);
    current.searchParams.set(runtimeParam, runtimeEpoch);
    replaceState.call(history, history.state, "", current.pathname + current.search + current.hash);
  }

  let sleeping = false;
  const showSleeping = () => {
    if (sleeping) return;
    if (!document.body) {
      addEventListener("DOMContentLoaded", showSleeping, { once: true });
      return;
    }
    sleeping = true;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:#090b0ee8;color:#e7eaf0;font:14px ui-monospace,monospace";
    const panel = document.createElement("div");
    panel.style.cssText = "max-width:440px;padding:28px;border:1px solid #343a45;border-radius:12px;background:#15191f;text-align:center;box-shadow:0 20px 70px #000b";
    const title = document.createElement("strong");
    title.textContent = "实例已休眠";
    title.style.cssText = "display:block;margin-bottom:12px;font-size:18px";
    const detail = document.createElement("div");
    detail.textContent = "任务完成超过 10 分钟，工作区已经备份。请返回 Hub 重新进入以唤醒容器。";
    detail.style.cssText = "color:#aab1bd;line-height:1.6";
    const link = document.createElement("a");
    link.href = "/";
    link.textContent = "返回 Hub";
    link.style.cssText = "display:inline-block;margin-top:20px;border-radius:7px;background:#d6ff53;color:#101408;padding:8px 13px;text-decoration:none;font-weight:700";
    panel.append(title, detail, link);
    overlay.append(panel);
    document.body.append(overlay);
  };

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (response.status === 410 && response.headers.get("X-OpenCode-Hub-State")) {
      showSleeping();
    }
    return response;
  };

  addEventListener("DOMContentLoaded", () => {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Hub";
    back.title = "返回实例管理";
    back.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;border:1px solid #444b55;border-radius:7px;background:#171a1f;color:#d9dde3;padding:6px 10px;font:12px ui-monospace,monospace;cursor:pointer;box-shadow:0 4px 18px #0008";
    back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign("/");
    });
    document.body.append(back);

    const checkRuntime = async () => {
      try {
        const response = await nativeFetch("/api/instances/" + encodeURIComponent(instanceId), { cache: "no-store" });
        if (!response.ok) return;
        const instance = await response.json();
        if (instance?.runtime?.lifecycle === "sleeping" || instance?.runtime?.lifecycle === "stopping") {
          showSleeping();
        }
      } catch {}
    };
    setInterval(checkRuntime, 15000);
  });
})();`;

  return new Response(source, {
    headers: {
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Type': 'text/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function createContainerRequest(
  target: URL,
  request: Request,
  runtimeEpoch?: string
): Request {
  // The public Worker request is HTTPS in production, but a container TCP
  // port only accepts plain HTTP on Cloudflare's already-secure internal
  // transport. Preserve the route/query while replacing the external origin.
  const containerTarget = new URL(target);
  containerTarget.protocol = 'http:';
  containerTarget.hostname = 'localhost';
  containerTarget.port = String(OPENCODE_PORT);
  containerTarget.username = '';
  containerTarget.password = '';
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (
      name.toLowerCase().startsWith('cf-access-') ||
      name.toLowerCase() === 'cf-authorization'
    ) {
      headers.delete(name);
    }
  }
  if (runtimeEpoch) {
    headers.set(RUNTIME_EPOCH_HEADER, runtimeEpoch);
  }

  const cookie = headers.get('cookie');
  if (cookie) {
    const sanitized = cookie
      .split(';')
      .map((part) => part.trim())
      .filter(
        (part) => !part.toLowerCase().startsWith('cf_authorization=')
      )
      .join('; ');
    if (sanitized) {
      headers.set('cookie', sanitized);
    } else {
      headers.delete('cookie');
    }
  }

  return new Request(containerTarget.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal
  });
}

async function proxyRunningContainerRequest(
  sandbox: Sandbox,
  request: Request
): Promise<Response> {
  // Keep streaming Response bodies on the built-in Sandbox RPC path. Returning
  // them through a custom Durable Object RPC method can pin that method for the
  // lifetime of SSE responses and eventually stall unrelated requests.
  return await sandbox.containerFetch(request, OPENCODE_PORT);
}

export function runtimeEntryRequiredResponse(): Response {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>OpenCode 已休眠</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e7eaf0;font:14px ui-monospace,monospace}.panel{max-width:430px;padding:28px;border:1px solid #343a45;border-radius:12px;background:#15191f;text-align:center}a{display:inline-block;margin-top:18px;border-radius:7px;background:#d6ff53;color:#101408;padding:8px 13px;text-decoration:none;font-weight:700}</style><div class="panel"><h1>请从 Hub 进入</h1><p>这个地址没有有效的运行代际，普通页面刷新不会自动唤醒容器。</p><a href="/">返回 Hub</a></div>',
    {
      status: 410,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8'
      }
    }
  );
}






function rewriteGatewayResponse(
  response: Response,
  gatewayPrefix: string,
  publicOrigin: string
): Response {
  const headers = new Headers(response.headers);
  for (const name of ['Location', 'Content-Location']) {
    const value = headers.get(name);
    if (value) {
      headers.set(
        name,
        prefixUpstreamLocation(value, gatewayPrefix, publicOrigin)
      );
    }
  }
  const link = headers.get('Link');
  if (link) {
    headers.set(
      'Link',
      link.replace(/<\/(?!\/)([^>]*)>/g, `<${gatewayPrefix}/$1>`)
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function prefixUpstreamLocation(
  value: string,
  gatewayPrefix: string,
  publicOrigin: string
): string {
  if (value.startsWith('/') && !value.startsWith(`${gatewayPrefix}/`)) {
    return `${gatewayPrefix}${value}`;
  }
  try {
    const location = new URL(value);
    if (
      location.origin === publicOrigin ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1'
    ) {
      return `${publicOrigin}${gatewayPrefix}${location.pathname}${location.search}${location.hash}`;
    }
  } catch {
    // Relative non-root locations remain relative to the gateway request URL.
  }
  return value;
}

function instanceContextFromReferrer(
  referrer: string | null
): { id: string; runtimeEpoch: string } | undefined {
  if (!referrer) {
    return undefined;
  }
  try {
    const url = new URL(referrer);
    const fromQuery = url.searchParams.get(UI_INSTANCE_PARAM);
    const runtimeFromQuery = url.searchParams.get(UI_RUNTIME_PARAM);
    if (
      fromQuery &&
      isSafeInstanceId(fromQuery) &&
      runtimeFromQuery &&
      isSafeRuntimeEpoch(runtimeFromQuery)
    ) {
      return { id: fromQuery, runtimeEpoch: runtimeFromQuery };
    }
    const scoped = /^\/ui\/([^/]+)\/([^/]+)/.exec(url.pathname);
    if (scoped) {
      const id = decodeRouteSegment(scoped[1]);
      const runtimeEpoch = decodeRouteSegment(scoped[2]);
      return isSafeInstanceId(id) && isSafeRuntimeEpoch(runtimeEpoch)
        ? { id, runtimeEpoch }
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function scopedUiPrefix(instanceId: string, runtimeEpoch: string): string {
  return `/ui/${encodeURIComponent(instanceId)}/${encodeURIComponent(runtimeEpoch)}/${UI_ASSET_VERSION_SEGMENT}`;
}

function gatewayPrefix(instanceId: string, runtimeEpoch: string): string {
  return `/gateway/${encodeURIComponent(instanceId)}/${encodeURIComponent(runtimeEpoch)}`;
}

export function isKnownRootUiAsset(pathname: string): boolean {
  return [
    '/favicon-96x96-v3.png',
    '/favicon-v3.svg',
    '/favicon-v3.ico',
    '/apple-touch-icon-v3.png',
    '/site.webmanifest',
    '/social-share.png'
  ].includes(pathname);
}
