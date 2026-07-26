import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  deleteSession,
  patchSession,
  stopInstance,
  type SessionView
} from '../api';
import { RECENCY_LABELS, recencyBucket, type RecencyBucket } from '../format';
import { navigate, sessionPath } from '../router';
import { DotsIcon, PlusIcon } from './icons';

const RUNNING_CONTAINERS = ['running', 'healthy'];

const BUCKET_ORDER: RecencyBucket[] = ['today', 'yesterday', 'week', 'older'];

/** Let a modifier-click or middle-click behave like the link it is. */
function isPlainClick(event: MouseEvent): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0);
}

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
 */
export function Sidebar({
  sessions,
  listError,
  activeId,
  showArchived,
  onToggleArchived,
  refresh,
  open,
  onClose,
  onSignOut
}: {
  sessions?: SessionView[];
  listError?: string;
  activeId?: string;
  showArchived: boolean;
  onToggleArchived: () => void;
  refresh: (silent?: boolean) => Promise<void>;
  open: boolean;
  onClose: () => void;
  onSignOut: () => Promise<void>;
}) {
  const [menuFor, setMenuFor] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const newLink = useRef<HTMLAnchorElement>(null);

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
  // most recently belongs at the top, or the day headings interleave.
  const ordered = sessions
    ? [...sessions].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    : undefined;

  const groups = BUCKET_ORDER.map((bucket) => ({
    bucket,
    entries: ordered?.filter((session) => recencyBucket(session.lastActivityAt) === bucket) ?? []
  })).filter((group) => group.entries.length > 0);

  return (
    <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Sessions">
      <div className="sidebar-brand">OpenCode Hub</div>

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
        ) : groups.length === 0 ? (
          <p className="muted sidebar-empty">
            {showArchived ? 'No archived sessions.' : 'No sessions yet.'}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.bucket}>
              <h2 className="sidebar-group-label">{RECENCY_LABELS[group.bucket]}</h2>
              {group.entries.map((session) => (
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
              ))}
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button className="link-button" onClick={onToggleArchived}>
          {showArchived ? '← Back to active' : 'View archived'}
        </button>
        <button
          className="link-button"
          onClick={() => void onSignOut().catch(() => undefined)}
        >
          Sign out
        </button>
      </div>
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
  const working = ['working', 'starting', 'queued'].includes(session.status);
  const failed = session.status === 'failed' || session.status === 'error';
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
        {working ? <i className="row-dot working" aria-hidden="true" /> : null}
        {failed ? <i className="row-dot failed" aria-hidden="true" /> : null}
        <span className="row-title">{session.displayTitle}</span>
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
            type="button"
            role="menuitem"
            onClick={() =>
              void run(session.id, () =>
                patchSession(session.id, { archived: !session.archivedAt })
              )
            }
          >
            {session.archivedAt ? 'Unarchive' : 'Archive'}
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => {
              if (
                confirm(
                  `Delete session "${session.displayTitle}"? The container and its snapshot go with it, and this cannot be undone. Archiving only hides it from the list — that is a different thing.`
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
