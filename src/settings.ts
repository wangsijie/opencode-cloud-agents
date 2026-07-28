/**
 * The `settings` table: one JSON value per key.
 *
 * This is the durable home for everything an operator configures at runtime —
 * the admin password record, the GitHub token, the OpenCode config, container
 * credentials — plus the repo catalog cache that was its first tenant. Values
 * are whole JSON documents; nothing queries into them by sub-field.
 */

/** Every key the settings UI and the runtime read. */
export const SETTING_KEYS = {
  adminPassword: 'auth.admin-password',
  githubToken: 'github.token',
  opencodeConfig: 'opencode.config',
  sshKey: 'container.ssh-key',
  containerEnv: 'container.env',
  skills: 'opencode.skills',
  agentsMd: 'opencode.agents-md',
  gitIdentity: 'git.identity',
  dockerAgentUrl: 'docker.agent-url',
  dockerAgentToken: 'docker.agent-token',
  dockerImage: 'docker.image',
  dockerIdleTimeoutMinutes: 'docker.idle-timeout-minutes'
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

/** Stored shape of `auth.admin-password`. Never leaves the Worker. */
export interface PasswordRecord {
  algorithm: 'pbkdf2-sha256';
  iterations: number;
  /** base64 */
  salt: string;
  /** base64 */
  hash: string;
}

/** Stored shape of `container.ssh-key`. The public key is not a secret. */
export interface SshKeySetting {
  privateKey: string;
  publicKey: string;
}

/** Stored shape of `container.env`: variables injected into every container. */
export interface EnvVarSetting {
  name: string;
  value: string;
}

/** Stored shape of one entry in `opencode.skills`. */
export interface SkillSetting {
  name: string;
  content: string;
  /**
   * When set, only containers on this repository receive the skill. The file
   * still lands in the container's global skills directory — a sandbox holds
   * a single checkout, so nothing needs to be written into the repo itself.
   */
  repoKey?: string;
}

/** One entry in `opencode.agents-md.repos`: extra instructions for one repo. */
export interface AgentsMdRepoEntry {
  repoKey: string;
  content: string;
}

/** Stored shape of `opencode.agents-md`: global AGENTS.md plus per-repo additions. */
export interface AgentsMdSetting {
  global?: string;
  repos?: AgentsMdRepoEntry[];
}

/** One entry in `git.identity.overrides`: the identity for one GitHub owner. */
export interface GitIdentityOverride {
  /** GitHub organization (or user) whose repositories use this identity. */
  owner: string;
  name: string;
  email: string;
}

/** Stored shape of `git.identity`. */
export interface GitIdentitySetting {
  name: string;
  email: string;
  /** Per-organization identities that beat the base one, matched on owner. */
  overrides?: GitIdentityOverride[];
}

/**
 * The image the Docker agent runs a session container from when
 * `docker.image` is unset. Built by `agent/session-image/Dockerfile`.
 */
export const DEFAULT_DOCKER_IMAGE = 'opencode-session:latest';

/**
 * How long a Docker session may sit idle before the site stops its container,
 * when `docker.idle-timeout-minutes` is unset. Longer than Cloudflare's ten
 * minutes because a Docker volume survives the stop and a cold start is cheap.
 */
export const DEFAULT_DOCKER_IDLE_TIMEOUT_MINUTES = 30;



export async function readSetting<T>(
  env: Env,
  key: string
): Promise<T | undefined> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?1')
    .bind(key)
    .first<{ value: string }>();
  if (!row) {
    return undefined;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

/** The raw row, for callers that need `updatedAt` alongside the value. */
export async function readSettingRow(
  env: Env,
  key: string
): Promise<{ value: string; updatedAt: string } | undefined> {
  const row = await env.DB.prepare(
    'SELECT value, updated_at FROM settings WHERE key = ?1'
  )
    .bind(key)
    .first<{ value: string; updated_at: string }>();
  return row ? { value: row.value, updatedAt: row.updated_at } : undefined;
}

export async function writeSetting(
  env: Env,
  key: string,
  value: unknown
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

export async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(key).run();
}
