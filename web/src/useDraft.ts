import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * An unsent composer draft.
 *
 * Every page in the shell is mounted exclusively — opening the settings, the
 * new-session page or another conversation unmounts the one before it, and
 * `SessionPage` is keyed to the session id so even switching back and forth
 * remounts it. Half a typed prompt therefore died on every navigation, which is
 * a data loss the user caused by clicking somewhere and cannot undo.
 *
 * So the text lives in `localStorage` under a per-composer key, the same way
 * the panel widths and the sidebar fold do: written as it is typed, read back
 * on mount, removed the moment the box is empty — which is exactly what
 * sending does, since a sent prompt clears the composer.
 *
 * It is deliberately not sessionStorage. A draft that survives the tab being
 * closed is the case that matters most, and a draft is scoped to its session
 * anyway, not to the tab that happened to type it.
 */
export function useDraft(key: string) {
  const storageKey = `${PREFIX}${key}`;
  const [text, setText] = useState(() => read(storageKey));
  // What storage already holds, so a remount does not rewrite the same string
  // and push the entry's age forward for nothing.
  const written = useRef(text);

  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => {
      setText((current) => {
        const next = typeof value === 'function' ? value(current) : value;
        if (written.current !== next) {
          written.current = next;
          write(storageKey, next);
        }
        return next;
      });
    },
    [storageKey]
  );

  // Switching composers under one mount (which nothing does today, but the key
  // is a prop) must show that composer's draft, not the previous one's.
  const previousKey = useRef(storageKey);
  useEffect(() => {
    if (previousKey.current === storageKey) {
      return;
    }
    previousKey.current = storageKey;
    const stored = read(storageKey);
    written.current = stored;
    setText(stored);
  }, [storageKey]);

  return [text, setDraft] as const;
}

const PREFIX = 'hub.draft.';

/**
 * How long an untouched draft is kept. Sessions are many and drafts are
 * abandoned silently, so without this the keys would only ever accumulate —
 * there is no event anywhere that says "this one is never coming back".
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function read(storageKey: string) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return '';
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { text?: unknown }).text === 'string'
    ) {
      return (parsed as { text: string }).text;
    }
  } catch {
    // Unavailable or unparseable storage is an empty composer, not an error.
  }
  return '';
}

function write(storageKey: string, text: string) {
  try {
    if (text) {
      localStorage.setItem(storageKey, JSON.stringify({ text, at: Date.now() }));
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch {
    // A browser that refuses storage still composes; it just forgets.
  }
}

/** Drop drafts nobody has come back to. Called once, when the shell loads. */
export function pruneDrafts(now = Date.now()) {
  try {
    const stale: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(PREFIX)) {
        continue;
      }
      let at = 0;
      try {
        at = Number(JSON.parse(localStorage.getItem(key) ?? '{}').at) || 0;
      } catch {
        // A malformed entry is not a draft anyone can recover; treat it as stale.
      }
      if (now - at > MAX_AGE_MS) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      localStorage.removeItem(key);
    }
  } catch {
    // Nothing to prune if there is no storage to read.
  }
}
