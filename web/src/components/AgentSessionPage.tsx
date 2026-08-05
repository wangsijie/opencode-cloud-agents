import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAgentSession,
  getSession,
  type AgentSessionEntry,
  type RuntimeLifecycle,
  type SessionView
} from '../api';
import { agentPath, isPlainClick, navigate, sessionPath } from '../router';
import { useTranscript } from '../useTranscript';
import { MenuIcon, RefreshIcon } from './icons';
import { InstanceModal } from './InstanceModal';
import { MessageList } from './MessageList';
import { StatusBadge } from './StatusBadge';

const POLL_INTERVAL_MS = 5_000;

/** Runtime states in which the container can serve the conversation live. */
const ATTACHED: readonly RuntimeLifecycle[] = ['busy', 'idle'];

/**
 * One subagent's conversation, read from inside the session that started it.
 *
 * OpenCode's `task` tool does its work in a session of its own, and that
 * session is a real transcript: prompts, tool calls, an answer handed back to
 * the parent as a single tool result. Showing only that result is what the
 * session page did before this existed, and it hid everything about how the
 * answer was reached.
 *
 * There is no composer, because there is nobody to talk to. The subagent is
 * driven by its parent's agent loop, which ends the moment it returns; a
 * message sent here would be a prompt to a conversation nothing is listening
 * to. The way back into the conversation is the breadcrumb above.
 *
 * Separate from `SessionPage` rather than a mode of it: nearly all of that
 * page is about sending — drafts, models, effort, optimistic bubbles, abort —
 * and none of it applies here.
 */
export function AgentSessionPage({
  sessionId,
  agentSessionId,
  onMenu
}: {
  sessionId: string;
  agentSessionId: string;
  onMenu: () => void;
}) {
  const [session, setSession] = useState<SessionView>();
  const [loadError, setLoadError] = useState<string>();
  const [lineage, setLineage] = useState<AgentSessionEntry[]>();
  const [instanceOpen, setInstanceOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const runtime = session?.instance.runtime.lifecycle;
  const attached = runtime !== undefined && ATTACHED.includes(runtime);
  const {
    messages,
    state,
    error: transcriptError,
    refreshing,
    refresh: refreshTranscript
  } = useTranscript(sessionId, attached ? 'attached' : runtime, agentSessionId);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await getSession(sessionId));
      setLoadError(undefined);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [sessionId]);

  const refreshAll = useCallback(() => {
    refreshTranscript();
    void refreshSession();
  }, [refreshTranscript, refreshSession]);

  // The record still polls even though nothing here can send: the badge, and
  // the runtime key that re-attaches the stream after a wake, both come from it.
  useEffect(() => {
    void refreshSession();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refreshSession();
      }
    }, POLL_INTERVAL_MS);
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
  }, [refreshSession]);

  /*
    The lineage lives in OpenCode's own session store, which only exists while
    the container is up — so this is tried once per wake rather than polled,
    and a failure is not reported. Losing it costs the breadcrumb its middle,
    not its link home.
  */
  useEffect(() => {
    if (!attached) {
      return;
    }
    let current = true;
    void fetchAgentSession(sessionId, agentSessionId)
      .then((result) => {
        if (current) {
          setLineage(result.lineage);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [sessionId, agentSessionId, attached]);

  /*
    Root first, this subagent last. Until the lineage lands the trail is the
    session and an unnamed subagent — enough to say where you are and to get
    back, which is the part that must never depend on a container being awake.
  */
  const trail: AgentSessionEntry[] = lineage ?? [
    {
      id: '',
      title: session?.displayTitle ?? 'Session'
    },
    { id: agentSessionId, title: 'Subagent' }
  ];

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
        <nav className="content-heading breadcrumb" aria-label="Subagent">
          {trail.map((entry, index) => {
            const last = index === trail.length - 1;
            const href =
              index === 0 ? sessionPath(sessionId) : agentPath(sessionId, entry.id);
            return (
              <span className="breadcrumb-step" key={entry.id || 'root'}>
                {index > 0 ? (
                  <span className="breadcrumb-sep" aria-hidden="true">
                    ›
                  </span>
                ) : null}
                {last ? (
                  <>
                    <span className="content-title">{entry.title}</span>
                    {/* Which subagent this is, as a fact about the run rather
                        than part of its name — the same shape the session
                        header gives its repo and model. */}
                    {entry.agent ? (
                      <span className="tag mono">{entry.agent}</span>
                    ) : null}
                  </>
                ) : (
                  <a
                    className="breadcrumb-link"
                    href={href}
                    title={entry.title}
                    onClick={(event) => {
                      if (!isPlainClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      navigate(href);
                    }}
                  >
                    {entry.title}
                  </a>
                )}
              </span>
            );
          })}
        </nav>
        <span className="spacer" />
        {session ? (
          <StatusBadge
            status={session.status}
            onClick={() => setInstanceOpen(true)}
          />
        ) : null}
        {/* Worth more here than on the session page: a subagent's history is
            not mirrored, so a stalled stream is the only copy of it there is. */}
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
      </header>

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

              {transcriptError ? (
                <p className="banner error">{transcriptError}</p>
              ) : null}

              {/*
                Unlike the conversation itself, a subagent's history is not
                mirrored: it only exists in the container. Saying so beats an
                empty page that looks like the subagent did nothing.
              */}
              {state === 'sleeping' ? (
                <p className="banner">
                  This subagent&rsquo;s transcript is only readable while the
                  sandbox is awake. Send a message in the session above to wake
                  it.
                </p>
              ) : null}

              {messages && messages.length > 0 ? (
                <MessageList
                  messages={messages}
                  scrollerRef={scroller}
                  sessionId={sessionId}
                />
              ) : state === 'live' ? (
                <p className="muted">No messages yet.</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
