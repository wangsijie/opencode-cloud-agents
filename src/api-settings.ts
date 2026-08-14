/**
 * `/api/settings`: the read/write surface behind the settings page.
 *
 * Shapes are decided by the descriptor registry in
 * [settings-schema.ts](settings-schema.ts); this module adds the transport
 * rules — secrets never read back, the SSH public half and env var names do —
 * and the one check that needs the database: models still pinned by sessions
 * must survive an `opencode.config` edit unless the operator forces it.
 *
 * The admin password is deliberately not one of the generic keys: its record
 * must never travel, so it has its own endpoint here and its bootstrap lives
 * in [access.ts](access.ts).
 */
import { MIN_PASSWORD_LENGTH, createAdminSession } from './access.ts';
import { adminSessions, db, sessions } from './db/index.ts';
import { json, methodNotAllowed } from './http.ts';
import { hashPassword, verifyPassword } from './password.ts';
import {
  SETTING_KEYS,
  deleteSetting,
  readSetting,
  readSettingRow,
  writeSetting
} from './settings.ts';
import type {
  DockerHostSetting,
  EnvVarSetting,
  PasswordRecord,
  SshKeySetting
} from './settings.ts';
import {
  SETTING_DESCRIPTORS,
  findDescriptor,
  validateOpencodeConfig
} from './settings-schema.ts';
import { generateSshKeyPair } from './ssh-keygen.ts';

/** One setting as the page sees it; secrets carry no `value`. */
export interface SettingView {
  key: string;
  group: string;
  label: string;
  required: boolean;
  configured: boolean;
  updatedAt?: string;
  value?: unknown;
}

