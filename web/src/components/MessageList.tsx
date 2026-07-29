import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import type { MessagePart, SessionMessage } from '../api';
import { turnDiffsByMessage } from '../patch-diffs';
import { CopyButton } from './CopyButton';
import { isRenderablePart, PartView } from './PartView';

/**
 * What copying a message puts on the clipboard: what it says, and nothing else.
 *
 * Tool calls, reasoning and patches are the work behind the answer rather than
 * the answer, so only the text parts come along — which also means a message
 * that is pure machinery offers no copy button at all.
 */
function messageText(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n')
    .trim();
}

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
        const copyable = messageText(parts);
        const isUser = message.info.role === 'user';
        const lastTextIndex = parts.reduce(
          (last, part, index) => (part.type === 'text' ? index : last),
          -1
        );
        return (
          <article key={message.info.id} className={`message ${message.info.role}`}>
            <div className="message-body">
              {parts.map((part, index) => {
                const partView = (
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
                );
                if (isUser || !copyable || index !== lastTextIndex) {
                  return partView;
                }
                return (
                  <div key={part.id} className="copyable-text">
                    {partView}
                    <div className="message-actions">
                      <CopyButton
                        text={copyable}
                        label={
                          message.info.role === 'user'
                            ? 'Copy your message'
                            : 'Copy the reply'
                        }
                      />
                    </div>
                  </div>
                );
              })}
              {failure ? (
                <p className="message-failure">
                  {failure.data?.message ?? failure.name ?? 'Generation interrupted'}
                </p>
              ) : null}
            </div>
            {isUser && copyable ? (
              <div className="message-actions user-message-actions">
                <CopyButton text={copyable} label="Copy your message" />
              </div>
            ) : null}
          </article>
        );
      })}
      {trailing}
    </div>
  );
}
