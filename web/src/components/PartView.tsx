import { useState } from 'react';
import remarkBreaks from 'remark-breaks';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import { code } from '@streamdown/code';
import { math } from '@streamdown/math';
import type { MessageDiff, MessagePart } from '../api';
import { agentPath, isPlainClick, navigate } from '../router';
import { ChevronRightIcon } from './icons';
import { PatchView } from './PatchView';

/*
 * Module-level so the references stay stable across renders — Streamdown
 * memoizes blocks by reference. The `remarkPlugins` prop REPLACES the
 * defaults, so gfm + codeMeta must be spread back in or tables silently stop
 * rendering. remark-breaks stays on top: agent output is written for a
 * terminal, where a single newline is a line break, and plain markdown would
 * fold a 40-line answer into one paragraph.
 */
const REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkBreaks];
const STREAMDOWN_PLUGINS = { code, math };
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
 * The subagent session a `task` call is running, once it has one.
 *
 * OpenCode's task tool creates a child session and reports its id in the
 * call's own metadata — the single thread between a one-line tool call and the
 * whole conversation behind it. Before the call starts there is no metadata and
 * no session, so this answers `undefined` and the row stays inert rather than
 * offering a link to nowhere.
 */
export function taskChildSessionId(part: MessagePart): string | undefined {
  if (part.type !== 'tool' || part.tool !== 'task') {
    return undefined;
  }
  const metadata = part.state?.metadata;
  const id = metadata?.sessionId ?? metadata?.sessionID;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * A tool call, as one line.
 *
 * The full input and output are not repeated here: the useful signal is which
 * tool ran, on what, and whether it finished.
 *
 * A `task` call is the exception, because its output is a summary of a whole
 * conversation that happened elsewhere. Given the session it belongs to, the
 * row becomes the way into that conversation — a link, so middle-click and
 * open-in-new-tab work the way they look like they should.
 */
function ToolCall({ part, sessionId }: { part: MessagePart; sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const status = part.state?.status;
  const title = part.state?.title;
  const child = sessionId ? taskChildSessionId(part) : undefined;
  const expandable = Boolean(title && !child);

  const body = (
    <>
      <span className="tool-name mono">{part.tool ?? 'tool'}</span>
      {title ? <span className="tool-title">{title}</span> : null}
      {status && status !== 'completed' ? (
        <span className="tool-status">{status}</span>
      ) : null}
      {child || expandable ? (
        <span className="tool-open" aria-hidden="true">
          <ChevronRightIcon />
        </span>
      ) : null}
    </>
  );

  if (!child || !sessionId) {
    if (!expandable) {
      return <div className={`part-tool tool-${status ?? 'unknown'}`}>{body}</div>;
    }
    return (
      <button
        type="button"
        className={`part-tool tool-disclosure tool-${status ?? 'unknown'}${open ? ' open' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {body}
      </button>
    );
  }

  const href = agentPath(sessionId, child);
  return (
    <a
      className={`part-tool part-task tool-${status ?? 'unknown'}`}
      href={href}
      title="Open this subagent's conversation"
      onClick={(event) => {
        if (!isPlainClick(event)) {
          return;
        }
        event.preventDefault();
        navigate(href);
      }}
    >
      {body}
    </a>
  );
}

/**
 * A subagent the user asked for by name, rather than one the model started.
 *
 * It carries the request and not the conversation — there is no session id to
 * follow — so it reads as the one line it is, and the `task` tool call that
 * follows is what becomes enterable.
 */
function Subtask({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false);
  const agent = typeof part.agent === 'string' ? part.agent : 'subagent';
  const description =
    typeof part.description === 'string' ? part.description : undefined;
  if (!description) {
    return (
      <div className="part-tool part-subtask">
        <span className="tool-name mono">{agent}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={`part-tool part-subtask tool-disclosure${open ? ' open' : ''}`}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="tool-name mono">{agent}</span>
      <span className="tool-title">{description}</span>
      <span className="tool-open" aria-hidden="true">
        <ChevronRightIcon />
      </span>
    </button>
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

/**
 * `sessionId` is the Hub session this transcript belongs to. A subagent is
 * addressable only inside one, so without it a `task` call has nowhere to lead
 * and renders as the plain row it always did.
 *
 * `turnDiffs` is the file-by-file diff of the user turn this part sits in,
 * which is where a `patch` part finds its content.
 */
export function PartView({
  part,
  sessionId,
  turnDiffs
}: {
  part: MessagePart;
  sessionId?: string;
  turnDiffs?: MessageDiff[];
}) {
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
      return <ToolCall part={part} sessionId={sessionId} />;
    case 'subtask':
      return <Subtask part={part} />;
    case 'todo':
      return <Todo part={part} />;
    case 'patch':
      return <PatchView part={part} diffs={turnDiffs} />;
    case 'file': {
      // An image attachment sent with a prompt; the url is a data URL, so it
      // renders without another request. Other mimes just name themselves.
      const mime = typeof part.mime === 'string' ? part.mime : '';
      const url = typeof part.url === 'string' ? part.url : undefined;
      const filename =
        typeof part.filename === 'string' ? part.filename : undefined;
      if (url && mime.startsWith('image/')) {
        return (
          <img
            className="part-image"
            src={url}
            alt={filename ?? 'Attached image'}
          />
        );
      }
      return (
        <div className="part-placeholder">{filename ?? 'Attachment'}</div>
      );
    }
    default:
      // Named rather than hidden: an unrendered part is still evidence that
      // something happened, and the type is what tells us what to build next.
      return <div className="part-placeholder">Unsupported part type: {part.type}</div>;
  }
}
