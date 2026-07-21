/**
 * OpenCode execution activity protocol.
 *
 * OpenCode 1.18 exposes two independent execution engines. Legacy sessions
 * report per-location `busy` / `retry` state from `/session/status`; v2 reports
 * process-wide foreground drains from `/api/session/active`. Neither browser
 * event streams nor ordinary HTTP traffic are execution activity.
 *
 * This module deliberately keeps the policy independent from the Sandbox
 * lifecycle. In particular, callers must check that the container is already
 * running before querying these endpoints so an activity probe cannot wake a
 * stopped container.
 */

export const LEGACY_SESSION_STATUS_PATH = '/session/status';
export const V2_ACTIVE_SESSION_PATH = '/api/session/active';
export const GLOBAL_SESSION_LIST_PATH = '/experimental/session';

export type OpenCodeActivityState = 'active' | 'idle' | 'unknown';

export interface OpenCodeLocation {
  directory: string;
  workspace?: string;
}

export interface OpenCodeLocationInput {
  directory?: string | null;
  workspace?: string | null;
}

export interface ActivityClassification {
  state: OpenCodeActivityState;
  activeSessionIds: string[];
  reason?: string;
}

export interface LegacyLocationActivity extends ActivityClassification {
  location: OpenCodeLocation;
}

export interface OpenCodeActivitySnapshot extends ActivityClassification {
  /** Unix timestamp in milliseconds at which this observation completed. */
  observedAt: number;
  legacy: LegacyLocationActivity[];
  v2: ActivityClassification;
}

export type LegacySessionExecutionState =
  | 'busy'
  | 'retry'
  | 'idle'
  | 'unknown';

export type OpenCodeActivityFetcher = (request: Request) => Promise<Response>;

export interface QueryOpenCodeActivityOptions {
  fetcher: OpenCodeActivityFetcher;
  baseUrl: string | URL;
  locations: Iterable<OpenCodeLocationInput>;
  signal?: AbortSignal;
  /** Test hook; production callers normally leave this undefined. */
  observedAt?: number;
}

export interface OpenCodeRouteLike {
  method: string;
  url: string | URL;
}

const URL_PARSE_BASE = 'http://opencode.invalid';

/**
 * Canonicalize one Linux container location. Invalid or relative directories
 * are rejected instead of being silently attributed to the default project.
 */
export function normalizeOpenCodeLocation(
  input: OpenCodeLocationInput
): OpenCodeLocation | undefined {
  if (typeof input.directory !== 'string') {
    return undefined;
  }
  const directory = normalizeAbsolutePosixPath(input.directory.trim());
  if (!directory) {
    return undefined;
  }

  const workspace =
    typeof input.workspace === 'string' && input.workspace.trim().length > 0
      ? input.workspace.trim()
      : undefined;
  return {
    directory,
    ...(workspace ? { workspace } : {})
  };
}

/** Preserve first-seen order while removing invalid and duplicate locations. */
export function normalizeKnownOpenCodeLocations(
  inputs: Iterable<OpenCodeLocationInput>
): OpenCodeLocation[] {
  const locations = new Map<string, OpenCodeLocation>();
  for (const input of inputs) {
    const location = normalizeOpenCodeLocation(input);
    if (location) {
      locations.set(openCodeLocationKey(location), location);
    }
  }
  return [...locations.values()];
}

export function openCodeLocationKey(location: OpenCodeLocation): string {
  return JSON.stringify([location.directory, location.workspace ?? null]);
}

/** Extract location identities from OpenCode's process-wide session listing. */
export function openCodeLocationsFromGlobalSessions(
  value: unknown
): OpenCodeLocation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return normalizeKnownOpenCodeLocations(
    value.flatMap((session): OpenCodeLocationInput[] => {
      if (!isRecord(session) || typeof session.directory !== 'string') {
        return [];
      }
      return [
        {
          directory: session.directory,
          workspace:
            typeof session.workspaceID === 'string'
              ? session.workspaceID
              : undefined
        }
      ];
    })
  );
}

