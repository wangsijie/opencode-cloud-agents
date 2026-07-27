import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { SessionMessage } from '../api';
import { turnDiffsByMessage } from '../patch-diffs';
import { isRenderablePart, PartView } from './PartView';

/**
 * The conversation.
 *
 * `trailing` holds messages the user has sent that the transcript does not
 * carry yet. They belong inside this list rather than after it so they scroll,
 * wrap and follow the bottom exactly like the real ones.
 *
 * The list does not own its scrollbar — the page's content area does, so the
 * header and composer can stay put — which is why the container arrives as a
 * ref rather than being found here.
 */
export function MessageList({
  messages,
  trailing,
  scrollerRef,
  sessionId
}: {
  messages: SessionMessage[];
  trailing?: ReactNode;
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Which Hub session this is, so a `task` call can lead into its subagent. */
  sessionId?: string;
}) {
  const pinned = useRef(true);

  // A turn's diff lives on the user message that opened it, and the `patch`
  // parts that render it live on the assistant messages under it, so the join
  // happens here — where both sides of the conversation are in hand.
  const turnDiffs = useMemo(() => turnDiffsByMessage(messages), [messages]);

  // Follow the conversation while the reader is at the bottom, but never yank
  // the view away from someone who has scrolled up to read.
  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    const onScroll = () => {
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, [scrollerRef]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (pinned.current && node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages, trailing, scrollerRef]);

  return (
    <div className="messages">
      {messages.map((message) => {
        const parts = message.parts.filter(isRenderablePart);
        const failure = message.info.error;
        if (parts.length === 0 && !failure) {
          return null;
        }
        return (
          <article key={message.info.id} className={`message ${message.info.role}`}>
            <div className="message-body">
              {parts.map((part) => (
                <PartView
                  key={part.id}
                  part={part}
                  sessionId={sessionId}
                  turnDiffs={
                    message.info.parentID
                      ? turnDiffs.get(message.info.parentID)
                      : undefined
                  }
                />
              ))}
              {failure ? (
                <p className="message-failure">
                  {failure.data?.message ?? failure.name ?? 'Generation interrupted'}
                </p>
              ) : null}
            </div>
          </article>
        );
      })}
      {trailing}
    </div>
  );
}
