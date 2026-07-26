import { lazy, Suspense, useState } from 'react';
import { FileBrowser } from './FileBrowser';

// xterm is the one heavy dependency in this app, and most visits to a session
// never open a terminal. Loading it only when the tab is chosen keeps it out of
// the entry bundle the conversation waits on.
const TerminalView = lazy(() =>
  import('./TerminalView').then((module) => ({ default: module.TerminalView }))
);

type Tab = 'files' | 'terminal';

/**
 * The container itself: its files and a shell.
 *
 * These were the last two things the stock OpenCode IDE could do and this app
 * could not, which is what its retirement was waiting on. Both need the
 * container up and neither wakes it — a sleeping session says so instead.
 *
 * It is a tab in the details sidebar, which is collapsed by default: opening it
 * is the request, and a session page that listed files on every poll would run
 * container commands for a user who came to read a conversation.
 */
export function WorkspacePanel({
  sessionId,
  attached,
  directory
}: {
  sessionId: string;
  attached: boolean;
  directory: string;
}) {
  const [tab, setTab] = useState<Tab>('files');

  return (
    <section className="workspace-panel">
      {attached ? (
        <header className="changes-header">
          <div className="workspace-tabs" role="tablist">
            <button
              className={`link-button${tab === 'files' ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={tab === 'files'}
              onClick={() => setTab('files')}
            >
              Files
            </button>
            <button
              className={`link-button${tab === 'terminal' ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={tab === 'terminal'}
              onClick={() => setTab('terminal')}
            >
              Terminal
            </button>
          </div>
        </header>
      ) : null}

      {!attached ? (
        <p className="muted">
          This session is asleep. Send a message to wake the container, then you
          can browse files or open a terminal.
        </p>
      ) : tab === 'files' ? (
        <FileBrowser sessionId={sessionId} />
      ) : (
        <Suspense fallback={<p className="muted">Loading the terminal…</p>}>
          <TerminalView sessionId={sessionId} cwd={directory} />
        </Suspense>
      )}
    </section>
  );
}
