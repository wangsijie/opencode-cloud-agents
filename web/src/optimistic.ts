import type { SessionMessage } from './api';

/**
 * A prompt the user has sent that the transcript does not show yet.
 *
 * Between the send and the container accepting it there can be a cold start of
 * tens of seconds, so the message has to appear immediately or the page looks
 * like it swallowed it.
 */
export interface OptimisticPrompt {
  id: string;
  text: string;
  sentAt: string;
  /**
   * The last message id in the transcript when this prompt was sent, so an
   * identical message the user already sent earlier cannot be mistaken for
   * this one. Absent when the transcript was still empty.
   */
  afterMessageId?: string;
}

/** The user-visible text of a message, which is what a prompt turns into. */
function userMessageText(message: SessionMessage): string | undefined {
  if (message.info.role !== 'user') {
    return undefined;
  }
  const text = message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim();
  return text.length > 0 ? text : undefined;
}

/** The id of the newest message, used as the watermark for the next prompt. */
export function lastMessageId(
  messages: SessionMessage[] | undefined
): string | undefined {
  return messages && messages.length > 0
    ? messages[messages.length - 1].info.id
    : undefined;
}

/**
 * Drop the optimistic prompts the transcript has caught up on.
 *
 * Matching is by text, because the Hub deliberately does not assign OpenCode
 * message ids (they carry a sortable timestamp prefix, so a client-made id
 * would corrupt the ordering) — there is no shared key to join on. Two things
 * keep that from clearing the wrong bubble: only messages newer than the
 * prompt's watermark are candidates, so repeating something said earlier in the
 * thread does not match the old message; and each message is consumed by at
 * most one prompt, so sending the same text twice in a row clears one bubble
 * per arrival rather than both at once.
 */
export function reconcileOptimisticPrompts(
  pending: OptimisticPrompt[],
  messages: SessionMessage[] | undefined
): OptimisticPrompt[] {
  if (pending.length === 0) {
    return pending;
  }
  const available = (messages ?? []).flatMap((message) => {
    const text = userMessageText(message);
    return text === undefined ? [] : [{ id: message.info.id, text }];
  });

  const remaining = pending.filter((prompt) => {
    const index = available.findIndex(
      (candidate) =>
        candidate.text === prompt.text &&
        (prompt.afterMessageId === undefined ||
          candidate.id > prompt.afterMessageId)
    );
    if (index === -1) {
      return true;
    }
    available.splice(index, 1);
    return false;
  });
  // Returning the original array when nothing matched keeps callers from
  // re-rendering on every transcript update.
  return remaining.length === pending.length ? pending : remaining;
}
