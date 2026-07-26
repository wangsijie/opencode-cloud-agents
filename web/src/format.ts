import type {
  SessionStatus,
  SessionUsage,
  SessionView,
  WakeTimings
} from './api';

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

export function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** Seconds with one decimal, for durations a person is waiting through. */
export function formatDuration(ms: number): string {
  return ms >= 60_000
    ? `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
    : `${(ms / 1000).toFixed(1)} 秒`;
}

function formatTokens(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1_000
      ? `${(value / 1_000).toFixed(1)}k`
      : String(value);
}

/**
 * Tokens and cost in one line.
 *
 * Cache reads are folded into the input total rather than shown separately: the
 * split matters for tuning a prompt, not for the question this line answers,
 * which is how much this conversation has consumed. The cost is OpenCode's own
 * figure, so it already prices cached tokens correctly.
 */
export function formatUsage(usage: SessionUsage): string {
  const input = usage.inputTokens + usage.cacheReadTokens;
  const output = usage.outputTokens + usage.reasoningTokens;
  const cost =
    usage.cost >= 0.01 ? `$${usage.cost.toFixed(2)}` : `$${usage.cost.toFixed(4)}`;
  return `↑${formatTokens(input)} ↓${formatTokens(output)} · ${cost}`;
}

/**
 * The wake's stage breakdown, for the tooltip behind its total.
 *
 * Which stage dominates is the only actionable part of a cold-start number, and
 * it is developer detail rather than something the line itself should carry.
 */
export function describeWakeStages(wake: WakeTimings): string {
  const stages: string[] = [];
  if (wake.restoreMs !== undefined) {
    stages.push(`容器启动 + 快照恢复 ${formatDuration(wake.restoreMs)}`);
  }
  if (wake.repoMs !== undefined) {
    stages.push(`仓库置备 ${formatDuration(wake.repoMs)}`);
  }
  if (wake.serverMs !== undefined) {
    stages.push(`OpenCode 启动 ${formatDuration(wake.serverMs)}`);
  }
  return `${formatTime(wake.at)} · ${stages.join(' · ')}`;
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
