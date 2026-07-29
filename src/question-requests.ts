/**
 * The question-answering surface of the session API.
 *
 * OpenCode's `question` tool parks its call until a human replies through
 * `/question/{requestID}/reply` — which, in this deployment, only the Hub can
 * do. This module is the request-shape half: what a browser may submit as an
 * answer, bounded before it travels to a container.
 */

/** OpenCode request ids are short opaque tokens; anything else is refused. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Bounds on a submitted answer set. Generous against real use — OpenCode's
 * own ask UI tops out at a handful of questions with a handful of options —
 * while keeping a hostile body from parking megabytes on the container call.
 */
const MAX_QUESTIONS = 32;
const MAX_ANSWERS_PER_QUESTION = 32;
const MAX_ANSWER_LENGTH = 2_000;

export type QuestionAction =
  | { kind: 'reply'; requestId: string; answers: string[][] }
  | { kind: 'reject'; requestId: string };

/**
 * Validate one `POST .../questions` body.
 *
 * `{ requestID, answers }` answers the request; `{ requestID, reject: true }`
 * dismisses it. Anything else — including a body carrying both, whose intent
 * is ambiguous — answers `undefined` and the API refuses with a 400.
 */
export function normalizeQuestionAction(
  value: unknown
): QuestionAction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { requestID, answers, reject } = value as {
    requestID?: unknown;
    answers?: unknown;
    reject?: unknown;
  };
  if (typeof requestID !== 'string' || !REQUEST_ID_PATTERN.test(requestID)) {
    return undefined;
  }
  if (reject === true) {
    return answers === undefined
      ? { kind: 'reject', requestId: requestID }
      : undefined;
  }
  if (reject !== undefined && reject !== false) {
    return undefined;
  }
  const normalized = normalizeAnswers(answers);
  return normalized ? { kind: 'reply', requestId: requestID, answers: normalized } : undefined;
}

/**
 * One entry per question, in question order; each entry the selected option
 * labels (or free-text answers). An empty inner array is allowed — it is how
 * "Unanswered" travels — but the set as a whole must answer something.
 */
function normalizeAnswers(value: unknown): string[][] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) {
    return undefined;
  }
  const answers: string[][] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length > MAX_ANSWERS_PER_QUESTION) {
      return undefined;
    }
    for (const answer of entry) {
      if (
        typeof answer !== 'string' ||
        answer.length === 0 ||
        answer.length > MAX_ANSWER_LENGTH
      ) {
        return undefined;
      }
    }
    answers.push([...entry] as string[]);
  }
  if (answers.every((entry) => entry.length === 0)) {
    return undefined;
  }
  return answers;
}
