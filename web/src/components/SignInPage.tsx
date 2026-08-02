import { useState, type FormEvent } from 'react';
import { signIn } from '../api';
import { SparkIcon } from './icons';

/**
 * The whole app behind one password.
 *
 * This replaces the app rather than covering it, so nothing underneath mounts
 * and nothing polls: a signed-out browser makes exactly one request, the one
 * that asks whether it is signed out.
 */
export function SignInPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await signIn(password);
      onSignedIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sign-in">
      <form className="sign-in-form" onSubmit={submit} aria-busy={busy}>
        <h1 className="greeting">
          <SparkIcon />
          Cloud Agents
        </h1>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          // The form is the only thing on screen, so the caret belongs in it.
          autoFocus
          placeholder="Admin password"
          aria-label="Admin password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          className="button primary"
          type="submit"
          disabled={busy || !password}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error ? <p className="form-error">{error}</p> : null}
      </form>
    </div>
  );
}
