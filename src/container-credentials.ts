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
  type EnvVarSetting,
  type GitIdentitySetting,
  type SkillSetting,
  type SshKeySetting
} from './settings.ts';

/** Where OpenCode discovers global skills inside the container. */
export const CONTAINER_SKILLS_ROOT = '/root/.config/opencode/skills';

export interface ContainerCredentialSettings {
  sshKey?: SshKeySetting;
  /** Shared with the Worker-side repo catalog; the container's gh CLI logs in with it. */
  githubToken?: string;
  gitIdentity?: GitIdentitySetting;
  env: EnvVarSetting[];
  skills: SkillSetting[];
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
  const [sshKey, githubToken, gitIdentity, envVars, skills] = await Promise.all([
    readSetting<SshKeySetting>(env, SETTING_KEYS.sshKey),
    readSetting<string>(env, SETTING_KEYS.githubToken),
    readSetting<GitIdentitySetting>(env, SETTING_KEYS.gitIdentity),
    readSetting<EnvVarSetting[]>(env, SETTING_KEYS.containerEnv),
    readSetting<SkillSetting[]>(env, SETTING_KEYS.skills)
  ]);
  return {
    ...(sshKey ? { sshKey } : {}),
    ...(githubToken ? { githubToken } : {}),
    ...(gitIdentity ? { gitIdentity } : {}),
    env: envVars ?? [],
    skills: skills ?? []
  };
}

/**
 * Every file a wake writes into the container, in write order.
 *
 * The gh login is derived from the GitHub token rather than stored on its
 * own: one token serves the Worker's repo listing and the container's `gh`.
 * Skills land under the global config root, which the R2 snapshot never
 * covers, so what is written here is always exactly the settings list.
 */
export function credentialFiles(
  settings: ContainerCredentialSettings
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
  for (const skill of settings.skills) {
    files.push({
      path: `${CONTAINER_SKILLS_ROOT}/${skill.name}/SKILL.md`,
      content: ensureTrailingNewline(skill.content),
      mode: '644'
    });
  }
  return files;
}

/**
 * The git configuration a wake applies, mirroring what the Dockerfile used to
 * bake in: identity when one is set, SSH commit signing when a key exists.
 */
export function gitConfigCommands(
  settings: ContainerCredentialSettings
): string[] {
  const commands: string[] = [];
  if (settings.gitIdentity) {
    commands.push(
      `git config --global user.name ${shellQuote(settings.gitIdentity.name)}`,
      `git config --global user.email ${shellQuote(settings.gitIdentity.email)}`
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
