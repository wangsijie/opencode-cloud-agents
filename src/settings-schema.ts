/**
 * What each setting is, and what a value must look like to be stored.
 *
 * This module is pure — no `env`, no D1 — so the validation rules that keep a
 * bad value out of the database are unit-testable on their own. The API layer
 * ([api-settings.ts](api-settings.ts)) consults the descriptor registry for
 * everything shape-related and adds only the checks that need the database
 * (models still pinned by sessions).
 */
import type { Config } from '@opencode-ai/sdk/v2';
import { isSafeRepoKey } from './repos.ts';
import { DEFAULT_DOCKER_IMAGE, SETTING_KEYS } from './settings.ts';
import type {
  AgentsMdSetting,
  EnvVarSetting,
  GitIdentitySetting,
  SkillSetting,
  SshKeySetting
} from './settings.ts';

/**
 * Every permission OpenCode knows about has to be decided in the config.
 *
 * There is no operator to answer a prompt: an unset permission evaluates to
 * `ask`, and an ask parks the tool call forever with the session stuck
 * `working`. `task` is the subagent spawn — an ask there parks the parent
 * while the child session it would have started never exists.
 */
export const REQUIRED_PERMISSION_KEYS = [
  'edit',
  'bash',
  'webfetch',
  'doom_loop',
  'external_directory',
  'task'
] as const;

/** A skill name becomes a directory under the container's skills path. */
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** POSIX environment variable name. */
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SettingDescriptor {
  key: string;
  group: 'auth' | 'github' | 'opencode' | 'container' | 'git' | 'docker';
  label: string;
  /**
   * How the value travels through the API:
   * - `secret`: write-only; reads report only `{ configured, updatedAt }`.
   * - `plain`: read back verbatim for editing.
   * - `partial`: an object where some fields read back and some are secret;
   *   the API handler knows which (ssh key public half, env var names).
   */
  exposure: 'secret' | 'plain' | 'partial';
  /** Missing value blocks the app behind the forced settings page. */
  required: boolean;
  /** Shape check; returns human-readable problems, empty when storable. */
  validate: (value: unknown) => string[];
}

export interface OpencodeConfigValidation {
  config?: Config;
  errors: string[];
  warnings: string[];
}

/**
 * The gate in front of `opencode.config`.
 *
 * Errors block the write: a config that parses but would strand every session
 * (an undecided permission, an unresolvable default model) is as broken as one
 * that does not parse. Warnings store anyway — they flag likely mistakes the
 * operator may genuinely intend.
 */
export function validateOpencodeConfig(raw: unknown): OpencodeConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { errors: ['The config must be a JSON object'], warnings };
  }
  const config = raw as Config;

  const permission = (config.permission ?? {}) as Record<string, unknown>;
  for (const key of REQUIRED_PERMISSION_KEYS) {
    if (permission[key] === undefined) {
      errors.push(
        `permission.${key} must be set explicitly — an omitted permission ` +
          'means "ask", nobody can answer an ask, and the session hangs'
      );
    }
  }

  const providers = config.provider ?? {};
  const providerIds = Object.keys(providers);
  if (providerIds.length === 0) {
    errors.push('At least one provider must be configured');
  }

  if (typeof config.model !== 'string' || config.model.length === 0) {
    errors.push('model must name the default model as "provider/model"');
  } else if (!resolveModelRef(config, config.model)) {
    errors.push(`model "${config.model}" does not match any configured provider model`);
  }

  for (const [providerID, provider] of Object.entries(providers)) {
    for (const [modelID, model] of Object.entries(provider?.models ?? {})) {
      const record = model as {
        attachment?: boolean;
        modalities?: { input?: string[] };
      };
      const inputs = record.modalities?.input;
      if (
        record.attachment &&
        (!Array.isArray(inputs) ||
          !inputs.includes('text') ||
          !inputs.includes('image'))
      ) {
        warnings.push(
          `${providerID}/${modelID} accepts attachments but modalities.input ` +
            'does not list both "text" and "image"; image prompts will fail'
        );
      }
    }
  }

  const defaultProviderId = config.model?.split('/')[0];
  if (defaultProviderId && providers[defaultProviderId]) {
    const options = providers[defaultProviderId]?.options as
      | { apiKey?: unknown }
      | undefined;
    if (!options?.apiKey) {
      warnings.push(
        `Provider "${defaultProviderId}" is the default but has no apiKey; ` +
          'sessions will fail unless it authenticates some other way'
      );
    }
  }

  return errors.length > 0 ? { errors, warnings } : { config, errors, warnings };
}

