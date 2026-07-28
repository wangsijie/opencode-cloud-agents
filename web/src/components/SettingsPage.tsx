import { useEffect, useMemo, useState } from 'react';
import {
  changePassword,
  fetchCatalog,
  fetchSettings,
  generateSshKey,
  saveSetting,
  type RepoOption,
  type SettingView
} from '../api';
import { MenuIcon } from './icons';

/**
 * Every runtime setting in one place: the credentials and configuration that
 * used to be baked into the code and the container image.
 *
 * The page is a master–detail split: section names down the left (a scrollable
 * pill row on a phone), one section's form on the right. Each section carries
 * a status mark — required-and-missing, or configured — so the whole state of
 * the deployment is readable from the nav alone.
 *
 * Secrets are write-only — the page shows whether one is stored and never what
 * it is; typing a new value replaces it, leaving the field empty keeps it. The
 * two readable exceptions are the OpenCode config (a JSON editor cannot edit
 * what it cannot read) and the SSH public key (it exists to be pasted into
 * GitHub).
 *
 * In `forced` mode the page is the whole app: required settings are missing,
 * so nothing else can run yet. Each save calls `onSettingsChanged` and then
 * moves the selection to the next required section that is still missing, so
 * onboarding walks itself; once nothing required is missing, the footer offers
 * the one explicit way in — the gate never opens on its own, leaving room to
 * finish the optional sections first.
 */

interface Section {
  id: string;
  label: string;
  /** The stored setting this section edits; absent for the password. */
  key?: string;
}

const SECTIONS: Section[] = [
  { id: 'github-token', label: 'GitHub token', key: 'github.token' },
  { id: 'opencode-config', label: 'OpenCode config', key: 'opencode.config' },
  { id: 'ssh-key', label: 'SSH key', key: 'container.ssh-key' },
  { id: 'env', label: 'Environment variables', key: 'container.env' },
  { id: 'skills', label: 'Skills', key: 'opencode.skills' },
  { id: 'agents-md', label: 'AGENTS.md', key: 'opencode.agents-md' },
  { id: 'git-identity', label: 'Git identity', key: 'git.identity' },
  { id: 'docker', label: 'Docker host', key: 'docker.agent-url' },
  { id: 'password', label: 'Admin password' }
];

