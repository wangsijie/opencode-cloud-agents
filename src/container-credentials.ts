/**
 * What the Worker injects into a container at wake, read from settings.
 *
 * The image used to carry these as baked-in files; now they live in D1 and
 * the Sandbox writes them on every wake. `/root` is outside the snapshotted
 * `/workspace`, so nothing here survives a container restart — which is the
 * point: every boot gets exactly what the settings table says, and rotating a
 * credential is an edit plus the next wake.
 *
 * The file/command derivations are pure so their shapes are unit-testable;
 * only `loadContainerCredentials` reads the database.
 */
import {
  SETTING_KEYS,
  readSetting,
  readSettingRow,
  type AgentsMdSetting,
  type EnvVarSetting,
  type GitIdentitySetting,
  type SkillSetting,
  type SshKeySetting
} from './settings.ts';

/** Where OpenCode discovers global skills inside the container. */
export const CONTAINER_SKILLS_ROOT = '/root/.config/opencode/skills';

/** Where OpenCode discovers global instructions inside the container. */
export const CONTAINER_AGENTS_MD_PATH = '/root/.config/opencode/AGENTS.md';

/**
 * Where OpenCode keeps its MCP OAuth store: `$XDG_DATA_HOME/opencode`, and the
 * server env pins XDG_DATA_HOME to `/workspace/.opencode-state/data`
 * (OPENCODE_ENV in [sandbox.ts](sandbox.ts)). Unlike everything else this
 * module writes, the store lives *inside* the snapshotted `/workspace` on
 * purpose: OpenCode refreshes the tokens in place, and the refreshed lineage
 * must survive restarts — reseeding from the settings value on every wake
 * would clobber a rotated refresh token and break the grant.
 */
export const MCP_AUTH_DIR = '/workspace/.opencode-state/data/opencode';

/** The MCP OAuth store OpenCode reads and refreshes. */
export const MCP_AUTH_PATH = `${MCP_AUTH_DIR}/mcp-auth.json`;

/**
 * Which settings revision seeded this workspace's store. Lives next to the
 * store so the pair travels through checkpoint and restore together.
 */
export const MCP_AUTH_MARKER = `${MCP_AUTH_DIR}/.mcp-auth.seeded`;

/**
 * Where the wake stages the pasted store before the guarded install. Under
 * `/root` — outside the snapshot — so an unconsumed copy never outlives the
 * boot.
 */
export const MCP_AUTH_STAGING = '/root/.mcp-auth.pending.json';

export interface ContainerCredentialSettings {
  sshKey?: SshKeySetting;
  /** Shared with the Worker-side repo catalog; the container's gh CLI logs in with it. */
  githubToken?: string;
  gitIdentity?: GitIdentitySetting;
  env: EnvVarSetting[];
  skills: SkillSetting[];
  agentsMd?: AgentsMdSetting;
  /**
   * A pasted `mcp-auth.json` and the settings revision it came from. `content`
   * is the stored JSON text verbatim; `token` is the row's `updatedAt`, which
   * the wake compares against the workspace marker — a re-paste is the
   * operator's "reseed every session" action.
   */
  mcpAuth?: { content: string; token: string };
}

export interface ContainerFile {
  path: string;
  content: string;
  /** chmod mode; `writeFile` gives no permission guarantee and OpenSSH rejects open private keys. */
  mode: '600' | '644';
}

