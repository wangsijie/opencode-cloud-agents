import { useState } from 'react';
import {
  deleteSession,
  patchSession,
  retrySession,
  stopInstance,
  type SessionView
} from '../api';
import { formatIdleShutdown, formatRelative, formatUsage } from '../format';
import { navigate, sessionPath } from '../router';
import { StatusBadge } from './StatusBadge';

const RUNNING_CONTAINERS = ['running', 'healthy'];

export function SessionCard({
  session,
  onChanged,
  onError
}: {
  session: SessionView;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string>();
  const ready = session.instance.lifecycle === 'ready';
  const running = RUNNING_CONTAINERS.includes(session.instance.runtime.container);

  async function run(label: string, work: () => Promise<unknown>) {
    if (busy) {
      return;
    }
    setBusy(label);
    try {
      await work();
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
      await onChanged();
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <article className="card session">
      <header className="session-head">
        <div className="session-identity">
          <h3>
            <a
              href={sessionPath(session.id)}
              onClick={(event) => {
                // Keep modifier-clicks and middle-clicks behaving like links.
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                  return;
                }
                event.preventDefault();
                navigate(sessionPath(session.id));
              }}
            >
              {session.displayTitle}
            </a>
          </h3>
          <p className="muted mono">{session.id}</p>
        </div>
        <StatusBadge status={session.status} />
      </header>

      <dl className="session-meta">
        <div>
          <dt>Repo</dt>
          <dd className="mono">/workspace/{session.repoKey}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono">{session.model}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatRelative(session.lastActivityAt)}</dd>
        </div>
        <div>
          <dt>Auto sleep</dt>
          <dd>{formatIdleShutdown(session)}</dd>
        </div>
        {/*
          A sleeping session is the case where the mirror is the whole story, so
          that is where its summary is worth the row: it says the history is
          there to read without waking anything. While the container runs the
          same number would just be a stale copy of what the page already shows.
        */}
        {session.status === 'sleeping' && session.transcript ? (
          <div>
            <dt>Mirror</dt>
            <dd>
              {session.transcript.messageCount} messages ·{' '}
              {formatRelative(session.transcript.mirroredAt)}
            </dd>
          </div>
        ) : null}
        {/*
          Usage comes from the mirror, which the container now refreshes within
          seconds of each turn — so this is current whether the session is awake
          or asleep, and costs no contact with the container either way.
        */}
        {session.transcript?.usage &&
        session.transcript.usage.assistantMessages > 0 ? (
          <div>
            <dt>Usage</dt>
            <dd>{formatUsage(session.transcript.usage)}</dd>
          </div>
        ) : null}
      </dl>

      {session.lastError ? <p className="session-error">{session.lastError}</p> : null}

      <div className="actions">
        {/*
          The conversation is the session now — there is no second place to
          open. Waking is not this button's job either: the session page sends
          a message to a sleeping container and shows the wake as progress.
        */}
        <button
          className="button primary"
          disabled={Boolean(busy)}
          onClick={() => navigate(sessionPath(session.id))}
        >
          Open session
        </button>
        {session.phase === 'failed' ? (
          <button
            className="button"
            disabled={Boolean(busy)}
            onClick={() => run('retry', () => retrySession(session.id))}
          >
            Retry start
          </button>
        ) : null}
        {ready && running ? (
          <button
            className="button"
            disabled={Boolean(busy)}
            onClick={() => run('stop', () => stopInstance(session.instance.id))}
          >
            Stop
          </button>
        ) : null}
        <button
          className="button"
          disabled={Boolean(busy)}
          onClick={() =>
            run('archive', () =>
              patchSession(session.id, { archived: !session.archivedAt })
            )
          }
        >
          {session.archivedAt ? 'Unarchive' : 'Archive'}
        </button>
        <button
          className="button danger"
          disabled={Boolean(busy)}
          onClick={() => {
            if (
              confirm(
                `Delete session "${session.displayTitle}"? The container and its snapshot go with it, and this cannot be undone. Archiving only hides it from the list — that is a different thing.`
              )
            ) {
              void run('delete', () => deleteSession(session.id));
            }
          }}
        >
          Delete
        </button>
      </div>
    </article>
  );
}
