import type {
  SessionStatus,
  SessionUsage,
  SessionView,
  WakeTimings
} from './api';

const TIME_FORMAT = new Intl.DateTimeFormat('en-US', {
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

/** "3 min ago" for anything recent, an absolute time once that stops helping. */
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
    return 'just now';
  }
  if (elapsedMs < 60 * 60_000) {
    return `${Math.floor(elapsedMs / 60_000)} min ago`;
  }
  if (elapsedMs < 24 * 60 * 60_000) {
    return `${Math.floor(elapsedMs / (60 * 60_000))} h ago`;
  }
  return formatTime(value);
}

export type RecencyBucket = 'today' | 'yesterday' | 'week' | 'older';

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  older: 'Older'
};

/**
 * Which heading a session belongs under in the sidebar.
 *
 * Calendar days rather than elapsed hours: something from 11pm last night is
 * "yesterday" at 1am, not "today", which is how a person reads their own
 * history.
 */
export function recencyBucket(value: string, now = new Date()): RecencyBucket {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) {
    return 'older';
  }
  const startOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000);
  if (days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  return days <= 7 ? 'week' : 'older';
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
    ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    : `${(ms / 1000).toFixed(1)}s`;
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
    stages.push(`container start + snapshot restore ${formatDuration(wake.restoreMs)}`);
  }
  if (wake.repoMs !== undefined) {
    stages.push(`repo provisioning ${formatDuration(wake.repoMs)}`);
  }
  if (wake.serverMs !== undefined) {
    stages.push(`OpenCode startup ${formatDuration(wake.serverMs)}`);
  }
  return `${formatTime(wake.at)} · ${stages.join(' · ')}`;
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  queued: 'Queued',
  starting: 'Starting',
  working: 'Working',
  idle: 'Idle',
  sleeping: 'Sleeping',
  failed: 'Failed to start',
  lost: 'Lost',
  error: 'Error',
  deleting: 'Deleting',
  cleaned: 'Cleaned'
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
        return 'clock starts when the task ends';
      case 'sleeping':
        return 'shut down';
      case 'starting':
      case 'queued':
        return 'clock starts once awake';
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
    return 'shutting down';
  }
  return remainingMs < 60_000
    ? 'in under 1 min'
    : `in ${Math.ceil(remainingMs / 60_000)} min`;
}