/**
 * Read OpenCode's location query parameters from either a rewritten upstream
 * URL or the original `/gateway/<instance>/<runtime-epoch>/...` URL.
 */
export function extractOpenCodeLocation(
  input: string | URL | Request,
  defaultDirectory: string
): OpenCodeLocation | undefined {
  const url =
    input instanceof Request
      ? new URL(input.url)
      : input instanceof URL
        ? input
        : new URL(input, URL_PARSE_BASE);
  const requestedDirectory = url.searchParams.get('directory');
  const directory =
    requestedDirectory && requestedDirectory.trim().length > 0
      ? requestedDirectory
      : defaultDirectory;
  return normalizeOpenCodeLocation({
    directory,
    workspace: url.searchParams.get('workspace')
  });
}

export function classifyLegacySessionStatus(
  value: unknown
): LegacySessionExecutionState {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return 'unknown';
  }
  switch (value.type) {
    case 'busy':
    case 'retry':
    case 'idle':
      return value.type;
    default:
      return 'unknown';
  }
}

/** Classify the direct JSON body returned by legacy `/session/status`. */
export function classifyLegacySessionStatuses(
  value: unknown
): ActivityClassification {
  if (!isRecord(value)) {
    return unknownActivity('Legacy session status response is not an object');
  }

  const activeSessionIds: string[] = [];
  const unknownSessionIds: string[] = [];
  for (const [sessionId, status] of Object.entries(value)) {
    const state = classifyLegacySessionStatus(status);
    if (state === 'busy' || state === 'retry') {
      activeSessionIds.push(sessionId);
    } else if (state === 'unknown') {
      unknownSessionIds.push(sessionId);
    }
  }

  activeSessionIds.sort();
  if (activeSessionIds.length > 0) {
    return {
      state: 'active',
      activeSessionIds,
      ...(unknownSessionIds.length > 0
        ? {
            reason: `Unrecognized legacy status for: ${unknownSessionIds.sort().join(', ')}`
          }
        : {})
    };
  }
  if (unknownSessionIds.length > 0) {
    return unknownActivity(
      `Unrecognized legacy status for: ${unknownSessionIds.sort().join(', ')}`
    );
  }
  return idleActivity();
}

/** Classify the direct JSON body returned by v2 `/api/session/active`. */
export function classifyV2ActiveSessions(
  value: unknown
): ActivityClassification {
  if (!isRecord(value) || !isRecord(value.data)) {
    return unknownActivity('V2 active session response has no data map');
  }
  // The endpoint contract defines presence in this map as active. Do not turn
  // an unfamiliar value shape into a false idle result during a version skew.
  const activeSessionIds = Object.keys(value.data).sort();
  return activeSessionIds.length > 0
    ? { state: 'active', activeSessionIds }
    : idleActivity();
}

/**
 * Conservative aggregation used by shutdown policy:
 * active beats unknown, and unknown beats idle.
 */
export function aggregateActivityClassifications(
  classifications: Iterable<ActivityClassification>
): ActivityClassification {
  const values = [...classifications];
  if (values.length === 0) {
    return unknownActivity('No OpenCode activity sources were observed');
  }

  const activeSessionIds = [
    ...new Set(
      values.flatMap((value) =>
        value.state === 'active' ? value.activeSessionIds : []
      )
    )
  ].sort();
  if (activeSessionIds.length > 0) {
    return { state: 'active', activeSessionIds };
  }

  const unknownReasons = values
    .filter((value) => value.state === 'unknown')
    .map((value) => value.reason ?? 'Unknown OpenCode activity')
    .filter((reason, index, reasons) => reasons.indexOf(reason) === index);
  if (unknownReasons.length > 0) {
    return unknownActivity(unknownReasons.join('; '));
  }
  return idleActivity();
}

