import { useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

/**
 * Copy some text, and say so.
 *
 * The clipboard gives no feedback of its own, so the tick is the whole point:
 * it holds for a couple of seconds and then the button goes back to offering
 * the action rather than reporting it. The timer is cleared on unmount because
 * a message can scroll out of the list while the tick is still showing.
 *
 * `navigator.clipboard` is absent on insecure origins; there the click is a
 * no-op rather than an error, and the button simply never confirms.
 */
export function CopyButton({ text, label = 'Copy message' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className="icon-button copy-button"
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(text);
        } catch {
          return;
        }
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
