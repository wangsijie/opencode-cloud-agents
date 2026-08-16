/**
 * Which sandbox providers this deployment can actually run a session on.
 *
 * Cloudflare is always available — the site worker ships with its own sandbox
 * host. Docker hosts are the operator's own boxes, stored as a list under
 * `docker.hosts`, and there may be any number of them: each entry becomes one
 * provider, `docker:<id>`. An entry counts only once it carries both halves of
 * the agent's address, the origin to call and the bearer token to call it
 * with; the image and the idle window are optional and fall back to the
 * defaults in [settings.ts](settings.ts).
 *
 * Everything that decides "which host may this session be on?" — the catalog
 * endpoint the composer reads, the create-session validator — goes through
 * here, so there is one answer to that question.
 */
import {
  dockerHostId,
  dockerProvider,
  isDockerProvider,
  type SessionProvider
} from '../protocol/types.ts';
import {
  DEFAULT_DOCKER_IDLE_TIMEOUT_MINUTES,
  DEFAULT_DOCKER_IMAGE,
  SETTING_KEYS,
  readSetting,
  type DockerHostSetting
} from './settings.ts';

/** Matches `LIFECYCLE_IDLE_TIMEOUT_MS` in lifecycle.ts — keep in sync. */
const CLOUDFLARE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** What the Docker transport needs to reach one host, with defaults applied. */
export interface DockerProviderConfig {
  /** The host's id; `provider` is this with the `docker:` prefix. */
  id: string;
  provider: SessionProvider;
  label: string;
  /** Origin only, no trailing path — the client appends protocol routes. */
  baseUrl: string;
  token: string;
  image: string;
  idleTimeoutMinutes: number;
}

/**
 * Every configured Docker host, in stored order — which is the order the
 * composer offers them in, and whose first entry is the default.
 *
 * A half-configured entry (URL but no token, or the reverse) is dropped rather
 * than returned: calling the agent without the bearer would only 401, and an
 * entry that cannot work must not appear in a picker.
 */
export async function listDockerHosts(
  env: Env
): Promise<DockerProviderConfig[]> {
  const stored = await readSetting<DockerHostSetting[]>(
    env,
    SETTING_KEYS.dockerHosts
  );
  if (!Array.isArray(stored)) {
    return [];
  }
  const hosts: DockerProviderConfig[] = [];
  const seen = new Set<string>();
  for (const entry of stored) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    const token = typeof entry?.token === 'string' ? entry.token.trim() : '';
    if (id === '' || baseUrl === '' || token === '' || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const image = typeof entry.image === 'string' ? entry.image.trim() : '';
    const minutes = entry.idleTimeoutMinutes;
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    hosts.push({
      id,
      provider: dockerProvider(id),
      label: label === '' ? id : label,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      token,
      image: image === '' ? DEFAULT_DOCKER_IMAGE : image,
      idleTimeoutMinutes:
        typeof minutes === 'number' &&
        Number.isInteger(minutes) &&
        minutes >= 1 &&
        minutes <= 1440
          ? minutes
          : DEFAULT_DOCKER_IDLE_TIMEOUT_MINUTES
    });
  }
  return hosts;
}

/**
 * The host a provider names, or `undefined` when it names none.
 *
 * Bare `docker` is the provider every session created before multiple hosts
 * carries. It resolves to the first configured host, which on a deployment
 * that had one is the one those sessions have always run on — the migration in
 * `migrations/0009_docker_hosts.sql` puts it there deliberately.
 */
export async function resolveDockerHost(
  env: Env,
  provider: SessionProvider
): Promise<DockerProviderConfig | undefined> {
  if (!isDockerProvider(provider)) {
    return undefined;
  }
  const hosts = await listDockerHosts(env);
  const id = dockerHostId(provider);
  return id === undefined ? hosts[0] : hosts.find((host) => host.id === id);
}

/**
 * The providers a new session may be created on, in preference order.
 *
 * Docker hosts lead when any are configured: the operator stood up boxes of
 * their own, so new sessions default to the first of them. Cloudflare stays
 * available as the fallback, last.
 */
export async function listSessionProviders(
  env: Env
): Promise<SessionProvider[]> {
  const hosts = await listDockerHosts(env);
  return [...hosts.map((host) => host.provider), 'cloudflare'];
}

/** One offer in the composer's host picker: the value and what to call it. */
export interface SessionProviderOption {
  provider: SessionProvider;
  label: string;
}

/**
 * The same list with the names to show. Labels come from settings for Docker
 * hosts, so a deployment with three boxes can call them what its operator
 * calls them rather than "Docker", "Docker" and "Docker".
 */
export async function listSessionProviderOptions(
  env: Env
): Promise<SessionProviderOption[]> {
  const hosts = await listDockerHosts(env);
  return [
    ...hosts.map((host) => ({ provider: host.provider, label: host.label })),
    { provider: 'cloudflare' as const, label: 'Cloudflare' }
  ];
}

/**
 * Idle-stop window for a new instance. Cloudflare keeps the hard-coded ten
 * minutes; a Docker host reads its own `idleTimeoutMinutes` (default 30).
 * Captured once at lifecycle init so a settings edit does not move a live
 * deadline. A provider whose host has since been removed falls back to the
 * default rather than raising: this decides a deadline, not a wake, and the
 * wake is where a missing host is reported.
 */
export async function resolveLifecycleIdleTimeoutMs(
  env: Env,
  provider: SessionProvider
): Promise<number> {
  if (!isDockerProvider(provider)) {
    return CLOUDFLARE_IDLE_TIMEOUT_MS;
  }
  const host = await resolveDockerHost(env, provider);
  return (
    (host?.idleTimeoutMinutes ?? DEFAULT_DOCKER_IDLE_TIMEOUT_MINUTES) * 60 * 1000
  );
}
