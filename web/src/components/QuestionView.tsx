import { useEffect, useMemo, useState } from 'react';
import {
  answerQuestion,
  dismissQuestion,
  fetchPendingQuestions,
  type MessagePart,
  type QuestionInfo,
  type QuestionRequest
} from '../api';

/**
 * The `question` tool: the agent stops and asks, and the tool call stays
 * `running` until somebody answers through the Hub. This card is that
 * somebody's form — and, once the call has settled, the record of what was
 * asked and chosen.
 */

/**
 * How long a pending card keeps looking for its request before concluding it
 * is not answerable. The request registers in the container at the same moment
 * the part starts streaming, so one retry usually settles the race; the rest
 * of the budget covers a container mid-wake.
 */
const MATCH_ATTEMPTS = 10;
const MATCH_RETRY_MS = 3_000;

/** The questions asked, read from the tool call's own input. */
function questionsFromPart(part: MessagePart): QuestionInfo[] {
  const raw = part.state?.input?.questions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: QuestionInfo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { question, header, options, multiple, custom } = entry as {
      question?: unknown;
      header?: unknown;
      options?: unknown;
      multiple?: unknown;
      custom?: unknown;
    };
    if (typeof question !== 'string' || !question) {
      return [];
    }
    const parsedOptions = Array.isArray(options)
      ? options.flatMap((option) => {
          const label = (option as { label?: unknown })?.label;
          const description = (option as { description?: unknown })?.description;
          return typeof label === 'string' && label
            ? [{ label, description: typeof description === 'string' ? description : '' }]
            : [];
        })
      : [];
    questions.push({
      question,
      header: typeof header === 'string' ? header : '',
      options: parsedOptions,
      ...(multiple === true ? { multiple: true } : {}),
      ...(custom === true ? { custom: true } : {})
    });
  }
  return questions;
}

/** The recorded answers of a settled call, aligned to question order. */
function answersFromPart(part: MessagePart): string[][] | undefined {
  const raw = part.state?.metadata?.answers;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.map((entry) =>
    Array.isArray(entry) ? entry.filter((value) => typeof value === 'string') : []
  );
}

function QuestionHeading({ question }: { question: QuestionInfo }) {
  return (
    <p className="question-text">
      {question.header ? <span className="question-tag">{question.header}</span> : null}
      {question.question}
    </p>
  );
}

/**
 * A settled ask, or one nobody can answer from here: what was asked, and — when
 * the call completed — what was chosen. The full option list is only worth the
 * space while choosing is still possible, so an answered question collapses to
 * its answers.
 */