export async function handleSettingsApi(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const rest = url.pathname.slice('/api/settings'.length);

  if (rest === '' || rest === '/') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return json({ settings: await listSettings(env) });
  }

  if (rest === '/status') {
    if (request.method !== 'GET') {
      return methodNotAllowed('GET');
    }
    return json({ missing: await missingRequiredSettings(env) });
  }

  if (rest === '/password') {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST');
    }
    return changePassword(request, env, url);
  }

  if (rest === '/ssh-key/generate') {
    if (request.method !== 'POST') {
      return methodNotAllowed('POST');
    }
    const pair = await generateSshKeyPair();
    await writeSetting(env, SETTING_KEYS.sshKey, pair satisfies SshKeySetting);
    return json({ publicKey: pair.publicKey });
  }

  const key = decodeURIComponent(rest.replace(/^\//, ''));
  const descriptor = findDescriptor(key);
  if (!descriptor) {
    return json({ error: `Unknown setting: ${key}` }, 404);
  }
  if (request.method !== 'PUT') {
    return methodNotAllowed('PUT');
  }
  return putSetting(request, env, descriptor.key);
}

async function listSettings(env: Env): Promise<SettingView[]> {
  const views: SettingView[] = [];
  for (const descriptor of SETTING_DESCRIPTORS) {
    const row = await readSettingRow(env, descriptor.key);
    const view: SettingView = {
      key: descriptor.key,
      group: descriptor.group,
      label: descriptor.label,
      required: descriptor.required,
      configured: row !== undefined,
      ...(row ? { updatedAt: row.updatedAt } : {})
    };
    if (row) {
      view.value = exposedValue(descriptor.key, parseRow(row.value));
    }
    views.push(view);
  }
  return views;
}

function parseRow(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** What of a stored value may travel back to the browser. */
function exposedValue(key: string, value: unknown): unknown {
  switch (key) {
    case SETTING_KEYS.opencodeConfig:
    case SETTING_KEYS.skills:
    case SETTING_KEYS.agentsMd:
    case SETTING_KEYS.gitIdentity:
      return value;
    case SETTING_KEYS.dockerHosts: {
      // Everything about a host reads back except the bearer, which the page
      // shows as configured-or-not and sends back empty when untouched.
      const list = Array.isArray(value) ? (value as DockerHostSetting[]) : [];
      return list.map(({ token, ...rest }) => ({
        ...rest,
        tokenConfigured: typeof token === 'string' && token.length > 0
      }));
    }
    case SETTING_KEYS.sshKey: {
      const record = value as Partial<SshKeySetting> | undefined;
      return record ? { publicKey: record.publicKey } : undefined;
    }
    case SETTING_KEYS.containerEnv: {
      const list = Array.isArray(value) ? (value as EnvVarSetting[]) : [];
      return list.map((entry) => ({ name: entry.name }));
    }
    default:
      // Secrets: `configured` is the whole answer.
      return undefined;
  }
}

export async function missingRequiredSettings(env: Env): Promise<string[]> {
  const missing: string[] = [];
  for (const descriptor of SETTING_DESCRIPTORS) {
    if (!descriptor.required) {
      continue;
    }
    if ((await readSettingRow(env, descriptor.key)) === undefined) {
      missing.push(descriptor.key);
    }
  }
  return missing;
}

async function putSetting(
  request: Request,
  env: Env,
  key: string
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    value?: unknown;
    force?: unknown;
  } | null;
  if (!body || !('value' in body)) {
    return json({ error: 'Send { value } to store' }, 400);
  }
  const descriptor = findDescriptor(key);
  if (!descriptor) {
    return json({ error: `Unknown setting: ${key}` }, 404);
  }

  if (body.value === null) {
    if (descriptor.required) {
      return json({ error: `${descriptor.label} is required and cannot be cleared` }, 400);
    }
    await deleteSetting(env, key);
    return json({ ok: true });
  }

  let value: unknown = body.value;
  if (key === SETTING_KEYS.containerEnv) {
    value = await mergeEnvValues(env, value);
  }
  if (key === SETTING_KEYS.dockerHosts) {
    value = await mergeDockerHostTokens(env, value);
  }

  const errors = descriptor.validate(value);
  if (errors.length > 0) {
    return json({ error: errors[0], errors }, 400);
  }

  let warnings: string[] = [];
  if (key === SETTING_KEYS.opencodeConfig) {
    const validation = validateOpencodeConfig(value);
    warnings = validation.warnings;
    const orphaned = await orphanedPinnedModels(env, validation.config!);
    if (orphaned.length > 0 && body.force !== true) {
      return json(
        {
          error:
            'Sessions are pinned to models this config no longer defines; ' +
            'save again with force to proceed',
          pinnedModels: orphaned
        },
        400
      );
    }
  }

  await writeSetting(env, key, value);
  return json({ ok: true, warnings });
}

/**
 * Env var values are write-only, so the page sends names with empty values for
 * rows it did not retype. Those keep their stored value; everything else is
 * replaced, and a name absent from the list is removed.
 */
async function mergeEnvValues(env: Env, value: unknown): Promise<unknown> {
  if (!Array.isArray(value)) {
    return value;
  }
  const stored =
    (await readSetting<EnvVarSetting[]>(env, SETTING_KEYS.containerEnv)) ?? [];
  const existing = new Map(stored.map((entry) => [entry.name, entry.value]));
  return (value as Partial<EnvVarSetting>[]).map((entry) =>
    typeof entry?.name === 'string' && entry.value === ''
      ? { name: entry.name, value: existing.get(entry.name) ?? '' }
      : entry
  );
}

/**
 * Host tokens are write-only, so the page sends an empty one for a host it did
 * not retype. Those keep the token stored under the same id; a host whose id
 * is new has nothing to keep and must carry its own, which the validator then
 * insists on.
 */
async function mergeDockerHostTokens(
  env: Env,
  value: unknown
): Promise<unknown> {
  if (!Array.isArray(value)) {
    return value;
  }
  const stored =
    (await readSetting<DockerHostSetting[]>(env, SETTING_KEYS.dockerHosts)) ??
    [];
  const existing = new Map(stored.map((host) => [host.id, host.token]));
  return (value as Partial<DockerHostSetting>[]).map((host) =>
    typeof host?.id === 'string' && (host.token === '' || host.token === undefined)
      ? { ...host, token: existing.get(host.id) ?? '' }
      : host
  );
}

/**
 * Models that existing sessions are pinned to but the incoming config no
 * longer defines. Removing one breaks every session that would prompt with
 * it, so the operator must say so on purpose.
 */
async function orphanedPinnedModels(
  env: Env,
  config: { provider?: Record<string, { models?: Record<string, unknown> }> }
): Promise<string[]> {
  const rows = await db(env)
    .selectDistinct({ model: sessions.model })
    .from(sessions);
  const orphaned: string[] = [];
  for (const row of rows) {
    const separator = row.model.indexOf('/');
    if (separator <= 0) {
      continue;
    }
    const providerID = row.model.slice(0, separator);
    const modelID = row.model.slice(separator + 1);
    if (config.provider?.[providerID]?.models?.[modelID] === undefined) {
      orphaned.push(row.model);
    }
  }
  return orphaned;
}

/**
 * Change the password: proves the current one, stores the new record, and
 * revokes every browser session — the caller included, which is why a fresh
 * cookie rides back on the response.
 */
async function changePassword(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    currentPassword?: unknown;
    newPassword?: unknown;
  } | null;
  const current =
    typeof body?.currentPassword === 'string' ? body.currentPassword : '';
  const next = typeof body?.newPassword === 'string' ? body.newPassword : '';
  if (next.length < MIN_PASSWORD_LENGTH) {
    return json(
      { error: `The password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }
  const record = await readSetting<PasswordRecord>(
    env,
    SETTING_KEYS.adminPassword
  );
  if (!record || !(await verifyPassword(record, current))) {
    return json({ error: 'That is not the current password' }, 401);
  }
  await writeSetting(env, SETTING_KEYS.adminPassword, await hashPassword(next));
  // Every browser, including this one: the fresh cookie below is what keeps
  // the caller signed in.
  await db(env).delete(adminSessions);
  const session = await createAdminSession(env, url);
  return json({ ok: true }, 200, { 'Set-Cookie': session.cookie });
}
