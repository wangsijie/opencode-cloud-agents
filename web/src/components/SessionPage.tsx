import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  abortSession,
  getSession,
  sendMessage,
  wakeInstance,
  type Catalog,
  type SessionView
} from '../api';
import { navigate } from '../router';
import { useTranscript } from '../useTranscript';
import { MessageList } from './MessageList';
import { StatusBadge } from './StatusBadge';

const POLL_INTERVAL_MS = 5_000;

/**
 * One conversation.
 *
 * The transcript is read once and then kept current by the session's event
 * stream; the session record itself still polls, because status changes
 * (idle, sleeping) are lifecycle transitions the container does not announce
 * on that stream.
 */
export function SessionPage({
  sessionId,
  catalog
}: {
  sessionId: string;
  catalog?: Catalog;
}) {
  const [session, setSession] = useState<SessionView>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const { messages, state, error: transcriptError } = useTranscript(sessionId);

  const refreshSession = useCallback(async () => {
    try {
      const next = await getSession(sessionId);
      setSession(next);
      setModel((current) => current ?? next.model);
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  useEffect(() => {
    void refreshSession();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refreshSession();
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshSession]);

  const awake = state === 'live';
  // Keyed to the container, not the folded status. Sending a message puts the
  // session back through queued/starting while the agent is already generating,
  // and the badge reports that dispatch — but there is plainly something to
  // interrupt, so keying the button to the status would hide it exactly when it
  // is first wanted.
  const working = session?.instance.runtime.lifecycle === 'busy';

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      // The id makes a retried request the same prompt rather than a second
      // one, which matters because sending is the least reversible action here.
      await sendMessage(sessionId, {
        prompt: text,
        ...(model ? { model } : {}),
        promptId: crypto.randomUUID()
      });
      setPrompt('');
      await refreshSession();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setActionError(undefined);
    try {
      await work();
      await refreshSession();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page session-page">
      <header className="masthead session-masthead">
        <button
          className="link-button"
          onClick={() => navigate('/')}
          aria-label="返回列表"
        >
          ← 全部会话
        </button>
        {session ? <StatusBadge status={session.status} /> : null}
      </header>

      {session ? (
        <div className="session-heading">
          <h1>{session.title}</h1>
          <p className="muted mono">
            /workspace/{session.repoKey} · {session.model}
          </p>
        </div>
      ) : null}

      {loadError ? (
        <section className="card error">
          <h2>无法读取会话</h2>
          <p className="muted">{loadError}</p>
        </section>
      ) : null}

      {state === 'sleeping' ? (
        <p className="banner">
          {'这个会话已休眠，历史暂时读不到。休眠后仍可读历史要等 M4；现在可以先唤醒它。'}
        </p>
      ) : null}
      {state === 'pending' ? <p className="banner">正在开工，还没有消息。</p> : null}
      {transcriptError ? <p className="banner error">{transcriptError}</p> : null}

      {messages && messages.length > 0 ? (
        <MessageList messages={messages} />
      ) : state === 'live' ? (
        <p className="muted">还没有消息。</p>
      ) : null}

      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      <form className="card composer sticky-composer" onSubmit={send} aria-busy={busy}>
        <textarea
          className="prompt"
          rows={2}
          placeholder={awake ? '继续说点什么…' : '会话休眠中，唤醒后可继续'}
          value={prompt}
          disabled={busy || !awake}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="composer-controls">
          {catalog ? (
            <select
              aria-label="模型"
              value={model ?? ''}
              disabled={busy || !awake}
              onChange={(event) => setModel(event.target.value)}
            >
              {catalog.models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          ) : null}
          {working ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => run(() => abortSession(sessionId))}
            >
              中断
            </button>
          ) : null}
          {awake ? (
            <button className="button primary" type="submit" disabled={busy || !prompt.trim()}>
              发送
            </button>
          ) : (
            <button
              className="button primary"
              type="button"
              disabled={busy || !session}
              onClick={() =>
                run(async () => {
                  const { launchUrl } = await wakeInstance(session!.instance.id);
                  if (!launchUrl) {
                    throw new Error('唤醒成功，但服务器未返回访问地址');
                  }
                  // Waking without leaving the page is M5; for now the stock UI
                  // is where an explicit wake lands.
                  location.assign(launchUrl);
                })
              }
            >
              唤醒并打开 IDE ↗
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
