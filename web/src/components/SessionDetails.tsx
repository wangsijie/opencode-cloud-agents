import { lazy, Suspense, useState, type CSSProperties } from 'react';
import type { SessionView } from '../api';
import { describeWakeStages, formatDuration, formatUsage } from '../format';
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
  const [tab, setTab] = useState<Tab>('changes');
  const { width, handleProps } = useResizable({
    storageKey: 'hub.asideWidth',
    fallback: 380,
    min: 280,
    max: 760,
    edge: 'start'
  });

  const usage =
    session.transcript?.usage && session.transcript.usage.assistantMessages > 0
      ? formatUsage(session.transcript.usage)
      : undefined;
  const lastWake = session.instance.runtime.lastWake;

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
          <button
            className={`link-button${tab === 'changes' ? ' active' : ''}`}
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            onClick={() => setTab('changes')}
          >
            Changes
          </button>
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
        The tally is about the session rather than either tab, so it sits above
        both. The cold start is the one wait with no progress to show beyond a
        spinner, so the last one's cost is stated rather than left to memory —
        and only cold wakes are reported, because a server restart on a live
        container is a different number and would flatter the average.
      */}
      {usage || lastWake?.cold ? (
        <p className="muted mono aside-meta">
          {usage ?? ''}
          {usage && lastWake?.cold ? ' · ' : ''}
          {lastWake?.cold ? (
            <span title={describeWakeStages(lastWake)}>
              {`last wake ${formatDuration(lastWake.totalMs)}`}
            </span>
          ) : null}
        </p>
      ) : null}

      <div className="aside-body">
        {tab === 'changes' ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ChangesPanel sessionId={session.id} attached={attached} />
          </Suspense>
        ) : (
          <WorkspacePanel sessionId={session.id} attached={attached} />
        )}
      </div>
    </aside>
  );
}