function SettledQuestions({
  questions,
  answers,
  note
}: {
  questions: QuestionInfo[];
  answers?: string[][];
  note?: string;
}) {
  return (
    <div className="part-question">
      {questions.map((question, index) => {
        const chosen = answers?.[index];
        return (
          <div className="question-item" key={index}>
            <QuestionHeading question={question} />
            {chosen ? (
              <div className="question-options">
                {chosen.length > 0 ? (
                  chosen.map((answer) => (
                    <span className="question-option chosen" key={answer}>
                      {answer}
                    </span>
                  ))
                ) : (
                  <span className="question-option unanswered">Unanswered</span>
                )}
              </div>
            ) : (
              <div className="question-options">
                {question.options.map((option) => (
                  <span
                    className="question-option static"
                    key={option.label}
                    title={option.description}
                  >
                    {option.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {note ? <p className="question-note">{note}</p> : null}
    </div>
  );
}

/**
 * The live form. It has to find its `QuestionRequest` first — the transcript
 * part carries the questions but not the request id — by matching `callID`
 * against the session's pending list. Until that lands the options are already
 * clickable; only Answer waits.
 */
function PendingQuestions({
  questions,
  sessionId,
  callId
}: {
  questions: QuestionInfo[];
  sessionId: string;
  callId: string;
}) {
  const [request, setRequest] = useState<QuestionRequest>();
  /** Set once looking is over and nothing turned up: why answering is off. */
  const [stale, setStale] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState<{ answers?: string[][]; note: string }>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string[][]>(() =>
    questions.map(() => [])
  );
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ''));

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const look = async () => {
      attempts += 1;
      try {
        const pending = await fetchPendingQuestions(sessionId);
        if (cancelled) {
          return;
        }
        const match = pending.questions.find(
          (entry) => entry.tool?.callID === callId
        );
        if (match) {
          setRequest(match);
          return;
        }
        // Asleep, the request is gone with the container's memory; there is
        // nothing to keep polling for.
        if (pending.state === 'sleeping') {
          setStale(
            'The session went to sleep, taking this pending question with it. Send a message to continue the conversation.'
          );
          return;
        }
      } catch {
        // A failed probe reads the same as "not found yet": retry, and let the
        // attempt budget turn persistent failure into the settled note.
      }
      if (attempts >= MATCH_ATTEMPTS) {
        setStale(
          'There is no pending question to answer here — it may have been answered from somewhere else.'
        );
        return;
      }
      timer = window.setTimeout(() => void look(), MATCH_RETRY_MS);
    };
    void look();
    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [sessionId, callId]);

  if (settled) {
    return (
      <SettledQuestions
        questions={questions}
        answers={settled.answers}
        note={settled.note}
      />
    );
  }
  if (stale) {
    return <SettledQuestions questions={questions} note={stale} />;
  }

  const toggle = (index: number, label: string, multiple: boolean) => {
    setSelected((current) =>
      current.map((entry, i) => {
        if (i !== index) {
          return entry;
        }
        if (multiple) {
          return entry.includes(label)
            ? entry.filter((value) => value !== label)
            : [...entry, label];
        }
        return entry.includes(label) ? [] : [label];
      })
    );
  };

  const answers = questions.map((_, index) => {
    const typed = custom[index]?.trim();
    return typed ? [...selected[index], typed] : [...selected[index]];
  });
  const complete = answers.every((entry) => entry.length > 0);

  async function submit() {
    if (!request || busy || !complete) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await answerQuestion(sessionId, request.id, answers);
      // The event stream will shortly deliver the completed part; until it
      // does, this stands in as the same settled rendering.
      setSettled({ answers, note: 'Answered — the agent is continuing.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    if (!request || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await dismissQuestion(sessionId, request.id);
      setSettled({ note: 'Dismissed — the agent continues without answers.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="part-question pending">
      {questions.map((question, index) => (
        <div className="question-item" key={index}>
          <QuestionHeading question={question} />
          <div className="question-options">
            {question.options.map((option) => (
              <button
                type="button"
                key={option.label}
                className={`question-option${selected[index].includes(option.label) ? ' selected' : ''}`}
                aria-pressed={selected[index].includes(option.label)}
                disabled={busy}
                onClick={() => toggle(index, option.label, question.multiple === true)}
              >
                <span className="option-label">{option.label}</span>
                {option.description ? (
                  <span className="option-desc">{option.description}</span>
                ) : null}
              </button>
            ))}
          </div>
          {question.custom ? (
            <input
              className="question-custom"
              type="text"
              placeholder="Your own answer…"
              value={custom[index] ?? ''}
              disabled={busy}
              onChange={(event) =>
                setCustom((current) =>
                  current.map((entry, i) => (i === index ? event.target.value : entry))
                )
              }
            />
          ) : null}
        </div>
      ))}
      {error ? (
        <p className="question-note error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="question-actions">
        <button
          type="button"
          className="button primary"
          disabled={!request || busy || !complete}
          title={request ? undefined : 'Looking for the pending question…'}
          onClick={() => void submit()}
        >
          Answer
        </button>
        <button
          type="button"
          className="button"
          disabled={!request || busy}
          onClick={() => void dismiss()}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function QuestionView({
  part,
  sessionId
}: {
  part: MessagePart;
  sessionId?: string;
}) {
  const questions = useMemo(() => questionsFromPart(part), [part]);
  const status = part.state?.status;
  const callId = typeof part.callID === 'string' ? part.callID : undefined;

  if (questions.length === 0) {
    // The input is still streaming in, or an OpenCode upgrade changed its
    // shape. Either way there is nothing to choose from yet.
    return <div className="part-placeholder">The agent is asking a question…</div>;
  }
  if (status === 'running' && sessionId && callId) {
    return (
      <PendingQuestions
        questions={questions}
        sessionId={sessionId}
        callId={callId}
      />
    );
  }
  return (
    <SettledQuestions
      questions={questions}
      answers={answersFromPart(part)}
      note={status === 'error' ? 'Dismissed without an answer.' : undefined}
    />
  );
}
