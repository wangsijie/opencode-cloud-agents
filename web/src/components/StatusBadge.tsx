import type { SessionStatus } from '../api';
import { STATUS_LABELS } from '../format';

/**
 * The session's state, as one badge.
 *
 * The Worker folds the dispatch phase and the container lifecycle into a single
 * status, so this renders what it is told rather than re-deriving anything.
 */
export function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <i className="dot" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}
