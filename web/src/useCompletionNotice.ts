import { useEffect, useRef, useState } from 'react';
import type { SessionView } from './api';
import { navigate, sessionPath } from './router';

/**
 * Tell the user when an agent stops working.
 *
 * A session that runs for minutes is exactly the session nobody watches, so the
 * end of a turn is worth a notification. This uses the browser's own — no push
 * service, no server-side subscription, nothing leaving the origin — which means
 * it only fires while a tab is open. That is the honest trade: it costs nothing
 * and covers the "left it running in another tab" case, which is the common one.
 *
 * Transitions are what matter, not states: the first list a page loads
 * establishes the baseline and notifies for nothing.
 */
function isWorking(session: SessionView): boolean {
  return (
    session.status === 'working' ||
    session.status === 'starting' ||
    session.status === 'queued'
  );
}

export type NoticePermission = 'unsupported' | NotificationPermission;

export function notificationPermission(): NoticePermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * The permission prompt, and whether it is worth showing a button for.
 *
 * Asking must come from a click: browsers refuse (and some permanently deny) a
 * permission requested on page load.
 */
export function useNotificationOptIn() {
  const [permission, setPermission] = useState<NoticePermission>(() =>
    notificationPermission()
  );
  return {
    permission,
    request: async () => {
      if (typeof Notification === 'undefined') {
        return;
      }
      setPermission(await Notification.requestPermission());
    }
  };
}

export function useCompletionNotice(sessions: SessionView[] | undefined): void {
  const previous = useRef<Map<string, boolean> | undefined>(undefined);

  useEffect(() => {
    if (!sessions) {
      return;
    }
    const current = new Map(sessions.map((session) => [session.id, isWorking(session)]));
    const before = previous.current;
    previous.current = current;
    if (!before || notificationPermission() !== 'granted') {
      return;
    }
    for (const session of sessions) {
      if (before.get(session.id) !== true || isWorking(session)) {
        continue;
      }
      const failed = session.status === 'failed' || session.status === 'error';
      const notice = new Notification(
        failed ? `会话出错：${session.displayTitle}` : `任务完成：${session.displayTitle}`,
        {
          body: failed
            ? (session.lastError ?? '开工失败，可在会话页重试。')
            : `${session.repoKey} · 点击查看结果`,
          // One notification per session: a slow turn that ends twice should
          // replace its own notice rather than stack up.
          tag: session.id
        }
      );
      notice.onclick = () => {
        window.focus();
        navigate(sessionPath(session.id));
        notice.close();
      };
    }
  }, [sessions]);
}