export async function loadContainerCredentials(
  env: Env
): Promise<ContainerCredentialSettings> {
  const [sshKey, githubToken, gitIdentity, envVars, skills, agentsMd, mcpAuth] =
    await Promise.all([
      readSetting<SshKeySetting>(env, SETTING_KEYS.sshKey),
      readSetting<string>(env, SETTING_KEYS.githubToken),
      readSetting<GitIdentitySetting>(env, SETTING_KEYS.gitIdentity),
      readSetting<EnvVarSetting[]>(env, SETTING_KEYS.containerEnv),
      readSetting<SkillSetting[]>(env, SETTING_KEYS.skills),
      readSetting<AgentsMdSetting>(env, SETTING_KEYS.agentsMd),
      readSettingRow(env, SETTING_KEYS.mcpAuth)
    ]);
  return {
    ...(sshKey ? { sshKey } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(gitIdentity ? { gitIdentity } : {}),
    env: envVars ?? [],
    skills: skills ?? [],
    ...(agentsMd ? { agentsMd } : {}),
    ...(mcpAuth
      ? { mcpAuth: { content: mcpAuth.value, token: mcpAuth.updatedAt } }
      : {})
  };
}

/**
 * Every file a wake writes into the container, in write order.
 *
 * The gh login is derived from the GitHub token rather than stored on its
 * own: one token serves the Worker's repo listing and the container's `gh`.
 * Skills and AGENTS.md land under the global config root, which the R2
 * snapshot never covers, so what is written here is always exactly the
 * settings list.
 *
 * `repoKey` is the instance's repository; it selects the per-repo AGENTS.md
 * addition and the repo-scoped skills when the settings hold any. Repo-scoped
 * skills still land in the global skills directory — the sandbox holds a
 * single checkout, so scoping decides *whether* a skill is written, never
 * *where*, and the repository itself stays untouched.
 */
export function credentialFiles(
  settings: ContainerCredentialSettings,
  repoKey?: string
): ContainerFile[] {
  const files: ContainerFile[] = [];
  if (settings.sshKey) {
    files.push(
      {
        path: '/root/.ssh/id_ed25519',
        content: ensureTrailingNewline(settings.sshKey.privateKey),
        mode: '600'
      },
      {
        path: '/root/.ssh/id_ed25519.pub',
        content: ensureTrailingNewline(settings.sshKey.publicKey),
        mode: '644'
      }
    );
  }
  if (settings.githubToken) {
    files.push({
      path: '/root/.config/gh/hosts.yml',
      content:
        'github.com:\n' +
        `    oauth_token: ${settings.githubToken}\n` +
        '    git_protocol: ssh\n',
      mode: '600'
    });
  }
  for (const skill of resolveSkills(settings.skills, repoKey)) {
    files.push({
      path: `${CONTAINER_SKILLS_ROOT}/${skill.name}/SKILL.md`,
      content: ensureTrailingNewline(skill.content),
      mode: '644'
    });
  }
  const agentsMd = resolveAgentsMd(settings.agentsMd, repoKey);
  if (agentsMd) {
    files.push({
      path: CONTAINER_AGENTS_MD_PATH,
      content: ensureTrailingNewline(agentsMd),
      mode: '644'
    });
  }
  if (settings.mcpAuth) {
    // Staged only; the guarded seed command decides whether it reaches the
    // workspace store or is discarded. Writing through the batch keeps the
    // token payload off every command line.
    files.push({
      path: MCP_AUTH_STAGING,
      content: ensureTrailingNewline(settings.mcpAuth.content),
      mode: '600'
    });
  }
  return files;
}

/**
 * The skills this container should see: the global ones plus those scoped to
 * its repository. A session without a repository gets only the global set.
 * Repo keys compare case-insensitively, matching the catalog's lowercasing.
 */
export function resolveSkills(
  skills: SkillSetting[],
  repoKey?: string
): SkillSetting[] {
  return skills.filter(
    (skill) =>
      skill.repoKey === undefined ||
      (repoKey !== undefined &&
        skill.repoKey.toLowerCase() === repoKey.toLowerCase())
  );
}

/**
 * The AGENTS.md content this container should see: the global block followed
 * by the addition for its repository when one exists. The sandbox holds a
 * single checkout, so a merged file at the global config path covers both.
 * Repo keys compare case-insensitively, matching the catalog's lowercasing.
 */
export function resolveAgentsMd(
  agentsMd: AgentsMdSetting | undefined,
  repoKey?: string
): string | undefined {
  if (!agentsMd) {
    return undefined;
  }
  const repoEntry = repoKey
    ? agentsMd.repos?.find(
        (entry) => entry.repoKey.toLowerCase() === repoKey.toLowerCase()
      )
    : undefined;
  const parts = [agentsMd.global, repoEntry?.content]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * The identity this container should commit as: the override for the
 * repository's owner when one exists, otherwise the base identity. Owner
 * comparison is case-insensitive, as GitHub's owner names are.
 */
export function resolveGitIdentity(
  gitIdentity: GitIdentitySetting | undefined,
  repoOwner?: string
): { name: string; email: string } | undefined {
  if (!gitIdentity) {
    return undefined;
  }
  const override = repoOwner
    ? gitIdentity.overrides?.find(
        (entry) => entry.owner.toLowerCase() === repoOwner.toLowerCase()
      )
    : undefined;
  return override ?? gitIdentity;
}

/**
 * The git configuration a wake applies, mirroring what the Dockerfile used to
 * bake in: identity when one is set, SSH commit signing when a key exists.
 *
 * `repoOwner` is the owner of the instance's repository; it selects a
 * per-organization identity override when the settings hold one.
 */
export function gitConfigCommands(
  settings: ContainerCredentialSettings,
  repoOwner?: string
): string[] {
  const commands: string[] = [];
  const identity = resolveGitIdentity(settings.gitIdentity, repoOwner);
  if (identity) {
    commands.push(
      `git config --global user.name ${shellQuote(identity.name)}`,
      `git config --global user.email ${shellQuote(identity.email)}`
    );
  }
  if (settings.sshKey) {
    commands.push(
      'git config --global gpg.format ssh',
      'git config --global user.signingkey /root/.ssh/id_ed25519',
      'git config --global commit.gpgsign true'
    );
  }
  return commands;
}

/**
 * Install the staged MCP auth store, but only when the settings revision
 * differs from what already seeded this workspace. A matching marker means
 * OpenCode's own refreshed lineage is newer than the paste — overwriting it
 * would resurrect an already-rotated refresh token — so the staged copy is
 * discarded instead. Only the revision token appears on the command line,
 * never the store itself.
 */
export function mcpAuthSeedCommand(token: string): string {
  const marker = shellQuote(MCP_AUTH_MARKER);
  const target = shellQuote(MCP_AUTH_PATH);
  const staging = shellQuote(MCP_AUTH_STAGING);
  return (
    `if [ "$(cat ${marker} 2>/dev/null || true)" != ${shellQuote(token)} ]; ` +
    `then mkdir -p ${shellQuote(MCP_AUTH_DIR)} && mv ${staging} ${target} && ` +
    `chmod 600 ${target} && printf %s ${shellQuote(token)} > ${marker}; ` +
    `else rm -f ${staging}; fi`
  );
}

/**
 * Remove a previously seeded MCP auth store once the setting is cleared. The
 * marker gates the delete so a store OpenCode created on its own — one this
 * Worker never seeded — is left alone.
 */
export function mcpAuthClearCommand(): string {
  return `if [ -e ${shellQuote(MCP_AUTH_MARKER)} ]; then rm -f ${shellQuote(
    MCP_AUTH_PATH
  )} ${shellQuote(MCP_AUTH_MARKER)}; fi`;
}

/** The operator's extra variables, as the process env map the server start takes. */
export function containerEnv(
  settings: ContainerCredentialSettings
): Record<string, string> {
  return Object.fromEntries(
    settings.env.map((entry) => [entry.name, entry.value])
  );
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
