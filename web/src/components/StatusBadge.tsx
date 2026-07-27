import type { SessionStatus } from '../api';
import { STATUS_LABELS } from '../format';

/**
 * The session's state, as one badge.
 *
 * The Worker folds the dispatch phase and the container lifecycle into a single
 * status, so this renders what it is told rather than re-deriving anything.
 *
 * Given an `onClick` it becomes the way into the instance's numbers — the badge
 * is already the thing on screen that names the container's state, so it is
 * where a reader looks for the rest of it.
 */
export function StatusBadge({
  status,
  onClick
}: {
  status: SessionStatus;
  onClick?: () => void;
}) {
  const content = (
    <>
      <i className="dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </>
  );
  return onClick ? (
    <button
      className={`badge badge-${status} badge-button`}
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      title="Instance details"
    >
      {content}
    </button>
  ) : (
    <span className={`badge badge-${status}`}>{content}</span>
  );
}