/**
 * True when `ref` resolves against a config's provider map. Model ids may
 * contain slashes, so the provider is the first segment and the model is
 * everything after it.
 */
function resolveModelRef(config: Config, ref: string): boolean {
  const separator = ref.indexOf('/');
  if (separator <= 0) {
    return false;
  }
  const providerID = ref.slice(0, separator);
  const modelID = ref.slice(separator + 1);
  return config.provider?.[providerID]?.models?.[modelID] !== undefined;
}

function validateGithubToken(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return ['The GitHub token must be a non-empty string'];
  }
  return [];
}

function validateSshKey(value: unknown): string[] {
  const record = value as Partial<SshKeySetting> | null;
  const errors: string[] = [];
  if (typeof record !== 'object' || record === null) {
    return ['The SSH key must be an object with privateKey and publicKey'];
  }
  if (
    typeof record.privateKey !== 'string' ||
    !record.privateKey.includes('BEGIN OPENSSH PRIVATE KEY')
  ) {
    errors.push('privateKey must be an OpenSSH private key (-----BEGIN OPENSSH PRIVATE KEY-----)');
  }
  if (
    typeof record.publicKey !== 'string' ||
    !/^(ssh-ed25519|ssh-rsa|ecdsa-[a-z0-9-]+) /.test(record.publicKey.trim())
  ) {
    errors.push('publicKey must be an OpenSSH public key line (for example "ssh-ed25519 AAAA…")');
  }
  return errors;
}

function validateEnvVars(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['Environment variables must be a list of { name, value }'];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of value as Partial<EnvVarSetting>[]) {
    if (typeof entry?.name !== 'string' || !ENV_NAME_PATTERN.test(entry.name)) {
      errors.push(`"${String(entry?.name)}" is not a valid environment variable name`);
      continue;
    }
    if (seen.has(entry.name)) {
      errors.push(`Environment variable "${entry.name}" is listed twice`);
    }
    seen.add(entry.name);
    if (typeof entry.value !== 'string' || entry.value.length === 0) {
      errors.push(`Environment variable "${entry.name}" has an empty value`);
    }
  }
  return errors;
}

function validateSkills(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['Skills must be a list of { name, content }'];
  }
  const errors: string[] = [];
  // Every skill lands at the same container path for its name, so a name may
  // be either one global entry or per-repo entries with distinct keys — a
  // global and a per-repo entry of the same name would silently shadow one
  // another in that repository's container.
  const scopes = new Map<string, { global: boolean; repos: Set<string> }>();
  for (const entry of value as Partial<SkillSetting>[]) {
    if (typeof entry?.name !== 'string' || !SKILL_NAME_PATTERN.test(entry.name)) {
      errors.push(
        `"${String(entry?.name)}" is not a valid skill name — use lowercase letters, digits and hyphens`
      );
      continue;
    }
    if (entry.repoKey !== undefined && !isSafeRepoKey(entry.repoKey)) {
      errors.push(
        `"${String(entry.repoKey)}" is not a valid repository key for skill "${entry.name}" — use lowercase letters, digits and hyphens`
      );
      continue;
    }
    const scope = scopes.get(entry.name) ?? {
      global: false,
      repos: new Set<string>()
    };
    if (entry.repoKey === undefined) {
      if (scope.global) {
        errors.push(`Skill "${entry.name}" is listed twice`);
      } else if (scope.repos.size > 0) {
        errors.push(
          `Skill "${entry.name}" is set both globally and per-repository — the two would collide at the same container path`
        );
      }
      scope.global = true;
    } else {
      const repo = entry.repoKey.toLowerCase();
      if (scope.repos.has(repo)) {
        errors.push(`Skill "${entry.name}" is listed twice for "${entry.repoKey}"`);
      } else if (scope.global) {
        errors.push(
          `Skill "${entry.name}" is set both globally and per-repository — the two would collide at the same container path`
        );
      }
      scope.repos.add(repo);
    }
    scopes.set(entry.name, scope);
    if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
      errors.push(`Skill "${entry.name}" has no SKILL.md content`);
    }
  }
  return errors;
}

