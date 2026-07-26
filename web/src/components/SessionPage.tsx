import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from 'react';
import {
  abortSession,
  getSession,
  patchSession,
  retrySession,
  sendMessage,
  type Catalog,
  type RuntimeLifecycle,
  type SessionView
} from '../api';
import {
  describeWakeStages,
  formatDuration,
  formatTime,
  formatUsage
} from '../format';
import {
  lastMessageId,
  reconcileOptimisticPrompts,
  type OptimisticPrompt
} from '../optimistic';
import { navigate } from '../router';
import { useCompletionNotice } from '../useCompletionNotice';
import { useTranscript } from '../useTranscript';
import { ChangesPanel } from './ChangesPanel';
import { MessageList } from './MessageList';
import { StatusBadge } from './StatusBadge';
import { WorkspacePanel } from './WorkspacePanel';

const POLL_INTERVAL_MS = 5_000;

/** While a wake is in flight the page is a progress indicator, so it polls harder. */
const WAKING_POLL_INTERVAL_MS = 2_000;

/** Runtime states in which the container can serve the conversation live. */
const ATTACHED: readonly RuntimeLifecycle[] = ['busy', 'idle'];

/**
 * One conversation.
 *
 * The transcript is read once and then kept current by the session's event
 * stream; the session record itself still polls, because status changes
 * (idle, sleeping) are lifecycle transitions the container does not announce
 * on that stream.
 *
 * Sending a message never depends on the container being up. A prompt to a
 * sleeping session is queued and wakes it, so the page's job during that
 * minute is to show the message as sent and the sandbox as coming back — not
 * to send the user elsewhere to press a wake button.
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
  const [pending, setPending] = useState<OptimisticPrompt[]>([]);
  const composer = useRef<HTMLFormElement>(null);

  // The composer is fixed over the conversation, so the page has to reserve
  // exactly its height or the last message stays hidden behind it. That height
  // is not a constant: the controls wrap by width, and the abort button comes
  // and goes with the container's state.
  //
  // Measured on every commit rather than through a ResizeObserver. Both
  // triggers that change the height are covered — a re-render for the buttons,
  // the resize listener for the wrapping — and a layout effect runs
  // synchronously before paint, so the reservation is never one frame stale.
  useLayoutEffect(() => {
    const measure = () => {
      const node = composer.current;
      if (node) {
        // The border box, not the content box: the composer's own padding,
        // which includes the phone's home-indicator inset, is part of what it
        // covers.
        document.documentElement.style.setProperty(
          '--composer-height',
          `${node.getBoundingClientRect().height}px`
        );
      }
    };
    measure();
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  });

  // The same notice the list gives, for the page a user is most likely to be
  // waiting on. One session is still a list as far as the hook is concerned.
  useCompletionNotice(useMemo(() => (session ? [session] : undefined), [session]));

  const runtime = session?.instance.runtime.lifecycle;
  const attached = runtime !== undefined && ATTACHED.includes(runtime);
  const {
    messages,
    state,
    mirroredAt,
    error: transcriptError
    // Keyed to the runtime so a wake the user just triggered re-attaches the
    // event stream at once, rather than after the browser's reconnect delay.
  } = useTranscript(sessionId, attached ? 'attached' : runtime);

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

  // Dispatch is unfinished: the prompt is durable but the container has not
  // been handed it yet. Which of the two it is waiting on decides the wording.
  const dispatching = session?.phase === 'queued' || session?.phase === 'starting';
  const waking = dispatching && !attached;

  useEffect(() => {
    void refreshSession();
    const interval = waking ? WAKING_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refreshSession();
      }
    }, interval);
    // Coming back to a backgrounded tab should not wait out a whole interval.
    const onVisible = () => {
      if (!document.hidden) {
        void refreshSession();
      }
    };
    addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshSession, waking]);

  // Optimistic bubbles disappear as the real messages arrive, whether that is
  // seconds later on a running container or a cold start later on a sleeping
  // one. Reconciling against the transcript rather than against the send's
  // response is what makes both cases the same code path.
  useEffect(() => {
    setPending((current) => reconcileOptimisticPrompts(current, messages));
  }, [messages]);

  const ready = session?.instance.lifecycle === 'ready';
  const canSend = Boolean(session) && ready && session?.status !== 'deleting';
  // Keyed to the container, not the folded status. Sending a message puts the
  // session back through queued/starting while the agent is already generating,
  // and the badge reports that dispatch — but there is plainly something to
  // interrupt, so keying the button to the status would hide it exactly when it
  // is first wanted.
  const working = runtime === 'busy';

  const optimistic = useMemo(
    () =>
      pending.map((entry) => (
        <article key={entry.id} className="message user pending">
          <div className="message-body">
            <p className="part-text">{entry.text}</p>
          </div>
        </article>
      )),
    [pending]
  );

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy || !canSend) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    const entry: OptimisticPrompt = {
      // The id makes a retried request the same prompt rather than a second
      // one, which matters because sending is the least reversible action here.
      id: crypto.randomUUID(),
      text,
      sentAt: new Date().toISOString(),
      ...(lastMessageId(messages) ? { afterMessageId: lastMessageId(messages)! } : {})
    };
    setPending((current) => [...current, entry]);
    setPrompt('');
    try {
      await sendMessage(sessionId, {
        prompt: text,
        ...(model ? { model } : {}),
        promptId: entry.id
      });
      await refreshSession();
    } catch (cause) {
      // The message never reached the queue, so withdraw the bubble and give
      // the text back rather than leaving a message that will never be answered.
      setPending((current) => current.filter((queued) => queued.id !== entry.id));
      setPrompt((current) => (current ? current : text));
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
          aria-label="Back to the list"
        >
          ← All sessions
        </button>
        {session ? <StatusBadge status={session.status} /> : null}
      </header>

      {session ? (
        <div className="session-heading">
          <h1
            onDoubleClick={() => {
              // `prompt` is the composer's state here, so the browser dialog is named.
              const next = window.prompt('Session title', session.displayTitle);
              if (next && next.trim() && next.trim() !== session.displayTitle) {
                void run(() => patchSession(sessionId, { title: next.trim() }));
              }
            }}
            title="Double-click to rename"
          >
            {session.displayTitle}
          </h1>
          <p className="muted mono">
            /workspace/{session.repoKey} · {session.model}
            {session.transcript?.usage &&
            session.transcript.usage.assistantMessages > 0
              ? ` · ${formatUsage(session.transcript.usage)}`
              : ''}
            {/*
              The cold start is the one wait with no progress to show beyond a
              spinner, so the last one's cost is stated rather than left to
              memory. Only cold wakes are reported: a server restart on a live
              container is a different number and would flatter the average.
            */}
            {session.instance.runtime.lastWake?.cold ? (
              <span title={describeWakeStages(session.instance.runtime.lastWake)}>
                {` · last wake ${formatDuration(session.instance.runtime.lastWake.totalMs)}`}
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      {/*
        Collapsed this is one row, so it can sit above the conversation without
        pushing it down — and above is where it belongs: what the agent changed
        is the point of the session, not a footnote to it.
      */}
      {session ? (
        <>
          <ChangesPanel
            sessionId={sessionId}
            attached={attached}
            sessionTitle={session.title}
          />
          <WorkspacePanel
            sessionId={sessionId}
            attached={attached}
            directory={session.directory ?? `/workspace/${session.repoKey}`}
          />
        </>
      ) : null}

      {loadError ? (
        <section className="card error">
          <h2>Could not load this session</h2>
          <p className="muted">{loadError}</p>
        </section>
      ) : null}

      {/*
        A sleeping session is only worth calling out while it is still asleep.
        Once a message has queued a wake, the progress bar below says everything
        this banner would, and more usefully.
      */}
      {state === 'sleeping' && !dispatching ? (
        <p className="banner">
          {mirroredAt
            ? `This session is asleep. Below is the mirror from ${formatTime(mirroredAt)}. Send a message to wake it and carry on.`
            : 'This session is asleep and has no mirror yet. Send a message to wake it and carry on.'}
        </p>
      ) : null}
      {state === 'pending' && !dispatching ? (
        <p className="banner">Starting up — no messages yet.</p>
      ) : null}
      {transcriptError ? <p className="banner error">{transcriptError}</p> : null}

      {(messages && messages.length > 0) || optimistic.length > 0 ? (
        <MessageList messages={messages ?? []} trailing={optimistic} />
      ) : state === 'live' ? (
        <p className="muted">No messages yet.</p>
      ) : null}

      {dispatching ? (
        <p className="banner progress" role="status">
          <i className="spinner" aria-hidden="true" />
          {waking
            ? 'Waking the sandbox… a cold start usually takes tens of seconds, and the message goes out once it is back.'
            : 'Sandbox is ready, handing the message to the agent…'}
        </p>
      ) : null}

      {session?.phase === 'failed' ? (
        <section className="card error">
          <h2>Failed to start</h2>
          {session.lastError ? <p className="muted mono">{session.lastError}</p> : null}
          <div className="actions">
            <button
              className="button"
              disabled={busy}
              onClick={() => run(() => retrySession(sessionId))}
            >
              Retry
            </button>
          </div>
        </section>
      ) : null}

      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      <form
        ref={composer}
        className="card composer sticky-composer"
        onSubmit={send}
        aria-busy={busy}
      >
        <textarea
          className="prompt"
          rows={2}
          placeholder={
            attached ? 'Say something…' : 'Session is asleep — sending wakes it and continues'
          }
          value={prompt}
          disabled={busy || !canSend}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="composer-controls">
          {catalog ? (
            <select
              aria-label="Model"
              value={model ?? ''}
              disabled={busy || !canSend}
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
              Abort
            </button>
          ) : null}
          <button
            className="button primary"
            type="submit"
            disabled={busy || !canSend || !prompt.trim()}
          >
            Send
          </button>
        </div>
      </form>
    </main>
  );
}
