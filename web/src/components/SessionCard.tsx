import { useState } from 'react';
import {
  deleteSession,
  retrySession,
  stopInstance,
  wakeInstance,
  type SessionView
} from '../api';
import { formatIdleShutdown, formatRelative } from '../format';
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

  /**
   * Opening the stock IDE is the one place the UI asks for a wake on purpose,
   * so it navigates only once the container reports where to enter.
   */
  async function openIde() {
    await run('ide', async () => {
      const { launchUrl } = await wakeInstance(session.instance.id);
      if (!launchUrl) {
        throw new Error('唤醒成功，但服务器未返回访问地址');
      }
      location.assign(launchUrl);
    });
  }

  return (
    <article className="card session">
      <header className="session-head">
        <div className="session-identity">
          <h3>{session.title}</h3>
          <p className="muted mono">{session.id}</p>
        </div>
        <StatusBadge status={session.status} />
      </header>

      <dl className="session-meta">
        <div>
          <dt>仓库</dt>
          <dd className="mono">/workspace/{session.repoKey}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd className="mono">{session.model}</dd>
        </div>
        <div>
          <dt>最后活动</dt>
          <dd>{formatRelative(session.lastActivityAt)}</dd>
        </div>
        <div>
          <dt>自动休眠</dt>
          <dd>{formatIdleShutdown(session)}</dd>
        </div>
      </dl>

      {session.lastError ? <p className="session-error">{session.lastError}</p> : null}

      <div className="actions">
        <button
          className="button primary"
          disabled={!ready || Boolean(busy)}
          onClick={openIde}
        >
          {busy === 'ide' ? '正在进入…' : '打开完整 IDE ↗'}
        </button>
        {session.phase === 'failed' ? (
          <button
            className="button"
            disabled={Boolean(busy)}
            onClick={() => run('retry', () => retrySession(session.id))}
          >
            重试开工
          </button>
        ) : null}
        {ready && running ? (
          <button
            className="button"
            disabled={Boolean(busy)}
            onClick={() => run('stop', () => stopInstance(session.instance.id))}
          >
            停止
          </button>
        ) : null}
        <button
          className="button danger"
          disabled={Boolean(busy)}
          onClick={() => {
            if (confirm(`删除会话「${session.title}」？容器与快照会一并删除，不可恢复。`)) {
              void run('delete', () => deleteSession(session.id));
            }
          }}
        >
          删除
        </button>
      </div>
    </article>
  );
}
