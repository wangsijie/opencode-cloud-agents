import { useState } from 'react';
import remarkBreaks from 'remark-breaks';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { code } from '@streamdown/code';
import type { MessagePart } from '../api';

/*
 * Module-level so the references stay stable across renders — Streamdown
 * memoizes blocks by reference. The `remarkPlugins` prop REPLACES the
 * defaults, so gfm + codeMeta must be spread back in or tables silently stop
 * rendering. remark-breaks stays on top: agent output is written for a
 * terminal, where a single newline is a line break, and plain markdown would
 * fold a 40-line answer into one paragraph.
 */
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkBreaks];
const STREAMDOWN_PLUGINS = { code };
const CONTROLS = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: false
} as const;
const LINK_SAFETY = { enabled: false };

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
        Thinking
      </summary>
      <div className="reasoning-body">{text}</div>
    </details>
  );
}

/**
 * A tool call, as one line.
 *
 * The full input and output are not repeated here: the useful signal is which
 * tool ran, on what, and whether it finished.
 */
function ToolCall({ part }: { part: MessagePart }) {
  const status = part.state?.status;
  const title = part.state?.title;
  return (
    <div className={`part-tool tool-${status ?? 'unknown'}`}>
      <span className="tool-name mono">{part.tool ?? 'tool'}</span>
      {/* Truncated to one line in CSS; the tooltip is how a long command stays readable. */}
      {title ? <span className="tool-title" title={title}>{title}</span> : null}
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
    return <div className="part-placeholder">Todo list</div>;
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
          <Streamdown
            remarkPlugins={REMARK_PLUGINS}
            plugins={STREAMDOWN_PLUGINS}
            lineNumbers={false}
            controls={CONTROLS}
            linkSafety={LINK_SAFETY}
          >
            {part.text ?? ''}
          </Streamdown>
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
      return <div className="part-placeholder">Unsupported part type: {part.type}</div>;
  }
}
