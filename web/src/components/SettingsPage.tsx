import { useEffect, useMemo, useState } from 'react';
import {
  changePassword,
  fetchSettings,
  generateSshKey,
  saveSetting,
  type SettingView
} from '../api';
import { MenuIcon } from './icons';

/**
 * Every runtime setting in one place: the credentials and configuration that
 * used to be baked into the code and the container image.
 *
 * Secrets are write-only — the page shows whether one is stored and never what
 * it is; typing a new value replaces it, leaving the field empty keeps it. The
 * two readable exceptions are the OpenCode config (a JSON editor cannot edit
 * what it cannot read) and the SSH public key (it exists to be pasted into
 * GitHub).
 *
 * In `forced` mode the page is the whole app: required settings are missing,
 * so nothing else can run yet. Each save calls `onSettingsChanged`, and the
 * app re-checks whether the gate can open.
 */
export function SettingsPage({
  forced,
  onMenu,
  onSettingsChanged
}: {
  forced: boolean;
  onMenu?: () => void;
  onSettingsChanged: () => void;
}) {
  const [settings, setSettings] = useState<SettingView[]>();
  const [loadError, setLoadError] = useState<string>();

  const load = async () => {
    try {
      setSettings((await fetchSettings()).settings);
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
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
  const missing = (settings ?? []).filter(
    (setting) => setting.required && !setting.configured
  );

  const saved = () => {
    void load();
    onSettingsChanged();
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

          {forced && settings ? (
            <section className="card error">
              <h2>Finish setting up</h2>
              <p className="muted">
                The Hub cannot run until these are configured:{' '}
                {missing.map((setting) => setting.label).join(', ') || '…'}
              </p>
            </section>
          ) : null}

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
            <>
              <GithubTokenSection setting={byKey.get('github.token')} onSaved={saved} />
              <OpencodeConfigSection
                setting={byKey.get('opencode.config')}
                onSaved={saved}
              />
              <SshKeySection setting={byKey.get('container.ssh-key')} onSaved={saved} />
              <EnvVarsSection setting={byKey.get('container.env')} onSaved={saved} />
              <SkillsSection setting={byKey.get('opencode.skills')} onSaved={saved} />
              <GitIdentitySection setting={byKey.get('git.identity')} onSaved={saved} />
              <PasswordSection />
            </>
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
    <section className="card settings-section">
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
    <section className="card settings-section">
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
    <section className="card settings-section">
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
    <section className="card settings-section">
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

interface SkillRow {
  name: string;
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
      Array.isArray(setting?.value) ? (setting.value as SkillRow[]) : [],
    [setting?.value]
  );
  const [rows, setRows] = useState<SkillRow[]>();
  const { busy, error, notice, run } = useSave();

  const current = rows ?? stored;
  const edit = (index: number, patch: Partial<SkillRow>) => {
    setRows(current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };

  return (
    <section className="card settings-section">
      <h2>Skills</h2>
      <p className="muted">
        Each skill is one <code>SKILL.md</code> the agent can invoke inside its
        container. Names become directories: lowercase letters, digits and
        hyphens.
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
          onClick={() => setRows([...current, { name: '', content: '' }])}
        >
          Add skill
        </button>
        <button
          className="button primary"
          disabled={busy || rows === undefined}
          onClick={() =>
            void run(async () => {
              const list = current.filter(
                (row) => row.name.trim().length > 0 || row.content.trim().length > 0
              );
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

function GitIdentitySection({
  setting,
  onSaved
}: {
  setting?: SettingView;
  onSaved: () => void;
}) {
  const storedIdentity = setting?.value as
    | { name?: string; email?: string }
    | undefined;
  const [name, setName] = useState<string>();
  const [email, setEmail] = useState<string>();
  const { busy, error, notice, run } = useSave();

  const currentName = name ?? storedIdentity?.name ?? '';
  const currentEmail = email ?? storedIdentity?.email ?? '';

  return (
    <section className="card settings-section">
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
      <div className="actions">
        <button
          className="button primary"
          disabled={busy || !currentName.trim() || !currentEmail.trim()}
          onClick={() =>
            void run(async () => {
              await saveSetting('git.identity', {
                name: currentName.trim(),
                email: currentEmail.trim()
              });
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

function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { busy, error, notice, run } = useSave();

  const ready =
    current.length > 0 && next.length >= 8 && confirmation === next;

  return (
    <section className="card settings-section">
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
