import {
  useCallback,
  useEffect,
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
import { formatTime } from '../format';
import {
  lastMessageId,
  reconcileOptimisticPrompts,
  type OptimisticPrompt
} from '../optimistic';
import { isPlainClick, navigate } from '../router';
import { useTranscript } from '../useTranscript';
import { ArrowUpIcon, MenuIcon, PanelIcon, StopIcon } from './icons';
import { InstanceModal } from './InstanceModal';
import { MessageList } from './MessageList';
import { ModelSelect } from './ModelSelect';
import { SessionDetails } from './SessionDetails';
import { defaultVariant, VariantSelect } from './VariantSelect';
import { StatusBadge } from './StatusBadge';

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
  catalog,
  onMenu,
  onSessionsChanged
}: {
  sessionId: string;
  catalog?: Catalog;
  onMenu: () => void;
  onSessionsChanged: () => void;
}) {
  const [session, setSession] = useState<SessionView>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string>();
  const [variant, setVariant] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<OptimisticPrompt[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [instanceOpen, setInstanceOpen] = useState(false);
  // The conversation scrolls inside the page rather than the page scrolling, so
  // the header and the composer stay where the reader left them.
  const scroller = useRef<HTMLDivElement>(null);

  const modelVariants = useMemo(() => {
    if (!catalog || !model) {
      return [];
    }
    return catalog.models.find((option) => option.id === model)?.variants ?? [];
  }, [catalog, model]);

  // Sessions started before variants were selectable, or after a model switch
  // in the catalog, may have no effort stored — fill the default so the pill
  // is never blank when the control is shown.
  useEffect(() => {
    if (modelVariants.length === 0) {
      return;
    }
    setVariant((current) =>
      current && modelVariants.some((entry) => entry.id === current)
        ? current
        : (defaultVariant(modelVariants) ?? current)
    );
  }, [model, modelVariants]);

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
      setVariant((current) => current ?? next.variant);
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
  const lost = session?.phase === 'lost';
  const canSend =
    Boolean(session) && ready && session?.status !== 'deleting' && !lost;
  // Keyed to the container, not the folded status. Sending a message puts the
  // session back through queued/starting while the agent is already generating,
  // and the badge reports that dispatch — but there is plainly something to
  // interrupt, so keying the button to the status would hide it exactly when it
  // is first wanted.
  const working = runtime === 'busy';

  // The header wears the model's own name, the way the picker does: the
  // provider half of the id is the gateway account it bills through, which says
  // nothing about the session. Before the catalog lands the raw id is still
  // better than an empty tag.
  const modelLabel = useMemo(() => {
    if (!session?.model) {
      return undefined;
    }
    return (
      catalog?.models?.find((option) => option.id === session.model)?.modelName ??
      session.model
    );
  }, [catalog?.models, session?.model]);

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
        ...(variant ? { variant } : {}),
        promptId: entry.id
      });
      await refreshSession();
      onSessionsChanged();
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
      // A rename or an abort changes what the sidebar is showing about this
      // session, and waiting out a poll to see your own edit reads as a bug.
      onSessionsChanged();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="session-view">
      <header className="content-header">
        <button
          className="icon-button hamburger"
          type="button"
          onClick={onMenu}
          aria-label="Open sessions"
        >
          <MenuIcon />
        </button>
        {session ? (
          <div className="content-heading">
            <h1
              className="content-title"
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
            {/*
              What the session is working on and with, as two tags beside the
              title. They belong to the session rather than to the conversation,
              so they sit in the header and leave the column below to messages.
            */}
            <span className="tag mono" title={`/workspace/${session.repoKey}`}>
              {session.repoKey}
            </span>
            {modelLabel ? (
              <span className="tag mono" title={session.model}>
                {modelLabel}
              </span>
            ) : null}
          </div>
        ) : null}
        <span className="spacer" />
        {session ? (
          <StatusBadge
            status={session.status}
            onClick={() => setInstanceOpen(true)}
          />
        ) : null}
        <button
          className={`icon-button${detailsOpen ? ' active' : ''}`}
          type="button"
          disabled={!session}
          onClick={() => setDetailsOpen((value) => !value)}
          aria-label={detailsOpen ? 'Hide details' : 'Show details'}
          aria-expanded={detailsOpen}
          title="Changes and workspace"
        >
          <PanelIcon />
        </button>
      </header>

      {/* Polling keeps the session record current, so the numbers behind the
          badge stay live while the modal is open. */}
      {session && instanceOpen ? (
        <InstanceModal session={session} onClose={() => setInstanceOpen(false)} />
      ) : null}

      <div className="session-split">
        <div className="session-main">
          <div className="content-body" ref={scroller}>
            <div className="session-column">
              {loadError ? (
                <section className="card error">
                  <h2>Could not load this session</h2>
                  <p className="muted">{loadError}</p>
                </section>
              ) : null}

              {state === 'pending' && !dispatching ? (
                <p className="banner">Starting up — no messages yet.</p>
              ) : null}
              {transcriptError ? (
                <p className="banner error">{transcriptError}</p>
              ) : null}

              {(messages && messages.length > 0) || optimistic.length > 0 ? (
                <MessageList
                  messages={messages ?? []}
                  trailing={optimistic}
                  scrollerRef={scroller}
                />
              ) : state === 'live' ? (
                <p className="muted">No messages yet.</p>
              ) : null}

              {/*
                A lost session is not a failure to retry: the container came
                back without the conversation, so there is nothing left to send
                to. The history above is the mirror, and it stays readable.
              */}
              {lost ? (
                <section className="card">
                  <h2>This session was lost</h2>
                  <p className="muted">
                    Its container restarted without a workspace checkpoint, so
                    OpenCode no longer has this conversation. The history above
                    is the last mirror the Hub exported; it cannot be continued.
                  </p>
                  {session?.lastError ? (
                    <p className="muted mono">{session.lastError}</p>
                  ) : null}
                  <div className="actions">
                    <a
                      className="button"
                      href="/"
                      onClick={(event) => {
                        if (!isPlainClick(event)) {
                          return;
                        }
                        event.preventDefault();
                        navigate('/');
                      }}
                    >
                      Start a new session
                    </a>
                  </div>
                </section>
              ) : null}

              {session?.phase === 'failed' ? (
                <section className="card error">
                  <h2>Failed to start</h2>
                  {session.lastError ? (
                    <p className="muted mono">{session.lastError}</p>
                  ) : null}
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
            </div>
          </div>

          {/*
            These three are all about sending, so they sit with the composer
            rather than at the end of the conversation — where they would only
            be visible if the reader happened to be scrolled to the bottom.
          */}
          <div className="composer-area">
            {/*
              A sleeping session is only worth calling out while it is still
              asleep. Once a message has queued a wake, the progress banner says
              everything this one would, and more usefully.
            */}
            {state === 'sleeping' && !dispatching && !lost ? (
              <p className="banner">
                {mirroredAt
                  ? `This session is asleep. Above is the mirror from ${formatTime(mirroredAt)}. Send a message to wake it and carry on.`
                  : 'This session is asleep and has no mirror yet. Send a message to wake it and carry on.'}
              </p>
            ) : null}

            {dispatching ? (
              <p className="banner progress" role="status">
                <i className="spinner" aria-hidden="true" />
                {waking
                  ? 'Waking the sandbox… a cold start usually takes tens of seconds, and the message goes out once it is back.'
                  : 'Sandbox is ready, handing the message to the agent…'}
              </p>
            ) : null}

            {actionError ? (
              <p className="banner error" role="alert">
                {actionError}
              </p>
            ) : null}

            <form className="composer-box" onSubmit={send} aria-busy={busy}>
              <textarea
                className="prompt"
                rows={2}
                placeholder={
                  lost
                    ? 'This session was lost and cannot be continued'
                    : attached
                      ? 'Say something…'
                      : 'Session is asleep — sending wakes it and continues'
                }
                value={prompt}
                disabled={busy || !canSend}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends, Shift+Enter breaks the line — but not while an
                  // input method is mid-composition, where Enter is how you
                  // accept the candidate you are typing.
                  if (
                    event.key === 'Enter' &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send(event);
                  }
                }}
              />
              <div className="composer-row">
                {catalog ? (
                  <ModelSelect
                    models={catalog.models}
                    value={model ?? ''}
                    disabled={busy || !canSend}
                    onChange={(next) => {
                      setModel(next);
                      const variants =
                        catalog.models.find((option) => option.id === next)
                          ?.variants ?? [];
                      setVariant(defaultVariant(variants));
                    }}
                  />
                ) : null}
                {catalog && modelVariants.length > 0 ? (
                  <VariantSelect
                    variants={modelVariants}
                    value={variant ?? ''}
                    disabled={busy || !canSend}
                    onChange={setVariant}
                  />
                ) : null}
                <span className="spacer" />
                {/*
                  One button, because at any moment there is only one thing to
                  do with a running agent: stop it, or — when it is not running
                  — send the next message.
                */}
                {working ? (
                  <button
                    className="send-button"
                    type="button"
                    disabled={busy}
                    aria-label="Stop"
                    title="Stop"
                    onClick={() => run(() => abortSession(sessionId))}
                  >
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="submit"
                    disabled={busy || !canSend || !prompt.trim()}
                    aria-label="Send"
                    title="Send"
                  >
                    <ArrowUpIcon />
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        {/*
          Mounted only while it is open, so a closed panel costs the container
          nothing; on a phone it covers the conversation rather than squeezing
          it, with a backdrop to dismiss.
        */}
        {session && detailsOpen ? (
          <>
            <button
              className="aside-backdrop"
              type="button"
              aria-label="Close details"
              onClick={() => setDetailsOpen(false)}
            />
            <SessionDetails
              session={session}
              attached={attached}
              onClose={() => setDetailsOpen(false)}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
