import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  deleteSession,
  patchSession,
  stopInstance,
  type SessionView
} from '../api';
import { RECENCY_LABELS, recencyBucket, type RecencyBucket } from '../format';
import { isPlainClick, navigate, sessionPath } from '../router';
import { useResizable } from '../useResizable';
import { SESSION_PAGE_SIZE } from '../useSessions';
import {
  DotsIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  SidebarIcon,
  SignOutIcon
} from './icons';

const RUNNING_CONTAINERS = ['running', 'healthy'];

const BUCKET_ORDER: RecencyBucket[] = ['today', 'yesterday', 'week', 'older'];

/**
 * The session history, as navigation.
 *
 * Every row is a real link so the browser's own affordances — open in a new
 * tab, copy the address — keep working; the click handler only takes over the
 * plain case, to route without a reload.
 *
 * The per-row menu carries what used to be a row of buttons on a card. Those
 * actions belong to the session rather than to the conversation, which is why
 * they live here and not on the page.
 *
 * On a desktop the whole panel folds away, which is what the details panel on
 * the other side already does: reading a wide diff should not cost the window
 * its history. The phone has no such control — there the sidebar is a drawer
 * and closing it is what the backdrop and Escape are for.
 */
export function Sidebar({
  sessions,
  listError,
  activeId,
  refresh,
  hasMore,
  onShowMore,
  open,
  onClose,
  onCollapse,
  onSignOut
}: {
  sessions?: SessionView[];
  listError?: string;
  activeId?: string;
  refresh: (silent?: boolean) => Promise<void>;
  /** More sessions exist past the page currently loaded. */
  hasMore: boolean;
  /** Grow the page by one more screenful. */
  onShowMore: () => Promise<void>;
  open: boolean;
  onClose: () => void;
  onCollapse: () => void;
  onSignOut: () => Promise<void>;
}) {
  const [menuFor, setMenuFor] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const newLink = useRef<HTMLAnchorElement>(null);
  const { width, handleProps } = useResizable({
    storageKey: 'hub.sidebarWidth',
    fallback: 288,
    min: 200,
    max: 520,
    edge: 'end'
  });

  // The drawer is a temporary surface: opening it should put the keyboard
  // inside, and Escape should be enough to leave.
  useEffect(() => {
    if (!open) {
      return;
    }
    newLink.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A menu that stays open after the pointer has moved on is a menu in the way.
  useEffect(() => {
    if (!menuFor) {
      return;
    }
    const close = () => setMenuFor(undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    addEventListener('pointerdown', close);
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('pointerdown', close);
      removeEventListener('keydown', onKey);
    };
  }, [menuFor]);

  async function run(id: string, work: () => Promise<unknown>) {
    setMenuFor(undefined);
    setBusyId(id);
    setActionError(undefined);
    try {
      await work();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(undefined);
      await refresh(true);
    }
  }

  // The Hub sorts by creation, but a sidebar is a history: the session touched
  // most recently belongs at the top, or the day headings interleave. A pin
  // pulls a session out of that order into its own group on top — the list
  // still sorts within each group by activity, so a pin is a place in the
  // list, not a new ordering principle.
  const ordered = sessions
    ? [...sessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    : undefined;
  const pinned = ordered?.filter((session) => session.pinnedAt) ?? [];

  const groups = BUCKET_ORDER.map((bucket) => ({
    bucket,
    entries:
      ordered?.filter(
        (session) =>
          !session.pinnedAt && recencyBucket(session.lastActivityAt) === bucket
      ) ?? []
  })).filter((group) => group.entries.length > 0);

  const renderEntry = (session: SessionView) => (
    <Row
      key={session.id}
      session={session}
      active={session.id === activeId}
      busy={busyId === session.id}
      menuOpen={menuFor === session.id}
      onOpenMenu={() => setMenuFor(session.id)}
      onNavigate={onClose}
      run={run}
    />
  );

  return (
    <nav
      className={`sidebar${open ? ' open' : ''}`}
      aria-label="Sessions"
      style={{ '--sidebar-width': `${width}px` } as CSSProperties}
    >
      <div className="sidebar-brand">
        <span className="sidebar-brand-name">Cloud Agents</span>
        {/* Hidden on a phone by the stylesheet, where the drawer closes on its
            own backdrop and there is nothing to fold. */}
        <button
          className="icon-button sidebar-collapse"
          type="button"
          aria-label="Collapse sessions"
          title="Collapse sessions"
          onClick={onCollapse}
        >
          <SidebarIcon />
        </button>
      </div>

      <a
        ref={newLink}
        className="sidebar-new"
        href="/"
        onClick={(event) => {
          if (!isPlainClick(event)) {
            return;
          }
          event.preventDefault();
          navigate('/');
          onClose();
        }}
      >
        <PlusIcon />
        New session
      </a>

      {actionError ? <p className="sidebar-error">{actionError}</p> : null}

      <div className="sidebar-history">
        {listError && !sessions ? (
          <p className="muted sidebar-empty">{listError}</p>
        ) : !sessions ? (
          <p className="muted sidebar-empty">Loading…</p>
        ) : groups.length === 0 && pinned.length === 0 ? (
          <p className="muted sidebar-empty">No sessions yet.</p>
        ) : (
          <>
            {pinned.length > 0 ? (
              <div>
                <h2 className="sidebar-group-label">Pinned</h2>
                {pinned.map(renderEntry)}
              </div>
            ) : null}
            {groups.map((group) => (
              <div key={group.bucket}>
                <h2 className="sidebar-group-label">{RECENCY_LABELS[group.bucket]}</h2>
                {group.entries.map(renderEntry)}
              </div>
            ))}
            {/* The history is paged: the Hub sends a screenful, in this same
                order, and this asks for the next one. It is a button rather
                than a scroll sentinel on purpose — an infinite list would keep
                growing the set every poll recalibrates. */}
            {hasMore ? (
              <button
                className="sidebar-more"
                type="button"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void onShowMore().finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? 'Loading…' : `Show ${SESSION_PAGE_SIZE} more`}
              </button>
            ) : null}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        {/* Two buttons, and only two: everything else an operator configures
            is a tab inside Settings, so the footer never grows a row of them
            again. */}
        <div className="sidebar-account-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={() => {
              navigate('/settings');
              onClose();
            }}
          >
            <SettingsIcon />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void onSignOut().catch(() => undefined)}
          >
            <SignOutIcon />
          </button>
        </div>
      </div>

      {/* Hidden on a phone by the stylesheet: there the sidebar is a drawer
          sized against the viewport, and there is no split to move. */}
      <div className="resize-handle end" aria-label="Resize sessions" {...handleProps} />
    </nav>
  );
}

function Row({
  session,
  active,
  busy,
  menuOpen,
  onOpenMenu,
  onNavigate,
  run
}: {
  session: SessionView;
  active: boolean;
  busy: boolean;
  menuOpen: boolean;
  onOpenMenu: () => void;
  onNavigate: () => void;
  run: (id: string, work: () => Promise<unknown>) => Promise<void>;
}) {
  // One indicator, three states: unread (the agent stopped or asked something
  // the user has not seen), running, or nothing. Unread outranks running — a
  // session parked on a question still counts as busy underneath, and what
  // matters is that it is waiting on a human. Instance trouble (failed, lost)
  // is the session page header's job, not the list's.
  const unread = Boolean(session.unreadAt);
  const running = ['working', 'starting', 'queued'].includes(session.status);
  const canStop =
    session.instance.lifecycle === 'ready' &&
    RUNNING_CONTAINERS.includes(session.instance.runtime.container);

  return (
    <div
      className={`session-row${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}${
        session.status === 'deleting' ? ' deleting' : ''
      }`}
    >
      <a
        className="row-link"
        href={sessionPath(session.id)}
        aria-current={active ? 'page' : undefined}
        onClick={(event) => {
          if (!isPlainClick(event)) {
            return;
          }
          event.preventDefault();
          navigate(sessionPath(session.id));
          onNavigate();
        }}
      >
        {unread ? (
          <i className="row-dot unread" aria-hidden="true" />
        ) : running ? (
          <i className="row-dot working" aria-hidden="true" />
        ) : null}
        <span className="row-title">{session.displayTitle}</span>
        {session.pinnedAt ? (
          <span className="row-pin" title="Pinned to the top">
            <PinIcon />
          </span>
        ) : null}
        {/* A cleaned session is still listed — its history remains readable —
            but the tag says up front that it is an archive, not a session to
            continue. */}
        {session.status === 'cleaned' ? (
          <span className="row-tag">cleaned</span>
        ) : null}
      </a>
      <button
        className="row-menu-button"
        type="button"
        aria-label={`Actions for ${session.displayTitle}`}
        disabled={busy}
        onClick={onOpenMenu}
        // The document-level close listener fires first otherwise, and the
        // menu would shut on the same press that opened it.
        onPointerDown={(event) => event.stopPropagation()}
      >
        <DotsIcon />
      </button>

      {menuOpen ? (
        <div
          className="row-menu"
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const next = window.prompt('Session title', session.displayTitle);
              if (next && next.trim() && next.trim() !== session.displayTitle) {
                void run(session.id, () =>
                  patchSession(session.id, { title: next.trim() })
                );
              }
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(session.id, () =>
                patchSession(session.id, { pinned: !session.pinnedAt })
              )
            }
          >
            {session.pinnedAt ? 'Unpin' : 'Pin to top'}
          </button>
          {/* The same marker the agent's stop events set, by hand: a session
              worth coming back to keeps its dot. Marking the session that is
              open leaves the page, because having it open and visible is what
              "read" means — the page would acknowledge the new marker on its
              next poll and the dot would vanish under the cursor. */}
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void run(session.id, async () => {
                await patchSession(session.id, { unread: !unread });
                if (!unread && active) {
                  navigate('/');
                }
              })
            }
          >
            {unread ? 'Mark as read' : 'Mark as unread'}
          </button>
          {canStop ? (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                void run(session.id, () => stopInstance(session.instance.id))
              }
            >
              Stop container
            </button>
          ) : null}
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => {
              if (
                confirm(
                  `Delete session "${session.displayTitle}"? The container and its snapshot go with it, and this cannot be undone.`
                )
              ) {
                void run(session.id, async () => {
                  await deleteSession(session.id);
                  // The page behind is about to be a session that no longer
                  // exists.
                  if (location.pathname === sessionPath(session.id)) {
                    navigate('/');
                  }
                });
              }
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
