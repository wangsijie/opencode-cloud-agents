import { useEffect, useRef } from 'react';
import type { SessionMessage } from '../api';
import { isRenderablePart, PartView } from './PartView';

export function MessageList({ messages }: { messages: SessionMessage[] }) {
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
  }, [messages]);

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
      <div ref={end} />
    </div>
  );
}