export function SettingsPage({
  forced,
  onMenu,
  onSettingsChanged,
  onContinue
}: {
  forced: boolean;
  onMenu?: () => void;
  onSettingsChanged: () => void;
  /** Set in forced mode once every required setting is stored. */
  onContinue?: () => void;
}) {
  const [settings, setSettings] = useState<SettingView[]>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<string>();

  const load = async (): Promise<SettingView[] | undefined> => {
    try {
      const fresh = (await fetchSettings()).settings;
      setSettings(fresh);
      setLoadError(undefined);
      return fresh;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const byKey = useMemo(
    () => new Map((settings ?? []).map((setting) => [setting.key, setting])),
    [settings]
  );

  const firstMissing = (list: SettingView[]) =>
    SECTIONS.find((section) => {
      const view = section.key
        ? list.find((setting) => setting.key === section.key)
        : undefined;
      return view !== undefined && view.required && !view.configured;
    });

  const missing = (settings ?? []).filter(
    (setting) => setting.required && !setting.configured
  );

  // Until a section is clicked, onboarding opens on the first missing required
  // setting and a normal visit opens on the first section.
  const active =
    selected ??
    (settings
      ? forced
        ? (firstMissing(settings) ?? SECTIONS[0]).id
        : SECTIONS[0].id
      : undefined);

  const saved = () => {
    void (async () => {
      const fresh = await load();
      onSettingsChanged();
      // Onboarding walks itself: whatever was just saved, the selection moves
      // to the first required section that is still unconfigured. Once there
      // is none, it stays put — the footer takes over.
      if (forced && fresh) {
        const next = firstMissing(fresh);
        if (next) {
          setSelected(next.id);
        }
      }
    })();
  };

  const statusOf = (section: Section): 'missing' | 'done' | undefined => {
    const view = section.key ? byKey.get(section.key) : undefined;
    if (!view) {
      return undefined;
    }
    if (view.configured) {
      return 'done';
    }
    return view.required ? 'missing' : undefined;
  };

  return (
    <div className="session-view">
      <header className="content-header bare">
        {onMenu ? (
          <button
            className="icon-button hamburger"
            type="button"
            onClick={onMenu}
            aria-label="Open sessions"
          >
            <MenuIcon />
          </button>
        ) : null}
      </header>

      <div className="content-body">
        <div className="settings-page">
          <h1>Settings</h1>

          {loadError ? (
            <section className="card error">
              <p className="muted">{loadError}</p>
              <div className="actions">
                <button className="button" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            </section>
          ) : !settings ? (
            <p className="muted">Loading…</p>
          ) : (
            <div className="settings-layout">
              <nav className="settings-nav" aria-label="Settings sections">
                {SECTIONS.map((section) => {
                  const status = statusOf(section);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className={
                        section.id === active
                          ? 'settings-nav-item active'
                          : 'settings-nav-item'
                      }
                      onClick={() => setSelected(section.id)}
                    >
                      <span
                        className={`nav-state${status ? ` ${status}` : ''}`}
                        aria-hidden="true"
                      />
                      {section.label}
                    </button>
                  );
                })}
              </nav>

              <div className="settings-detail">
                {active === 'github-token' ? (
                  <GithubTokenSection
                    setting={byKey.get('github.token')}
                    onSaved={saved}
                  />
                ) : active === 'opencode-config' ? (
                  <OpencodeConfigSection
                    setting={byKey.get('opencode.config')}
                    onSaved={saved}
                  />
                ) : active === 'ssh-key' ? (
                  <SshKeySection
                    setting={byKey.get('container.ssh-key')}
                    onSaved={saved}
                  />
                ) : active === 'env' ? (
                  <EnvVarsSection
                    setting={byKey.get('container.env')}
                    onSaved={saved}
                  />
                ) : active === 'skills' ? (
                  <SkillsSection
                    setting={byKey.get('opencode.skills')}
                    onSaved={saved}
                  />
                ) : active === 'agents-md' ? (
                  <AgentsMdSection
                    setting={byKey.get('opencode.agents-md')}
                    onSaved={saved}
                  />
                ) : active === 'git-identity' ? (
                  <GitIdentitySection
                    setting={byKey.get('git.identity')}
                    onSaved={saved}
                  />
                ) : active === 'docker' ? (
                  <DockerSection
                    url={byKey.get('docker.agent-url')}
                    token={byKey.get('docker.agent-token')}
                    image={byKey.get('docker.image')}
                    onSaved={saved}
                  />
                ) : (
                  <PasswordSection />
                )}

                {forced ? (
                  <div className="settings-continue">
                    {missing.length > 0 ? (
                      <p className="muted">
                        Required before the Hub can run:{' '}
                        {missing.map((setting) => setting.label).join(', ')}
                      </p>
                    ) : (
                      <>
                        <p className="muted">
                          Everything required is configured — finish anything
                          optional you want, then head in.
                        </p>
                        <button
                          className="button primary"
                          disabled={!onContinue}
                          onClick={onContinue}
                        >
                          Continue to the Hub
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const run = async (work: () => Promise<string | undefined>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setNotice((await work()) ?? 'Saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, notice, run };
}

function SectionStatus({
  error,
  notice
}: {
  error?: string;
  notice?: string;
}) {
  if (error) {
    return <p className="form-error">{error}</p>;
  }
  if (notice) {
    return <p className="muted">{notice}</p>;
  }
  return null;
}

function configuredHint(setting: SettingView | undefined): string {
  return setting?.configured
    ? 'Configured — enter a new value to replace it'
    : 'Not configured yet';
}

function GithubTokenSection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const [token, setToken] = useState('');
  const { busy, error, notice, run } = useSave();

  return (
    <section className="settings-section">
      <h2>GitHub token</h2>
      <p className="muted">
        Lists the repositories a session can start from, and signs the
        container's <code>gh</code> CLI in for pull requests. A classic token
        with <code>repo</code> scope works for both.
      </p>
      <input
        type="password"
        autoComplete="off"
        placeholder={configuredHint(setting)}
        aria-label="GitHub token"
        value={token}
        disabled={busy}
        onChange={(event) => setToken(event.target.value)}
      />
      <div className="actions">
        <button
          className="button primary"
          disabled={busy || token.trim().length === 0}
          onClick={() =>
            void run(async () => {
              await saveSetting('github.token', token.trim());
              setToken('');
              onSaved();
              return undefined;
            })
          }
        >
          Save token
        </button>
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

/** A starting point that satisfies the server's permission-completeness gate. */
const CONFIG_TEMPLATE = {
  model: 'provider/model',
  small_model: 'provider/model',
  permission: {
    edit: 'allow',
    bash: 'allow',
    webfetch: 'allow',
    doom_loop: 'allow',
    external_directory: 'allow',
    task: 'allow'
  },
  provider: {
    provider: {
      npm: '@ai-sdk/openai-compatible',
      name: 'Provider name',
      options: { apiKey: '', baseURL: 'https://example.com/v1' },
      models: {
        model: { name: 'Model name' }
      }
    }
  }
};

function OpencodeConfigSection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const [text, setText] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const { busy, error, notice, run } = useSave();

  const value =
    text ??
    JSON.stringify(setting?.configured ? setting.value : CONFIG_TEMPLATE, null, 2);

  return (
    <section className="settings-section">
      <h2>OpenCode config</h2>
      <p className="muted">
        The whole configuration OpenCode starts with inside every container:
        providers, API keys, models, permissions. Every <code>permission</code>{' '}
        key must stay explicitly set — an omitted one hangs the session — and
        removing a model breaks sessions pinned to it.
      </p>
      <textarea
        className="code-editor"
        rows={18}
        spellCheck={false}
        aria-label="OpenCode config JSON"
        value={value}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="actions">
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(value);
              } catch (cause) {
                throw new Error(
                  `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
                );
              }
              let result;
              try {
                result = await saveSetting('opencode.config', parsed);
              } catch (cause) {
                const message =
                  cause instanceof Error ? cause.message : String(cause);
                // The server refuses a save that orphans pinned models unless
                // the operator confirms it knows what it is breaking.
                if (/pinned to models/i.test(message)) {
                  if (
                    !confirm(
                      'Existing sessions are pinned to models this config removes; ' +
                        'they will fail on their next prompt. Save anyway?'
                    )
                  ) {
                    return 'Not saved';
                  }
                  result = await saveSetting('opencode.config', parsed, true);
                } else {
                  throw cause;
                }
              }
              setWarnings(result.warnings ?? []);
              onSaved();
              return undefined;
            })
          }
        >
          Save config
        </button>
      </div>
      {warnings.map((warning) => (
        <p key={warning} className="form-error">
          Warning: {warning}
        </p>
      ))}
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

function SshKeySection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const [privateKey, setPrivateKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const { busy, error, notice, run } = useSave();

  const storedPublicKey =
    (setting?.value as { publicKey?: string } | undefined)?.publicKey ?? '';

  return (
    <section className="settings-section">
      <h2>SSH key</h2>
      <p className="muted">
        Containers clone, fetch and push over SSH with this key, and sign their
        commits with it. Register the public key on GitHub — as a deploy key
        per repository, or on a machine account.
      </p>
      {storedPublicKey ? (
        <>
          <p className="muted">Current public key:</p>
          <textarea
            className="code-editor"
            rows={3}
            readOnly
            aria-label="Current SSH public key"
            value={storedPublicKey}
          />
          <div className="actions">
            <button
              className="button"
              type="button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(storedPublicKey)
                  .catch(() => undefined);
              }}
            >
              Copy public key
            </button>
          </div>
        </>
      ) : null}
      <div className="actions">
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (
                setting?.configured &&
                !confirm(
                  'Replace the stored SSH key? Containers lose repository ' +
                    'access until the new public key is registered on GitHub.'
                )
              ) {
                return 'Not replaced';
              }
              await generateSshKey();
              onSaved();
              return 'Generated — copy the public key to GitHub';
            })
          }
        >
          {setting?.configured ? 'Generate a new ed25519 key' : 'Generate an ed25519 key'}
        </button>
      </div>
      <details className="settings-advanced">
        <summary className="muted">…or paste an existing key pair</summary>
        <textarea
          className="code-editor"
          rows={6}
          spellCheck={false}
          placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
          aria-label="SSH private key"
          value={privateKey}
          disabled={busy}
          onChange={(event) => setPrivateKey(event.target.value)}
        />
        <textarea
          className="code-editor"
          rows={2}
          spellCheck={false}
          placeholder="ssh-ed25519 AAAA… comment"
          aria-label="SSH public key"
          value={publicKey}
          disabled={busy}
          onChange={(event) => setPublicKey(event.target.value)}
        />
        <div className="actions">
          <button
            className="button"
            disabled={busy || !privateKey.trim() || !publicKey.trim()}
            onClick={() =>
              void run(async () => {
                await saveSetting('container.ssh-key', {
                  privateKey: privateKey.trim(),
                  publicKey: publicKey.trim()
                });
                setPrivateKey('');
                setPublicKey('');
                onSaved();
                return undefined;
              })
            }
          >
            Save key pair
          </button>
        </div>
      </details>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

interface EnvRow {
  name: string;
  value: string;
  stored: boolean;
}

function EnvVarsSection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const storedNames = useMemo(
    () =>
      Array.isArray(setting?.value)
        ? (setting.value as { name: string }[]).map((entry) => entry.name)
        : [],
    [setting?.value]
  );
  const [rows, setRows] = useState<EnvRow[]>();
  const { busy, error, notice, run } = useSave();

  const current =
    rows ?? storedNames.map((name) => ({ name, value: '', stored: true }));

  const edit = (index: number, patch: Partial<EnvRow>) => {
    setRows(current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <section className="settings-section">
      <h2>Environment variables</h2>
      <p className="muted">
        Injected into every container — API tokens for whatever the agent works
        with (<code>CLOUDFLARE_API_TOKEN</code> for wrangler, and so on). Values
        are write-only: a blank value keeps what is stored.
      </p>
      {current.map((row, index) => (
        <div key={index} className="settings-row">
          <input
            type="text"
            placeholder="NAME"
            aria-label="Variable name"
            value={row.name}
            disabled={busy || row.stored}
            onChange={(event) => edit(index, { name: event.target.value })}
          />
          <input
            type="password"
            autoComplete="off"
            placeholder={row.stored ? 'Configured — blank keeps it' : 'value'}
            aria-label="Variable value"
            value={row.value}
            disabled={busy}
            onChange={(event) => edit(index, { value: event.target.value })}
          />
          <button
            className="icon-button"
            type="button"
            aria-label={`Remove ${row.name || 'variable'}`}
            disabled={busy}
            onClick={() => setRows(current.filter((_, at) => at !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() =>
            setRows([...current, { name: '', value: '', stored: false }])
          }
        >
          Add variable
        </button>
        <button
          className="button primary"
          disabled={busy || rows === undefined}
          onClick={() =>
            void run(async () => {
              const list = current
                .filter((row) => row.name.trim().length > 0)
                .map((row) => ({ name: row.name.trim(), value: row.value }));
              if (list.length === 0) {
                await saveSetting('container.env', null);
              } else {
                for (const entry of list) {
                  const row = current.find((candidate) => candidate.name.trim() === entry.name);
                  if (!row?.stored && entry.value === '') {
                    throw new Error(`"${entry.name}" needs a value`);
                  }
                }
                await saveSetting('container.env', list);
              }
              setRows(undefined);
              onSaved();
              return undefined;
            })
          }
        >
          Save variables
        </button>
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

/**
 * Catalog repositories as select options. A stored key the catalog no longer
 * lists must stay selectable, or opening the section would silently rewrite
 * the entry.
 */
function useRepoOptions(storedKeys: string[]) {
  const [catalogRepos, setCatalogRepos] = useState<RepoOption[]>();

  useEffect(() => {
    let cancelled = false;
    void fetchCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setCatalogRepos(catalog.repos);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const options = (catalogRepos ?? []).map((repo) => ({
      value: repo.repoKey,
      label: repo.displayName
    }));
    const known = new Set(options.map((option) => option.value));
    for (const key of storedKeys) {
      if (key && !known.has(key)) {
        options.push({ value: key, label: key });
      }
    }
    return options;
  }, [catalogRepos, storedKeys]);
}

interface SkillRow {
  name: string;
  /** Empty string means the skill applies to every repository. */
  repoKey: string;
  content: string;
}

function SkillsSection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const stored = useMemo(
    () =>
      Array.isArray(setting?.value)
        ? (setting.value as Partial<SkillRow>[]).map((row) => ({
            name: row.name ?? '',
            repoKey: row.repoKey ?? '',
            content: row.content ?? ''
          }))
        : [],
    [setting?.value]
  );
  const [rows, setRows] = useState<SkillRow[]>();
  const { busy, error, notice, run } = useSave();

  const current = rows ?? stored;
  const repoOptions = useRepoOptions(current.map((row) => row.repoKey));
  const edit = (index: number, patch: Partial<SkillRow>) => {
    setRows(current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <section className="settings-section">
      <h2>Skills</h2>
      <p className="muted">
        Each skill is one <code>SKILL.md</code> the agent can invoke inside its
        container. Names become directories: lowercase letters, digits and
        hyphens. A skill scoped to a repository is written only into that
        repository's sandboxes — still under the global skills directory, so
        the repository itself stays untouched.
      </p>
      {current.map((row, index) => (
        <div key={index} className="settings-skill">
          <div className="settings-row">
            <input
              type="text"
              placeholder="skill-name"
              aria-label="Skill name"
              value={row.name}
              disabled={busy}
              onChange={(event) => edit(index, { name: event.target.value })}
            />
            <select
              aria-label={`Repository for ${row.name || 'skill'}`}
              value={row.repoKey}
              disabled={busy}
              onChange={(event) => edit(index, { repoKey: event.target.value })}
            >
              <option value="">All repositories</option>
              {repoOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              type="button"
              aria-label={`Remove ${row.name || 'skill'}`}
              disabled={busy}
              onClick={() => setRows(current.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </div>
          <textarea
            className="code-editor"
            rows={8}
            spellCheck={false}
            placeholder={'---\nname: skill-name\ndescription: …\n---\n\nInstructions…'}
            aria-label={`SKILL.md for ${row.name || 'skill'}`}
            value={row.content}
            disabled={busy}
            onChange={(event) => edit(index, { content: event.target.value })}
          />
        </div>
      ))}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() =>
            setRows([...current, { name: '', repoKey: '', content: '' }])
          }
        >
          Add skill
        </button>
        <button
          className="button primary"
          disabled={busy || rows === undefined}
          onClick={() =>
            void run(async () => {
              const list = current
                .filter(
                  (row) =>
                    row.name.trim().length > 0 || row.content.trim().length > 0
                )
                .map((row) => ({
                  name: row.name,
                  content: row.content,
                  ...(row.repoKey.length > 0 ? { repoKey: row.repoKey } : {})
                }));
              await saveSetting('opencode.skills', list.length === 0 ? null : list);
              setRows(undefined);
              onSaved();
              return undefined;
            })
          }
        >
          Save skills
        </button>
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

interface AgentsMdRepoRow {
  repoKey: string;
  content: string;
}

function AgentsMdSection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const stored = setting?.value as
    | { global?: string; repos?: AgentsMdRepoRow[] }
    | undefined;
  const [global, setGlobal] = useState<string>();
  const [rows, setRows] = useState<AgentsMdRepoRow[]>();
  const { busy, error, notice, run } = useSave();

  const currentGlobal = global ?? stored?.global ?? '';
  const currentRows = rows ?? stored?.repos ?? [];
  const repoOptions = useRepoOptions(currentRows.map((row) => row.repoKey));

  const edit = (index: number, patch: Partial<AgentsMdRepoRow>) => {
    setRows(
      currentRows.map((row, at) => (at === index ? { ...row, ...patch } : row))
    );
  };

  // A freshly added row that was never touched does not block the save.
  const meaningfulRows = currentRows.filter(
    (row) => row.repoKey.length > 0 || row.content.trim().length > 0
  );
  const rowsComplete = meaningfulRows.every(
    (row) => row.repoKey.length > 0 && row.content.trim().length > 0
  );
  const empty =
    currentGlobal.trim().length === 0 && meaningfulRows.length === 0;

  return (
    <section className="settings-section">
      <h2>AGENTS.md</h2>
      <p className="muted">
        Standing instructions for the agent, without committing an{' '}
        <code>AGENTS.md</code> to the repository. The global content applies to
        every session; a per-repository addition is appended for sessions on
        that repository. The merged file lands in the container's global
        OpenCode config, alongside anything the repository itself carries.
      </p>
      <textarea
        className="code-editor"
        rows={10}
        spellCheck={false}
        placeholder="Instructions for every session…"
        aria-label="Global AGENTS.md content"
        value={currentGlobal}
        disabled={busy}
        onChange={(event) => setGlobal(event.target.value)}
      />
      <h3>Per-repository additions</h3>
      <p className="muted">
        Appended after the global content for sessions on the chosen
        repository.
      </p>
      {currentRows.map((row, index) => (
        <div key={index} className="settings-skill">
          <div className="settings-row">
            <select
              aria-label="Repository"
              value={row.repoKey}
              disabled={busy}
              onChange={(event) => edit(index, { repoKey: event.target.value })}
            >
              <option value="">Select a repository…</option>
              {repoOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              type="button"
              aria-label={`Remove the entry for ${row.repoKey || 'this repository'}`}
              disabled={busy}
              onClick={() => setRows(currentRows.filter((_, at) => at !== index))}
            >
              ×
            </button>
          </div>
          <textarea
            className="code-editor"
            rows={8}
            spellCheck={false}
            placeholder="Instructions for this repository…"
            aria-label={`AGENTS.md addition for ${row.repoKey || 'repository'}`}
            value={row.content}
            disabled={busy}
            onChange={(event) => edit(index, { content: event.target.value })}
          />
        </div>
      ))}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() =>
            setRows([...currentRows, { repoKey: '', content: '' }])
          }
        >
          Add repository
        </button>
        <button
          className="button primary"
          disabled={
            busy ||
            (global === undefined && rows === undefined) ||
            (!empty && !rowsComplete)
          }
          onClick={() =>
            void run(async () => {
              if (empty) {
                await saveSetting('opencode.agents-md', null);
              } else {
                const list = meaningfulRows.map((row) => ({
                  repoKey: row.repoKey,
                  content: row.content
                }));
                await saveSetting('opencode.agents-md', {
                  ...(currentGlobal.trim().length > 0
                    ? { global: currentGlobal }
                    : {}),
                  ...(list.length > 0 ? { repos: list } : {})
                });
              }
              setGlobal(undefined);
              setRows(undefined);
              onSaved();
              return undefined;
            })
          }
        >
          Save AGENTS.md
        </button>
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

interface IdentityOverrideRow {
  owner: string;
  name: string;
  email: string;
}

function GitIdentitySection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const storedIdentity = setting?.value as
    | { name?: string; email?: string; overrides?: IdentityOverrideRow[] }
    | undefined;
  const [name, setName] = useState<string>();
  const [email, setEmail] = useState<string>();
  const [overrides, setOverrides] = useState<IdentityOverrideRow[]>();
  const { busy, error, notice, run } = useSave();

  const currentName = name ?? storedIdentity?.name ?? '';
  const currentEmail = email ?? storedIdentity?.email ?? '';
  const currentOverrides = overrides ?? storedIdentity?.overrides ?? [];

  const editOverride = (index: number, patch: Partial<IdentityOverrideRow>) => {
    setOverrides(
      currentOverrides.map((row, at) =>
        at === index ? { ...row, ...patch } : row
      )
    );
  };

  const overridesComplete = currentOverrides.every(
    (row) =>
      row.owner.trim().length > 0 &&
      row.name.trim().length > 0 &&
      row.email.trim().length > 0
  );

  return (
    <section className="settings-section">
      <h2>Git identity</h2>
      <p className="muted">
        The author on every commit the agent makes. Without one, containers
        cannot commit.
      </p>
      <div className="settings-row">
        <input
          type="text"
          placeholder="Name"
          aria-label="Git author name"
          value={currentName}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          type="text"
          placeholder="email@example.com"
          aria-label="Git author email"
          value={currentEmail}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      <h3>Per-organization overrides</h3>
      <p className="muted">
        Repositories under a listed GitHub organization commit as that identity
        instead of the one above.
      </p>
      {currentOverrides.map((row, index) => (
        <div key={index} className="settings-row">
          <input
            type="text"
            placeholder="organization"
            aria-label="GitHub organization"
            value={row.owner}
            disabled={busy}
            onChange={(event) => editOverride(index, { owner: event.target.value })}
          />
          <input
            type="text"
            placeholder="Name"
            aria-label={`Author name for ${row.owner || 'organization'}`}
            value={row.name}
            disabled={busy}
            onChange={(event) => editOverride(index, { name: event.target.value })}
          />
          <input
            type="text"
            placeholder="email@example.com"
            aria-label={`Author email for ${row.owner || 'organization'}`}
            value={row.email}
            disabled={busy}
            onChange={(event) => editOverride(index, { email: event.target.value })}
          />
          <button
            className="icon-button"
            type="button"
            aria-label={`Remove the override for ${row.owner || 'this organization'}`}
            disabled={busy}
            onClick={() =>
              setOverrides(currentOverrides.filter((_, at) => at !== index))
            }
          >
            ×
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          className="button"
          type="button"
          disabled={busy}
          onClick={() =>
            setOverrides([
              ...currentOverrides,
              { owner: '', name: '', email: '' }
            ])
          }
        >
          Add override
        </button>
        <button
          className="button primary"
          disabled={
            busy ||
            !currentName.trim() ||
            !currentEmail.trim() ||
            !overridesComplete
          }
          onClick={() =>
            void run(async () => {
              const list = currentOverrides.map((row) => ({
                owner: row.owner.trim(),
                name: row.name.trim(),
                email: row.email.trim()
              }));
              await saveSetting('git.identity', {
                name: currentName.trim(),
                email: currentEmail.trim(),
                ...(list.length > 0 ? { overrides: list } : {})
              });
              setOverrides(undefined);
              onSaved();
              return undefined;
            })
          }
        >
          Save identity
        </button>
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

/** The image the agent falls back to when `docker.image` is unset. */
const DEFAULT_DOCKER_IMAGE = 'opencode-session:latest';

/**
 * The second sandbox host, which is opt-in.
 *
 * Three settings rather than one, because the token is a secret and never reads
 * back, so it cannot share an object with the two that do. Storing the URL and
 * the token is what puts Docker in the composer's picker — the image is
 * optional and only names something other than the default.
 *
 * Clearing this while Docker sessions exist strands them: deleting one goes out
 * over the agent, and there would be no agent to ask. Delete the sessions
 * first, which is what the warning below says.
 */
function DockerSection({
  url,
  token,
  image,
  onSaved
}: {
  url?: SettingView;
  token?: SettingView;
  image?: SettingView;
  onSaved: () => void;
}) {
  const storedUrl = typeof url?.value === 'string' ? url.value : '';
  const storedImage = typeof image?.value === 'string' ? image.value : '';
  const [urlText, setUrlText] = useState<string>();
  const [tokenText, setTokenText] = useState('');
  const [imageText, setImageText] = useState<string>();
  const { busy, error, notice, run } = useSave();

  const currentUrl = urlText ?? storedUrl;
  const currentImage = imageText ?? storedImage;
  const configured = Boolean(url?.configured && token?.configured);

  return (
    <section className="settings-section">
      <h2>Docker host</h2>
      <p className="muted">
        A machine of your own running the sandbox agent. Once the URL and token
        are stored it becomes the default host for new sessions (Cloudflare
        stays available in the picker). Workspaces live on named volumes
        instead of snapshots, so a container can be replaced without losing the
        checkout.
      </p>
      <input
        type="text"
        placeholder="https://agent.example.com"
        aria-label="Docker agent URL"
        value={currentUrl}
        disabled={busy}
        onChange={(event) => setUrlText(event.target.value)}
      />
      <input
        type="password"
        autoComplete="off"
        placeholder={configuredHint(token)}
        aria-label="Docker agent token"
        value={tokenText}
        disabled={busy}
        onChange={(event) => setTokenText(event.target.value)}
      />
      <input
        type="text"
        placeholder={`Session image (default ${DEFAULT_DOCKER_IMAGE})`}
        aria-label="Docker session image"
        value={currentImage}
        disabled={busy}
        onChange={(event) => setImageText(event.target.value)}
      />
      <p className="muted">
        {configured
          ? 'Configured. Clearing the URL turns the provider off — delete any Docker sessions first, or they cannot be deleted at all.'
          : 'Both the URL and a token are needed before Docker is offered.'}
      </p>
      <div className="actions">
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const nextUrl = currentUrl.trim();
              const nextImage = currentImage.trim();
              // A cleared field is `null`, which is how an optional setting is
              // removed; the token is the exception — it never reads back, so
              // an empty box means "leave it alone" rather than "clear it".
              await saveSetting('docker.agent-url', nextUrl || null);
              if (tokenText.trim()) {
                await saveSetting('docker.agent-token', tokenText.trim());
              }
              await saveSetting('docker.image', nextImage || null);
              setTokenText('');
              setUrlText(undefined);
              setImageText(undefined);
              onSaved();
              return undefined;
            })
          }
        >
          Save Docker host
        </button>
        {token?.configured ? (
          <button
            className="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await saveSetting('docker.agent-token', null);
                onSaved();
                return 'Token cleared';
              })
            }
          >
            Clear token
          </button>
        ) : null}
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { busy, error, notice, run } = useSave();

  const ready =
    current.length > 0 && next.length >= 8 && confirmation === next;

  return (
    <section className="settings-section">
      <h2>Admin password</h2>
      <p className="muted">
        Changing it signs out every browser, including the others you are
        signed in on; this one stays.
      </p>
      <input
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        aria-label="Current password"
        value={current}
        disabled={busy}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password (at least 8 characters)"
        aria-label="New password"
        value={next}
        disabled={busy}
        onChange={(event) => setNext(event.target.value)}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Repeat the new password"
        aria-label="Repeat the new password"
        value={confirmation}
        disabled={busy}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <div className="actions">
        <button
          className="button primary"
          disabled={busy || !ready}
          onClick={() =>
            void run(async () => {
              await changePassword(current, next);
              setCurrent('');
              setNext('');
              setConfirmation('');
              return 'Password changed';
            })
          }
        >
          Change password
        </button>
      </div>
      <SectionStatus error={error} notice={notice} />
    </section>
  );
}
