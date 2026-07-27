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
import { SETTING_KEYS } from './settings.ts';
import type {
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
  group: 'auth' | 'github' | 'opencode' | 'container' | 'git';
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
  const seen = new Set<string>();
  for (const entry of value as Partial<SkillSetting>[]) {
    if (typeof entry?.name !== 'string' || !SKILL_NAME_PATTERN.test(entry.name)) {
      errors.push(
        `"${String(entry?.name)}" is not a valid skill name — use lowercase letters, digits and hyphens`
      );
      continue;
    }
    if (seen.has(entry.name)) {
      errors.push(`Skill "${entry.name}" is listed twice`);
    }
    seen.add(entry.name);
    if (typeof entry.content !== 'string' || entry.content.trim().length === 0) {
      errors.push(`Skill "${entry.name}" has no SKILL.md content`);
    }
  }
  return errors;
}

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
  return errors;
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
    key: SETTING_KEYS.gitIdentity,
    group: 'git',
    label: 'Git identity',
    exposure: 'plain',
    required: false,
    validate: validateGitIdentity
  }
];

export function findDescriptor(key: string): SettingDescriptor | undefined {
  return SETTING_DESCRIPTORS.find((descriptor) => descriptor.key === key);
}
