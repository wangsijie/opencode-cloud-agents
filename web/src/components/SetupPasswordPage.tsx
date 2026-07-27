import { useState, type FormEvent } from 'react';
import { setupPassword } from '../api';
import { SparkIcon } from './icons';

/**
 * First run: no admin password exists yet, so nothing else may until one does.
 *
 * Like the sign-in page this replaces the app rather than covering it. The
 * generated option shows the password exactly once and makes the operator say
 * they saved it — there is no recovery path other than editing the database.
 */
export function SetupPasswordPage({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = !generated && confirm.length > 0 && confirm !== password;
  const ready =
    password.length >= 8 && (generated ? saved : confirm === password);

  function generate() {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = new Uint32Array(20);
    crypto.getRandomValues(bytes);
    const characters = [...bytes].map((value) => alphabet[value % alphabet.length]);
    const words = [0, 5, 10, 15].map((start) =>
      characters.slice(start, start + 5).join('')
    );
    setPassword(words.join('-'));
    setConfirm('');
    setGenerated(true);
    setSaved(false);
    setCopied(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await setupPassword(password);
      onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sign-in">
      <form className="sign-in-form" onSubmit={submit} aria-busy={busy}>
        <h1 className="greeting">
          <SparkIcon />
          Welcome to OpenCode Hub
        </h1>
        <p className="muted">
          This deployment has no admin password yet. Choose one now — it is the
          only credential the Hub has.
        </p>

        {generated ? (
          <>
            {/* Shown once, in the clear: it will never be readable again. */}
            <output className="generated-password">{password}</output>
            <div className="actions">
              <button
                className="button"
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(password)
                    .then(() => setCopied(true))
                    .catch(() => undefined);
                }}
              >
                {copied ? 'Copied' : 'Copy password'}
              </button>
              <button className="link-button" type="button" onClick={generate}>
                Generate another
              </button>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I have saved this password somewhere safe
            </label>
          </>
        ) : (
          <>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              autoFocus
              placeholder="New admin password (at least 8 characters)"
              aria-label="New admin password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              placeholder="Repeat the password"
              aria-label="Repeat the password"
              value={confirm}
              disabled={busy}
              onChange={(event) => setConfirm(event.target.value)}
            />
            <button className="link-button" type="button" onClick={generate}>
              Generate one for me
            </button>
          </>
        )}

        <button className="button primary" type="submit" disabled={busy || !ready}>
          {busy ? 'Setting up…' : 'Set password and continue'}
        </button>
        {tooShort ? (
          <p className="form-error">The password must be at least 8 characters</p>
        ) : mismatch ? (
          <p className="form-error">The passwords do not match</p>
        ) : error ? (
          <p className="form-error">{error}</p>
        ) : null}
      </form>
    </div>
  );
}
