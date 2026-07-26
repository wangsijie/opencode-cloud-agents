import { useState } from 'react';
import type { SessionView } from '../api';
import { describeWakeStages, formatDuration, formatUsage } from '../format';
import { ChangesPanel } from './ChangesPanel';
import { CloseIcon } from './icons';
import { WorkspacePanel } from './WorkspacePanel';

type Tab = 'changes' | 'workspace';

/**
 * Everything about the session that is not the conversation.
 *
 * The changes, the container's files and shell, and the running cost all used
 * to sit above the transcript, where they pushed the first message down the
 * page and turned a read into a scroll. Here they are one panel the reader
 * opens when they want it, which leaves the main column as messages and nothing
 * else.
 *
 * Only the chosen tab is mounted: each one talks to the container, and a
 * background tab quietly holding a terminal open — or re-reading a diff on
 * every poll — is exactly the cost the collapse is there to avoid.
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

  const usage =
    session.transcript?.usage && session.transcript.usage.assistantMessages > 0
      ? formatUsage(session.transcript.usage)
      : undefined;
  const lastWake = session.instance.runtime.lastWake;

  return (
    <aside className="session-aside" aria-label="Session details">
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
          <ChangesPanel
            sessionId={session.id}
            attached={attached}
            sessionTitle={session.title}
          />
        ) : (
          <WorkspacePanel
            sessionId={session.id}
            attached={attached}
            directory={session.directory ?? `/workspace/${session.repoKey}`}
          />
        )}
      </div>
    </aside>
  );
}