function validateAgentsMd(value: unknown): string[] {
  const record = value as Partial<AgentsMdSetting> | null;
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    return ['The AGENTS.md setting must be an object with global and repos'];
  }
  const errors: string[] = [];
  if (record.global !== undefined && typeof record.global !== 'string') {
    errors.push('The global AGENTS.md content must be a string');
  }
  let hasRepoContent = false;
  if (record.repos !== undefined) {
    if (!Array.isArray(record.repos)) {
      errors.push('Per-repo entries must be a list of { repoKey, content }');
      return errors;
    }
    const seen = new Set<string>();
    for (const entry of record.repos) {
      if (!isSafeRepoKey(entry?.repoKey)) {
        errors.push(
          `"${String(entry?.repoKey)}" is not a valid repository key — use lowercase letters, digits and hyphens`
        );
        continue;
      }
      const key = entry.repoKey.toLowerCase();
      if (seen.has(key)) {
        errors.push(`Repository "${entry.repoKey}" has two entries`);
      }
      seen.add(key);
      if (
        typeof entry.content !== 'string' ||
        entry.content.trim().length === 0
      ) {
        errors.push(`The entry for "${entry.repoKey}" has no content`);
      } else {
        hasRepoContent = true;
      }
    }
  }
  if (
    errors.length === 0 &&
    (record.global ?? '').trim().length === 0 &&
    !hasRepoContent
  ) {
    errors.push(
      'Set global content or at least one per-repo entry — clear the setting instead of storing an empty one'
    );
  }
  return errors;
}

/**
 * `opencode.mcp-auth` holds a pasted `mcp-auth.json` — the file the OpenCode
 * CLI writes after `opencode mcp auth <name>`. Its internals are OpenCode's
 * business and change with it, so the only shape enforced is the outer one:
 * an object mapping server names to objects.
 */
function validateMcpAuth(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['The MCP auth setting must be a JSON object — paste the content of mcp-auth.json'];
  }
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`The entry for "${name}" is not an object`);
    }
  }
  return errors;
}

/** GitHub organization/user names: alphanumerics and hyphens, at most 39. */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function validateGitIdentity(value: unknown): string[] {
  const record = value as Partial<GitIdentitySetting> | null;
  if (typeof record !== 'object' || record === null) {
    return ['The git identity must be an object with name and email'];
  }
  const errors: string[] = [];
  if (typeof record.name !== 'string' || record.name.trim().length === 0) {
    errors.push('The git identity needs a name');
  }
  if (typeof record.email !== 'string' || !record.email.includes('@')) {
    errors.push('The git identity needs an email address');
  }
  if (record.overrides !== undefined) {
    if (!Array.isArray(record.overrides)) {
      errors.push('Overrides must be a list of { owner, name, email }');
      return errors;
    }
    const seen = new Set<string>();
    for (const entry of record.overrides) {
      if (
        typeof entry?.owner !== 'string' ||
        !GITHUB_OWNER_PATTERN.test(entry.owner)
      ) {
        errors.push(
          `"${String(entry?.owner)}" is not a valid GitHub organization name`
        );
        continue;
      }
      const key = entry.owner.toLowerCase();
      if (seen.has(key)) {
        errors.push(`Organization "${entry.owner}" has two overrides`);
      }
      seen.add(key);
      if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
        errors.push(`The override for "${entry.owner}" needs a name`);
      }
      if (typeof entry.email !== 'string' || !entry.email.includes('@')) {
        errors.push(`The override for "${entry.owner}" needs an email address`);
      }
    }
  }
  return errors;
}

/**
 * A Docker image reference as `docker run` accepts it: `[registry/]name[:tag]`
 * or `…@sha256:…`. The value becomes one argv element (never a shell word), so
 * this only has to keep out the shapes Docker itself would reject — plus a
 * leading hyphen, which would read as a flag.
 */
const DOCKER_IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

/**
 * The agent lives on someone's Mac mini behind a reverse proxy, and the bearer
 * token travels on every call — so the endpoint is an https origin, nothing
 * else. A path here would silently drop once the client appends its own.
 */
