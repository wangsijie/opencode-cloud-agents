import { useEffect, useRef, type ReactNode } from 'react';
import type { SessionMessage } from '../api';
import { isRenderablePart, PartView } from './PartView';

/**
 * The conversation.
 *
 * `trailing` holds messages the user has sent that the transcript does not
 * carry yet. They belong inside this list rather than after it so they scroll,
 * wrap and follow the bottom exactly like the real ones.
 */
export function MessageList({
  messages,
  trailing
}: {
  messages: SessionMessage[];
  trailing?: ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the conversation while the reader is at the bottom, but never yank
  // the view away from someone who has scrolled up to read.
  useEffect(() => {
    const onScroll = () => {
      const distance =
        document.documentElement.scrollHeight -
        window.scrollY -
        window.innerHeight;
      pinned.current = distance < 120;
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (pinned.current) {
      end.current?.scrollIntoView({ block: 'end' });
    }
  }, [messages, trailing]);

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
                <PartView key={part.id} part={part} />
              ))}
              {failure ? (
                <p className="message-failure">
                  {failure.data?.message ?? failure.name ?? '生成中断'}
                </p>
              ) : null}
            </div>
          </article>
        );
      })}
      {trailing}
      <div ref={end} />
    </div>
  );
}
