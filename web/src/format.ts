import type { SessionStatus, SessionView } from './api';

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short'
});

export function formatTime(value: string | undefined): string {
  if (!value) {
    return '—';
  }
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? '—' : TIME_FORMAT.format(at);
}

/** "3 分钟前" for anything recent, an absolute time once that stops helping. */
export function formatRelative(value: string | undefined): string {
  if (!value) {
    return '—';
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return '—';
  }
  const elapsedMs = Date.now() - at.getTime();
  if (elapsedMs < 60_000) {
    return '刚刚';
  }
  if (elapsedMs < 60 * 60_000) {
    return `${Math.floor(elapsedMs / 60_000)} 分钟前`;
  }
  if (elapsedMs < 24 * 60 * 60_000) {
    return `${Math.floor(elapsedMs / (60 * 60_000))} 小时前`;
  }
  return formatTime(value);
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  queued: '排队中',
  starting: '正在开工',
  working: '任务执行中',
  idle: '空闲',
  sleeping: '已休眠',
  failed: '开工失败',
  error: '运行异常',
  deleting: '正在删除'
};

/**
 * When the container will stop itself.
 *
 * Only a session whose container is awake and idle has a real deadline; the
 * other states explain why there is no clock running instead of showing a dash.
 */
export function formatIdleShutdown(session: SessionView): string {
  const deadline = session.instance.runtime.idleDeadlineAt;
  if (!deadline) {
    switch (session.status) {
      case 'working':
        return '任务结束后开始计时';
      case 'sleeping':
        return '已关闭';
      case 'starting':
      case 'queued':
        return '唤醒后开始计时';
      default:
        return '—';
    }
  }
  const at = new Date(deadline);
  if (Number.isNaN(at.getTime())) {
    return '—';
  }
  const remainingMs = at.getTime() - Date.now();
  if (remainingMs <= 0) {
    return '即将关闭';
  }
  return remainingMs < 60_000
    ? '不到 1 分钟后'
    : `${Math.ceil(remainingMs / 60_000)} 分钟后`;
}
