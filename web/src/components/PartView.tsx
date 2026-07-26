import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import type { MessagePart } from '../api';

/**
 * Structural parts the agent loop emits around its actual output.
 *
 * These carry no content for a reader — they mark where a step began and ended
 * — so they are skipped outright rather than shown as an unknown type.
 */
const STRUCTURAL_TYPES = new Set(['step-start', 'step-finish']);

export function isRenderablePart(part: MessagePart): boolean {
  if (STRUCTURAL_TYPES.has(part.type)) {
    return false;
  }
  // A text part exists before its first token arrives.
  return part.type !== 'text' || Boolean(part.text?.trim());
}

/** Reasoning is collapsed by default: it is context, not the answer. */
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="part-reasoning" open={open}>
      <summary onClick={(event) => {
        event.preventDefault();
        setOpen((value) => !value);
      }}>
        思考过程
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

/**
 * A tool call, as one line.
 *
 * The full input and output belong in the stock IDE; here the useful signal is
 * which tool ran, on what, and whether it finished.
 */
function ToolCall({ part }: { part: MessagePart }) {
  const status = part.state?.status;
  const title = part.state?.title;
  return (
    <div className={`part-tool tool-${status ?? 'unknown'}`}>
      <span className="tool-name mono">{part.tool ?? 'tool'}</span>
      {title ? <span className="tool-title">{title}</span> : null}
      {status && status !== 'completed' ? (
        <span className="tool-status">{status}</span>
      ) : null}
    </div>
  );
}

function Todo({ part }: { part: MessagePart }) {
  const todos = Array.isArray(part.todo)
    ? (part.todo as { content?: string; status?: string }[])
    : [];
  if (todos.length === 0) {
    return <div className="part-placeholder">待办列表</div>;
  }
  return (
    <ul className="part-todo">
      {todos.map((todo, index) => (
        <li key={index} className={`todo-${todo.status ?? 'pending'}`}>
          {todo.content ?? ''}
        </li>
      ))}
    </ul>
  );
}

export function PartView({ part }: { part: MessagePart }) {
  switch (part.type) {
    case 'text':
      return (
        <div className="part-text">
          {/*
            Agent output is written for a terminal, where a single newline is a
            line break. Plain markdown would fold those into spaces and collapse
            a 40-line answer into one paragraph, so soft breaks are preserved.
          */}
          <Markdown remarkPlugins={[remarkBreaks]}>{part.text ?? ''}</Markdown>
        </div>
      );
    case 'reasoning':
      return <Reasoning text={part.text ?? ''} />;
    case 'tool':
      return <ToolCall part={part} />;
    case 'todo':
      return <Todo part={part} />;
    default:
      // Named rather than hidden: an unrendered part is still evidence that
      // something happened, and the type is what tells us what to build next.
      return <div className="part-placeholder">未支持的内容类型：{part.type}</div>;
  }
}
