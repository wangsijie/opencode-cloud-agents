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
  isDockerProvider,
  markSessionRead,
  patchSession,
  retrySession,
  sendMessage,
  type Catalog,
  type RuntimeLifecycle,
  type SessionView
} from '../api';
import {
  lastMessageId,
  reconcileOptimisticPrompts,
  type OptimisticPrompt
} from '../optimistic';
import { isPlainClick, navigate } from '../router';
import { useDraft } from '../useDraft';
import { useTranscript } from '../useTranscript';
import {
  AttachButton,
  AttachmentChips,
  toAttachmentPayload,
  useComposerAttachments
} from './ComposerAttachments';
import {
  ArrowUpIcon,
  DockerIcon,
  MenuIcon,
  PanelIcon,
  RefreshIcon,
  RepoIcon,
  StopIcon
} from './icons';
import { InstanceModal } from './InstanceModal';
import { MessageList } from './MessageList';
import { ModelSelect } from './ModelSelect';
import { SessionDetails } from './SessionDetails';
import { defaultVariant, VariantSelect } from './VariantSelect';
import { providerLabel } from './ProviderSelect';
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
  // Kept in the browser so leaving the page — for the settings, for another
  // conversation — does not throw away half a typed prompt.
  const [prompt, setPrompt] = useDraft(`session.${sessionId}`);
  const [model, setModel] = useState<string>();
  const [variant, setVariant] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<OptimisticPrompt[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [instanceOpen, setInstanceOpen] = useState(false);
  const attachmentsApi = useComposerAttachments(setActionError);
  // The conversation scrolls inside the page rather than the page scrolling, so
  // the header and the composer stay where the reader left them.
  const scroller = useRef<HTMLDivElement>(null);

  const modelVariants = useMemo(() => {
    if (!catalog || !model) {
      return [];
    }
    return catalog.models.find((option) => option.id === model)?.variants ?? [];
  }, [catalog, model]);

  // Keep effort in sync with the selected model. A model with no variants must
  // drop any leftover key — hiding the pill is not enough; send still reads
  // this state and a stale effort 400s as "Unknown model variant". Cleared
  // state is `''` (not `undefined`) so a later session refresh cannot treat it
  // as "not yet loaded" and re-fill the previous model's effort.
  // `modelVariants` is empty both before the model loads and for a model that
  // really has no variants; only the latter may clear. Clearing while the
  // catalog or the session read is still pending would stamp the catalog
  // default over the variant the session stores, which the refresh's
  // `current ?? next.variant` then refuses to correct.
  useEffect(() => {
    if (modelVariants.length === 0) {
      if (model && catalog) {
        setVariant('');
      }
      return;
    }
    setVariant((current) =>
      current && modelVariants.some((entry) => entry.id === current)
        ? current
        : (defaultVariant(modelVariants) ?? '')
    );
  }, [model, modelVariants, catalog]);

  const runtime = session?.instance.runtime.lifecycle;
  const attached = runtime !== undefined && ATTACHED.includes(runtime);
  const {
    messages,
    state,
    error: transcriptError,
    refreshing,
    refresh: refreshTranscript
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

  // One button for "show me what is actually there". The conversation and the
  // badge above it come from two different places — a stream and a poll — and a
  // reader who suspects the page is stale cannot tell which of them stalled, so
  // both are redone.
  const refreshAll = useCallback(() => {
    refreshTranscript();
    void refreshSession();
  }, [refreshTranscript, refreshSession]);

  // Dispatch is unfinished: the prompt is durable but the container has not
  // been handed it yet. The pending bubble's own spinner is the progress
  // indicator; a wake only sharpens the poll and the boot screen's wording.
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

  // Having this page open and visible is what "read" means. Each acknowledged
  // marker is remembered so one unread value is posted once, not once per
  // poll; a new marker landing while the page is open compares different and
  // is acknowledged on the next poll. Clearing server-side is what removes the
  // sidebar dot, hence the list refresh.
  // Keyed to the polled record, not the marker value: a hidden tab skips the
  // acknowledgement, and the next poll after it becomes visible must retry
  // even though the marker itself has not changed.
  const acknowledgedUnread = useRef<string | undefined>(undefined);
  useEffect(() => {
    const unreadAt = session?.unreadAt;
    if (!unreadAt || document.hidden || acknowledgedUnread.current === unreadAt) {
      return;
    }
    acknowledgedUnread.current = unreadAt;
    markSessionRead(sessionId, unreadAt)
      .then(() => onSessionsChanged())
      .catch(() => {
        // Retry on the next poll rather than looping on a dead network.
        if (acknowledgedUnread.current === unreadAt) {
          acknowledgedUnread.current = undefined;
        }
      });
  }, [sessionId, session, onSessionsChanged]);

  // Optimistic bubbles disappear as the real messages arrive, whether that is
  // seconds later on a running container or a cold start later on a sleeping
  // one. Reconciling against the transcript rather than against the send's
  // response is what makes both cases the same code path.
  useEffect(() => {
    setPending((current) => reconcileOptimisticPrompts(current, messages));
  }, [messages]);

  const ready = session?.instance.lifecycle === 'ready';
  const lost = session?.phase === 'lost';
  const cleaned = session?.status === 'cleaned';
  const canSend =
    Boolean(session) &&
    ready &&
    session?.status !== 'deleting' &&
    !lost &&
    !cleaned;
  // Keyed to the container, not the folded status. Sending a message puts the
  // session back through queued/starting while the agent is already generating,
  // and the badge reports that dispatch — but there is plainly something to
  // interrupt, so keying the button to the status would hide it exactly when it
  // is first wanted.
  const working = runtime === 'busy';

  // Arriving straight from the new-session form there is nothing to read and
  // nothing to send: the prompt is already queued and the sandbox is booting.
  // A banner plus a composer above an empty page only invites the reader to
  // type a second message, so the whole conversation is replaced by the boot
  // state until there is a transcript to show.
  // Until the first session read lands nothing about this session is known —
  // not even whether it is booting. Rendering the conversation in the meantime
  // flashes an empty page and a composer for one frame before the boot state
  // replaces them, so the main area waits instead.
  const loading = !session && !loadError;

  const booting =
    Boolean(dispatching) &&
    !lost &&
    (messages?.length ?? 0) === 0 &&
    pending.length === 0;

  // The newest unacknowledged prompt carries a spinner: it is the one whose
  // dispatch the reader is waiting on, so the loading mark lives on the
  // message itself rather than in a banner by the composer.
  const optimistic = useMemo(
    () =>
      pending.map((entry, index) => (
        <article key={entry.id} className="message user pending">
          <div className="message-body">
            {entry.attachments?.map((attachment, i) => (
              <img
                key={i}
                className="pending-attachment"
                src={attachment.previewUrl}
                alt=""
              />
            ))}
            <p className="part-text">
              {entry.text}
              {index === pending.length - 1 ? (
                <i className="spinner" aria-hidden="true" />
              ) : null}
            </p>
          </div>
        </article>
      )),
    [pending]
  );

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy || !canSend || attachmentsApi.reading) {
      return;
    }
    setBusy(true);
    setActionError(undefined);
    const attachments = attachmentsApi.attachments;
    const entry: OptimisticPrompt = {
      // The id makes a retried request the same prompt rather than a second
      // one, which matters because sending is the least reversible action here.
      id: crypto.randomUUID(),
      text,
      sentAt: new Date().toISOString(),
      ...(lastMessageId(messages) ? { afterMessageId: lastMessageId(messages)! } : {}),
      ...(attachments.length > 0
        ? {
            // A preview can lag its upload; a chip whose read has not landed
            // yet just has no thumbnail in the bubble.
            attachments: attachments
              .filter(
                (attachment): attachment is typeof attachment & { dataUrl: string } =>
                  typeof attachment.dataUrl === 'string'
              )
              .map((attachment) => ({ previewUrl: attachment.dataUrl }))
          }
        : {})
    };
    setPending((current) => [...current, entry]);
    setPrompt('');
    attachmentsApi.clear();
    try {
      const effort =
        variant && modelVariants.some((entry) => entry.id === variant)
          ? variant
          : undefined;
      await sendMessage(sessionId, {
        prompt: text,
        ...(model ? { model } : {}),
        ...(effort ? { variant: effort } : {}),
        promptId: entry.id,
        ...(attachments.length > 0
          ? { attachments: toAttachmentPayload(attachments) }
          : {})
      });
      await refreshSession();
      onSessionsChanged();
    } catch (cause) {
      // The message never reached the queue, so withdraw the bubble and give
      // the text back rather than leaving a message that will never be answered.
      setPending((current) => current.filter((queued) => queued.id !== entry.id));
      setPrompt((current) => (current ? current : text));
      attachmentsApi.restore(attachments);
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
              Where the session works, as a tag beside the title. It belongs to
              the session rather than to the conversation, so it sits in the
              header and leaves the column below to messages. The model is not
              here: the composer's picker states it and is the place it can be
              changed, so a second copy in the header only crowded the title.
            */}
            {/* A session without a repository still works somewhere, and the
                directory is the honest answer to "on what?". */}
            <span
              className="tag mono"
              title={session.repoKey ? `/workspace/${session.repoKey}` : '/workspace'}
            >
              <RepoIcon />
              <span className="tag-label">{session.repoKey ?? 'No repository'}</span>
            </span>
            {/* The host is worth marking only when it is not the default one,
                and the whale says "Docker" to anyone it means anything to
                without spending a word of the header on it. It wears no chip:
                a border around a lone glyph reads as a button that does
                nothing, and this only states a fact — what it changes about
                the session is in the instance modal. */}
            {isDockerProvider(session.provider) ? (
              <span
                className="heading-mark"
                title={`Runs on ${providerLabel(session.provider)}`}
                role="img"
                aria-label={`Runs on ${providerLabel(session.provider)}`}
              >
                <DockerIcon />
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
        {/*
          The escape hatch from a stalled stream. It sits in the header rather
          than by the composer because it is about reading, not sending, and it
          is always enabled: a session that failed to load is exactly when
          retrying is worth offering.
        */}
        <button
          className="icon-button"
          type="button"
          disabled={refreshing}
          onClick={refreshAll}
          aria-label="Refresh conversation"
          title="Refresh conversation"
        >
          <RefreshIcon />
        </button>
        <button
          className={`icon-button${detailsOpen ? ' active' : ''}`}
          type="button"
          disabled={!session}
          onClick={() => setDetailsOpen((value) => !value)}
          aria-label={detailsOpen ? 'Hide details' : 'Show details'}
          aria-expanded={detailsOpen}
          title={session && !session.repoKey ? 'Workspace' : 'Changes and workspace'}
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
          {loading ? (
            <div className="session-booting" role="status">
              <i className="spinner big" aria-hidden="true" />
            </div>
          ) : booting ? (
            <div className="session-booting" role="status">
              <i className="spinner big" aria-hidden="true" />
              <p className="booting-title">
                {session?.bootStep === 'cloning'
                  ? 'Cloning the repository'
                  : 'Starting the runtime environment'}
              </p>
              {waking ? (
                <p className="muted">A cold start usually takes tens of seconds.</p>
              ) : null}
            </div>
          ) : (
            <>
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
                      sessionId={sessionId}
                    />
                  ) : state === 'live' ? (
                    <p className="muted">No messages yet.</p>
                  ) : null}

                  {/*
                    A lost session is not a failure to retry: the container came
                    back without the conversation, so there is nothing left to send
                    to. The history above is the mirror, and it stays readable.
                  */}
                  {lost && !cleaned ? (
                    <section className="card">
                      <h2>This session was lost</h2>
                      <p className="muted">
                        {/* Same loss, reached a different way: a Docker session
                            keeps its workspace on a volume rather than in a
                            snapshot, so there is no checkpoint to blame. */}
                        {session && isDockerProvider(session.provider)
                          ? 'Its workspace volume was recreated, so OpenCode no longer has this conversation.'
                          : 'Its container restarted without a workspace checkpoint, so OpenCode no longer has this conversation.'}{' '}
                        The history above is the last mirror the Hub exported; it
                        cannot be continued.
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

                  {/*
                    Cleaned is retirement, not failure: the container aged out
                    after days of inactivity and was removed. The history
                    above is the mirror, and it stays readable — but there is
                    nothing left to send to.
                  */}
                  {cleaned ? (
                    <section className="card">
                      <h2>This session was cleaned up</h2>
                      <p className="muted">
                        It sat idle for over 3 days, so its container and
                        workspace were removed. The history above is the
                        preserved transcript; it stays readable but the session
                        cannot be resumed.
                      </p>
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

                  {session?.phase === 'failed' && !cleaned ? (
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
                Errors sit with the composer rather than at the end of the
                conversation — where they would only be visible if the reader
                happened to be scrolled to the bottom. Progress lives on the
                pending message's own spinner, and sleeping is already on the
                status pill; no extra banner.
              */}
              <div className="composer-area">
                {actionError ? (
                  <p className="banner error" role="alert">
                    {actionError}
                  </p>
                ) : null}

                <form className="composer-box" onSubmit={send} aria-busy={busy}>
                  <AttachmentChips api={attachmentsApi} />
                  <textarea
                    className="prompt"
                    rows={2}
                    placeholder={
                      cleaned
                        ? 'This session was cleaned up and is read-only'
                        : lost
                          ? 'This session was lost and cannot be continued'
                          : attached
                            ? 'Say something…'
                            : 'Session is asleep — sending wakes it and continues'
                    }
                    value={prompt}
                    disabled={busy || !canSend}
                    onChange={(event) => setPrompt(event.target.value)}
                    onPaste={attachmentsApi.onPaste}
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
                    <AttachButton
                      api={attachmentsApi}
                      disabled={busy || !canSend}
                    />
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
                          setVariant(
                            variants.length > 0
                              ? (defaultVariant(variants) ?? '')
                              : ''
                          );
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
                        disabled={
                          busy ||
                          !canSend ||
                          !prompt.trim() ||
                          attachmentsApi.reading
                        }
                        aria-label="Send"
                        title="Send"
                      >
                        <ArrowUpIcon />
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </>
          )}
        </div>

        {/*
          Mounted only while it is open, so a closed panel costs the container
          nothing; on a phone it comes up as a sheet over the conversation
          rather than squeezing it, with a backdrop to dismiss.
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
              onWoke={refreshAll}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
