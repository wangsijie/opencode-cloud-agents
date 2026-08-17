import { useEffect } from 'react';
import { isDockerProvider, type SessionView } from '../api';
import {
  formatDuration,
  formatIdleShutdown,
  formatTime,
  formatUsage,
  STATUS_LABELS
} from '../format';
import { CloseIcon } from './icons';
import { providerLabel } from './ProviderSelect';

/**
 * What the container has been doing, behind the status badge.
 *
 * The tally and the cold-start number used to be a line of small print above
 * the details panel, where they cost a permanent row of the sidebar to answer a
 * question that is asked once in a while. The badge already names the state, so
 * it is the natural thing to press for the numbers behind it — and a modal has
 * room to break the wake into its stages instead of hiding them in a `title`
 * attribute no touch device can reach.
 */
export function InstanceModal({
  session,
  onClose
}: {
  session: SessionView;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);

  const usage =
    session.transcript?.usage && session.transcript.usage.assistantMessages > 0
      ? session.transcript.usage
      : undefined;
  const wake = session.instance.runtime.lastWake;
  // The one thing a reader has to know about the host: what happens to the
  // workspace when the container stops. Cloudflare containers are ephemeral and
  // the workspace survives as a snapshot taken at idle; the Docker agent keeps
  // it on a named volume that outlives every container it runs.
  const snapshots = !isDockerProvider(session.provider);

  return (
    <div className="modal-layer">
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close instance details"
        onClick={onClose}
      />
      {/* A sheet on a phone, a centred card above that — the stylesheet does
          the switch; this is one box either way. */}
      <div
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Instance details"
      >
        <header className="modal-header">
          <h2>{STATUS_LABELS[session.status]}</h2>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="modal-body">
          <dl className="meta-list">
            <dt>Container</dt>
            <dd className="mono">{session.instance.runtime.lifecycle}</dd>
            <dt>Shuts down</dt>
            <dd>{formatIdleShutdown(session)}</dd>
            <dt>Sandbox</dt>
            <dd>{providerLabel(session.provider)}</dd>
            <dt>Workspace</dt>
            <dd>
              {snapshots
                ? 'Snapshotted when the container sleeps'
                : 'Kept on a named volume between containers'}
            </dd>
          </dl>

          {/*
            Cache reads sit inside the input total the way the one-line summary
            counted them, and the cost is OpenCode's own figure rather than
            anything re-priced here.
          */}
          <section>
            <h3>Usage</h3>
            {usage ? (
              <>
                <p className="mono">{formatUsage(usage)}</p>
                <dl className="meta-list">
                  <dt>Replies</dt>
                  <dd className="mono">{usage.assistantMessages}</dd>
                  <dt>Cache written</dt>
                  <dd className="mono">
                    {usage.cacheWriteTokens.toLocaleString()} tokens
                  </dd>
                </dl>
              </>
            ) : (
              <p className="muted">No assistant replies yet.</p>
            )}
          </section>

          {/*
            Only cold wakes are reported: a server restart on a live container
            is a different number, and averaging the two flatters the wait a
            person actually sits through.
          */}
          <section>
            <h3>Last cold wake</h3>
            {wake?.cold ? (
              <>
                <p className="mono">
                  {formatDuration(wake.totalMs)}
                  <span className="muted">{` · ${formatTime(wake.at)}`}</span>
                </p>
                <dl className="meta-list">
                  {wake.restoreMs !== undefined ? (
                    <>
                      <dt>{snapshots ? 'Container + snapshot' : 'Container start'}</dt>
                      <dd className="mono">{formatDuration(wake.restoreMs)}</dd>
                    </>
                  ) : null}
                  {/*
                    These two overlap — the clone or fetch runs alongside the
                    server start — so they do not sum to the total, and the
                    labels say so rather than reading as a broken sum.
                  */}
                  {wake.repoMs !== undefined ? (
                    <>
                      <dt>Repo provisioning ∥</dt>
                      <dd className="mono">{formatDuration(wake.repoMs)}</dd>
                    </>
                  ) : null}
                  {wake.serverMs !== undefined ? (
                    <>
                      <dt>OpenCode startup ∥</dt>
                      <dd className="mono">{formatDuration(wake.serverMs)}</dd>
                    </>
                  ) : null}
                </dl>
              </>
            ) : (
              <p className="muted">This container has not come back cold yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
