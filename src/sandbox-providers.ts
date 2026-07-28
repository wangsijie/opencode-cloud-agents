/**
 * Which sandbox providers this deployment can actually run a session on.
 *
 * Cloudflare is always available — the site worker ships with its own sandbox
 * host. Docker is opt-in and only counts as available once an operator has
 * stored both halves of the agent's address: the origin to call and the bearer
 * token to call it with. The image is optional; a missing one falls back to
 * `DEFAULT_DOCKER_IMAGE`.
 *
 * Everything that decides "may this session be docker?" — the catalog endpoint
 * the composer reads, the create-session validator — goes through here, so
 * there is one answer to that question.
 */
import type { SessionProvider } from '../protocol/types.ts';
import { DEFAULT_DOCKER_IMAGE, SETTING_KEYS, readSetting } from './settings.ts';

/** What the Docker transport needs to reach the agent. */
export interface DockerProviderConfig {
  /** Origin only, no trailing path — the client appends protocol routes. */
  baseUrl: string;
  token: string;
  image: string;
}

/**
 * The stored Docker configuration, or `undefined` when the provider is not
 * configured. A half-configured provider (URL but no token, or the reverse) is
 * not configured: calling the agent without the bearer would only 401.
 */
export async function readDockerProviderConfig(
  env: Env
): Promise<DockerProviderConfig | undefined> {
  const [baseUrl, token, image] = await Promise.all([
    readSetting<string>(env, SETTING_KEYS.dockerAgentUrl),
    readSetting<string>(env, SETTING_KEYS.dockerAgentToken),
    readSetting<string>(env, SETTING_KEYS.dockerImage)
  ]);
  if (
    typeof baseUrl !== 'string' ||
    baseUrl.trim().length === 0 ||
    typeof token !== 'string' ||
    token.trim().length === 0
  ) {
    return undefined;
  }
  return {
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    token: token.trim(),
    image:
      typeof image === 'string' && image.trim().length > 0
        ? image.trim()
        : DEFAULT_DOCKER_IMAGE
  };
}

export async function isDockerProviderConfigured(env: Env): Promise<boolean> {
  return (await readDockerProviderConfig(env)) !== undefined;
}

/**
 * The providers a new session may be created on, in preference order.
 *
 * Docker leads when configured: the operator stood up a host of their own, so
 * new sessions default there. Cloudflare stays available as the fallback.
 */
export async function listSessionProviders(
  env: Env
): Promise<SessionProvider[]> {
  return (await isDockerProviderConfigured(env))
    ? ['docker', 'cloudflare']
    : ['cloudflare'];
}