function validateDockerAgentUrl(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return ['The agent URL must be a non-empty string'];
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return [`"${value}" is not a URL`];
  }
  const errors: string[] = [];
  if (url.protocol !== 'https:') {
    errors.push('The agent URL must use https — the bearer token rides on every request');
  }
  if (url.username !== '' || url.password !== '') {
    errors.push('The agent URL must not carry credentials');
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    errors.push('The agent URL must be an origin only, with no path or query');
  }
  return errors;
}

function validateDockerAgentToken(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return ['The agent token must be a non-empty string'];
  }
  if (value !== value.trim()) {
    return ['The agent token must not have leading or trailing whitespace'];
  }
  return [];
}

function validateDockerImage(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return ['The image must be a non-empty string'];
  }
  if (!DOCKER_IMAGE_PATTERN.test(value)) {
    return [`"${value}" is not a Docker image reference (for example "${DEFAULT_DOCKER_IMAGE}")`];
  }
  return [];
}

/** Whole minutes, 1–24h. Stored as a JSON number. */
function validateDockerIdleTimeoutMinutes(value: unknown): string[] {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return ['Idle timeout must be a whole number of minutes'];
  }
  if (value < 1 || value > 1440) {
    return ['Idle timeout must be between 1 and 1440 minutes'];
  }
  return [];
}

/**
 * Everything the settings API serves and accepts, except the admin password —
 * that one never travels through the generic read/write routes; it has its own
 * endpoints in [access.ts](access.ts) and [api-settings.ts](api-settings.ts).
 */
export const SETTING_DESCRIPTORS: readonly SettingDescriptor[] = [
  {
    key: SETTING_KEYS.githubToken,
    group: 'github',
    label: 'GitHub token',
    exposure: 'secret',
    required: true,
    validate: validateGithubToken
  },
  {
    key: SETTING_KEYS.opencodeConfig,
    group: 'opencode',
    label: 'OpenCode config',
    exposure: 'plain',
    required: true,
    validate: (value) => validateOpencodeConfig(value).errors
  },
  {
    key: SETTING_KEYS.sshKey,
    group: 'container',
    label: 'SSH key',
    exposure: 'partial',
    required: true,
    validate: validateSshKey
  },
  {
    key: SETTING_KEYS.containerEnv,
    group: 'container',
    label: 'Environment variables',
    exposure: 'partial',
    required: false,
    validate: validateEnvVars
  },
  {
    key: SETTING_KEYS.skills,
    group: 'opencode',
    label: 'Skills',
    exposure: 'plain',
    required: false,
    validate: validateSkills
  },
  {
    key: SETTING_KEYS.agentsMd,
    group: 'opencode',
    label: 'AGENTS.md',
    exposure: 'plain',
    required: false,
    validate: validateAgentsMd
  },
  {
    key: SETTING_KEYS.mcpAuth,
    group: 'opencode',
    label: 'MCP auth (mcp-auth.json)',
    exposure: 'secret',
    required: false,
    validate: validateMcpAuth
  },
  {
    key: SETTING_KEYS.gitIdentity,
    group: 'git',
    label: 'Git identity',
    exposure: 'plain',
    required: false,
    validate: validateGitIdentity
  },
  // The Docker sandbox provider is opt-in: with these unset the site only
  // offers Cloudflare containers, which is the default deployment.
  {
    key: SETTING_KEYS.dockerAgentUrl,
    group: 'docker',
    label: 'Docker agent URL',
    exposure: 'plain',
    required: false,
    validate: validateDockerAgentUrl
  },
  {
    key: SETTING_KEYS.dockerAgentToken,
    group: 'docker',
    label: 'Docker agent token',
    exposure: 'secret',
    required: false,
    validate: validateDockerAgentToken
  },
  {
    key: SETTING_KEYS.dockerImage,
    group: 'docker',
    label: 'Docker session image',
    exposure: 'plain',
    required: false,
    validate: validateDockerImage
  },
  {
    key: SETTING_KEYS.dockerIdleTimeoutMinutes,
    group: 'docker',
    label: 'Docker idle timeout (minutes)',
    exposure: 'plain',
    required: false,
    validate: validateDockerIdleTimeoutMinutes
  }
];

export function findDescriptor(key: string): SettingDescriptor | undefined {
  return SETTING_DESCRIPTORS.find((descriptor) => descriptor.key === key);
}