/**
 * Query every known legacy location plus the process-wide v2 execution set.
 * A missing legacy location set is unknown, never idle.
 */
export async function queryOpenCodeActivity(
  options: QueryOpenCodeActivityOptions
): Promise<OpenCodeActivitySnapshot> {
  const baseUrl = new URL(options.baseUrl);
  const locations = normalizeKnownOpenCodeLocations(options.locations);

  const [legacy, v2] = await Promise.all([
    Promise.all(
      locations.map(async (location): Promise<LegacyLocationActivity> => {
        const url = new URL(LEGACY_SESSION_STATUS_PATH, baseUrl);
        url.searchParams.set('directory', location.directory);
        if (location.workspace) {
          url.searchParams.set('workspace', location.workspace);
        }
        const classification = await queryJsonActivity(
          options.fetcher,
          url,
          classifyLegacySessionStatuses,
          options.signal
        );
        return { location, ...classification };
      })
    ),
    queryJsonActivity(
      options.fetcher,
      new URL(V2_ACTIVE_SESSION_PATH, baseUrl),
      classifyV2ActiveSessions,
      options.signal
    )
  ]);

  const aggregate = aggregateActivityClassifications([
    ...(legacy.length > 0
      ? legacy
      : [unknownActivity('No known legacy OpenCode locations')]),
    v2
  ]);
  return {
    ...aggregate,
    observedAt: options.observedAt ?? Date.now(),
    legacy,
    v2
  };
}

/**
 * True only for OpenCode requests that may start or resume agent work. Passive
 * browser traffic, SSE, status probes, abort/interrupt, and wait requests do
 * not need a work lease.
 */
export function openCodeRouteRequiresWorkLease(
  request: OpenCodeRouteLike
): boolean {
  if (request.method.toUpperCase() !== 'POST') {
    return false;
  }
  const url =
    request.url instanceof URL
      ? request.url
      : new URL(request.url, URL_PARSE_BASE);
  const path = stripGatewayPrefix(url.pathname).replace(/\/+$/, '') || '/';

  return (
    /^\/session\/[^/]+\/(?:message|prompt_async|command|shell|init|summarize)$/.test(
      path
    ) ||
    /^\/session\/[^/]+\/(?:fork|abort|revert|unrevert)$/.test(path) ||
    /^\/session\/[^/]+\/permissions\/[^/]+$/.test(path) ||
    /^\/question\/[^/]+\/(?:reply|reject)$/.test(path) ||
    /^\/permission\/[^/]+\/reply$/.test(path) ||
    /^\/api\/session\/[^/]+\/(?:prompt|compact|wait|interrupt)$/.test(path) ||
    /^\/api\/session\/[^/]+\/revert\/(?:stage|clear|commit)$/.test(path) ||
    /^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path) ||
    /^\/api\/session\/[^/]+\/question\/[^/]+\/(?:reply|reject)$/.test(
      path
    )
  );
}

async function queryJsonActivity(
  fetcher: OpenCodeActivityFetcher,
  url: URL,
  classify: (value: unknown) => ActivityClassification,
  signal?: AbortSignal
): Promise<ActivityClassification> {
  try {
    const response = await fetcher(
      new Request(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal
      })
    );
    if (!response.ok) {
      return unknownActivity(
        `${url.pathname} returned HTTP ${response.status}`
      );
    }
    return classify(await response.json());
  } catch (error) {
    return unknownActivity(
      `${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function normalizeAbsolutePosixPath(value: string): string | undefined {
  if (!value.startsWith('/')) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join('/')}`;
}

function stripGatewayPrefix(pathname: string): string {
  const match = /^\/gateway\/[^/]+\/[^/]+(\/.*)?$/.exec(pathname);
  return match ? match[1] || '/' : pathname;
}

function idleActivity(): ActivityClassification {
  return { state: 'idle', activeSessionIds: [] };
}

function unknownActivity(reason: string): ActivityClassification {
  return { state: 'unknown', activeSessionIds: [], reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
