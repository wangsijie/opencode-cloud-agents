import { SandboxAddon } from '@cloudflare/sandbox/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { keepSessionAwake, terminalSocketUrl } from '../api';

/** How often an attached terminal renews its work lease. Leases last 90s. */
const KEEPALIVE_INTERVAL_MS = 45_000;

/**
 * A shell in the session's container.
 *
 * The socket is the Sandbox SDK's own PTY passthrough, proxied by the Worker on
 * the Hub's origin — which is what lets the container gateway stop being public
 * at all. `SandboxAddon` is the client half of that protocol (raw bytes up,
 * terminal output down, JSON control frames for resize and readiness) plus
 * reconnect, so nothing here re-implements it.
 *
 * The keepalive is the part that is ours. A shell running a test suite is
 * invisible to the idle probe, which only watches OpenCode's execution state,
 * so an attached terminal renews a work lease on a timer. Nothing releases the
 * lease explicitly: a closed tab simply stops renewing, and the container
 * returns to its ordinary ten-minute idle window.
 */
export function TerminalView({ sessionId, cwd }: { sessionId: string; cwd: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'connecting' | 'connected' | 'disconnected'>(
    'connecting'
  );
  const [error, setError] = useState<string>();

  useEffect(() => {
    const node = host.current;
    if (!node) {
      return;
    }
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      // Dark in both themes: shell colours are written for a dark background,
      // and xterm fixes its palette here rather than reading it from CSS.
      theme: { background: '#1f1e1d', foreground: '#f5f4ef', cursor: '#f92040' }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);

    let started = false;
    const sandbox = new SandboxAddon({
      getWebSocketUrl: ({ origin }) => terminalSocketUrl(sessionId, origin),
      onStateChange: (next, cause) => {
        setState(next);
        setError(cause?.message);
        if (next === 'connected' && !started) {
          // The PTY starts in the container's default directory, and its
          // options carry no working directory. Landing in the checkout is
          // worth one typed command; doing it once keeps a reconnect from
          // scrolling the same line into an active session.
          started = true;
          terminal.paste(`cd ${JSON.stringify(cwd)} && clear\n`);
        }
      }
    });
    terminal.loadAddon(sandbox);
    terminal.open(node);
    fit.fit();
    sandbox.connect({ sandboxId: sessionId });

    const refit = () => {
      try {
        fit.fit();
      } catch {
        // A panel being collapsed mid-measure is not worth an error.
      }
    };
    addEventListener('resize', refit);

    // The lease is taken as soon as the panel opens rather than on first
    // keystroke: opening a terminal on a container with two minutes left on its
    // idle clock should not lose it while the user reads the prompt.
    const hold = () => {
      void keepSessionAwake(sessionId).catch(() => undefined);
    };
    hold();
    const keepalive = setInterval(hold, KEEPALIVE_INTERVAL_MS);

    return () => {
      clearInterval(keepalive);
      removeEventListener('resize', refit);
      sandbox.dispose();
      terminal.dispose();
    };
  }, [sessionId, cwd]);

  return (
    <div className="terminal-view">
      <div className="terminal-status muted">
        {state === 'connected'
          ? 'connected'
          : state === 'connecting'
            ? 'connecting…'
            : 'disconnected, reconnecting…'}
        {error ? ` · ${error}` : ''}
      </div>
      <div className="terminal-host" ref={host} />
    </div>
  );
}
