import type { MessagePart, QuestionInfo } from './api';

/**
 * Reading a `question` tool call's arguments. The transcript carries the ask
 * as the call's own input, so the card renders from the part rather than from
 * the pending request — which it may not have found yet, and will not have at
 * all once the call has settled.
 */

/**
 * The questions asked, read from the tool call's own input.
 *
 * A malformed entry voids the whole set: a card that dropped one question of
 * three would submit answers misaligned against the request's own order.
 */
export function questionsFromPart(part: MessagePart): QuestionInfo[] {
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
      // OpenCode's schema documents `custom` as defaulting to true and its own
      // client reads it as `custom !== false`. The field is optional and a
      // model rarely mentions it, so reading an absent one as `false` is what
      // left every card options-only.
      ...(custom === false ? {} : { custom: true })
    });
  }
  return questions;
}

/** The recorded answers of a settled call, aligned to question order. */
export function answersFromPart(part: MessagePart): string[][] | undefined {
  const raw = part.state?.metadata?.answers;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  return raw.map((entry) =>
    Array.isArray(entry) ? entry.filter((value) => typeof value === 'string') : []
  );
}
