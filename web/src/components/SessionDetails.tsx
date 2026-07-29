import { lazy, Suspense, useState, type CSSProperties } from 'react';
import type { SessionView } from '../api';
import { useResizable } from '../useResizable';
import { CloseIcon } from './icons';
import { WorkspacePanel } from './WorkspacePanel';

// The diff viewer carries a syntax highlighter for every language, which is
// most of a session page's weight for a tab most visits never open. Splitting
// it out means the conversation loads without it.
const ChangesPanel = lazy(() =>
  import('./ChangesPanel').then((m) => ({ default: m.ChangesPanel }))
);

type Tab = 'changes' | 'workspace';

/**
 * Everything about the session that is not the conversation.
 *
 * The changes, the container's files, and the running cost all used to sit
 * above the transcript, where they pushed the first message down the page and
 * turned a read into a scroll. Here they are one panel the reader opens when
 * they want it, which leaves the main column as messages and nothing else.
 *
 * Only the chosen tab is mounted: each one talks to the container, and a
 * background tab re-reading a diff on every poll is exactly the cost the
 * collapse is there to avoid.
 *
 * A session created without a repository has no diff at all, so it gets the
 * workspace alone rather than a Changes tab that can only report the absence.
 */
export function SessionDetails({
  session,
  attached,
  onClose
}: {
  session: SessionView;
  attached: boolean;
  onClose: () => void;
}) {
  const cleaned = session.status === 'cleaned';
  const hasChanges = Boolean(session.repoKey);
  const [tab, setTab] = useState<Tab>(hasChanges ? 'changes' : 'workspace');
  const { width, handleProps } = useResizable({
    storageKey: 'hub.asideWidth',
    fallback: 380,
    min: 280,
    max: 760,
    edge: 'start'
  });

  return (
    <aside
      className="session-aside"
      aria-label="Session details"
      style={{ '--aside-width': `${width}px` } as CSSProperties}
    >
      {/* Docked only above 1100px; below that the panel is an overlay sized
          against the viewport, and the stylesheet hides this. */}
      <div
        className="resize-handle start"
        aria-label="Resize details"
        {...handleProps}
      />
      <header className="aside-header">
        <div className="aside-tabs" role="tablist">
          {hasChanges ? (
            <button
              className={`link-button${tab === 'changes' ? ' active' : ''}`}
              type="button"
              role="tab"
              aria-selected={tab === 'changes'}
              onClick={() => setTab('changes')}
            >
              Changes
            </button>
          ) : null}
          <button
            className={`link-button${tab === 'workspace' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === 'workspace'}
            onClick={() => setTab('workspace')}
          >
            Workspace
          </button>
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label="Close details"
        >
          <CloseIcon />
        </button>
      </header>

      {/*
        The token tally and the cold-start number used to sit here, as a line of
        small print between the tabs and their content. They are about the
        instance rather than either tab, and they are read occasionally rather
        than watched — so they moved behind the status badge in the header,
        where a modal has room to show the wake's stages too.
      */}

      <div className="aside-body">
        {hasChanges && tab === 'changes' ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ChangesPanel
              sessionId={session.id}
              attached={attached}
              cleaned={cleaned}
            />
          </Suspense>
        ) : (
          <WorkspacePanel
            sessionId={session.id}
            attached={attached}
            cleaned={cleaned}
          />
        )}
      </div>
    </aside>
  );
}
