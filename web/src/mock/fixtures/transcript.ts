/**
 * Transcript fixtures.
 *
 * `idleTranscript` is the kitchen sink: it exercises every part type the
 * renderer handles (text, reasoning, tool by several tools and states, subtask,
 * todo, patch, file, step markers, unknown types) plus a message-level error.
 * Message ids are zero-padded because the transcript is ordered by comparing
 * ids as strings.
 */
import type { AgentSessionEntry, MessageDiff, SessionMessage } from '../../api';
import { msAgo, wholeFilePatch } from './util';

/** 1×1 transparent PNG, so the image-attachment branch renders offline. */
export const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const MIDDLEWARE_DIFF_LINES = [
  "-import { verifyToken } from './tokens';",
  "+import { TokenError, verifyToken } from './tokens';",
  ' ',
  ' export function authMiddleware(req, res, next) {',
  "-  const token = req.headers.authorization;",
  "+  const header = req.headers.authorization ?? '';",
  "+  const token = header.replace(/^Bearer /, '');",
  '   if (!token) {',
  '-    return res.status(401).end();',
  "+    return res.status(401).json({ error: 'Missing bearer token' });",
  '   }',
  '-  req.user = verifyToken(token);',
  '+  try {',
  '+    req.user = verifyToken(token);',
  '+  } catch (cause) {',
  '+    if (cause instanceof TokenError) {',
  '+      return res.status(401).json({ error: cause.message });',
  '+    }',
  '+    throw cause;',
  '+  }',
  '   next();',
  ' }'
];

const TOKENS_DIFF_LINES = [
  " import { createVerifier } from 'fast-jwt';",
  ' ',
  '+export class TokenError extends Error {}',
  '+',
  ' const verifier = createVerifier({ key: process.env.JWT_SECRET });',
  ' ',
  ' export function verifyToken(token) {',
  '-  return verifier(token);',
  '+  try {',
  '+    return verifier(token);',
  '+  } catch {',
  "+    throw new TokenError('Token expired or malformed');",
  '+  }',
  ' }'
];

/** The turn's diff summary, stored on the user message that opened the turn. */
const TURN_DIFFS: MessageDiff[] = [
  {
    file: 'src/auth/middleware.ts',
    patch: wholeFilePatch('src/auth/middleware.ts', MIDDLEWARE_DIFF_LINES),
    additions: 12,
    deletions: 4,
    status: 'modified'
  },
  {
    file: 'src/auth/tokens.ts',
    patch: wholeFilePatch('src/auth/tokens.ts', TOKENS_DIFF_LINES),
    additions: 7,
    deletions: 1,
    status: 'modified'
  }
];

const ANSWER_MARKDOWN = `## What I changed

The middleware now parses the \`Authorization\` header properly and answers
with JSON error bodies instead of bare 401s.

| Concern | Before | After |
| --- | --- | --- |
| Bearer prefix | ignored | stripped before verification |
| Expired token | uncaught throw → 500 | typed \`TokenError\` → 401 |
| Error body | empty | \`{ "error": "…" }\` |

Key part of the new implementation:

\`\`\`ts
try {
  req.user = verifyToken(token);
} catch (cause) {
  if (cause instanceof TokenError) {
    return res.status(401).json({ error: cause.message });
  }
  throw cause;
}
\`\`\`

Remaining follow-ups:

- Wire the same error shape into the login route
- Consider rate-limiting repeated 401s per IP`;

/** Kitchen-sink transcript for the idle session. */
export function idleTranscript(): SessionMessage[] {
  return [
    {
      info: {
        id: 'msg_0001',
        role: 'user',
        time: { created: msAgo(50 * 60_000) },
        summary: { diffs: TURN_DIFFS }
      },
      parts: [
        {
          id: 'prt_0001',
          messageID: 'msg_0001',
          type: 'text',
          text: 'Refactor the auth middleware: parse the Bearer prefix properly, add typed token errors, and answer with JSON error bodies. Here is the mockup and my old notes.'
        },
        {
          id: 'prt_0002',
          messageID: 'msg_0001',
          type: 'file',
          mime: 'image/png',
          filename: 'mockup.png',
          url: TINY_PNG_DATA_URL
        },
        {
          id: 'prt_0003',
          messageID: 'msg_0001',
          type: 'file',
          mime: 'application/pdf',
          filename: 'auth-notes.pdf'
        }
      ]
    },
    {
      info: {
        id: 'msg_0002',
        role: 'assistant',
        modelID: 'anthropic/claude-opus-4-5',
        parentID: 'msg_0001',
        time: { created: msAgo(49 * 60_000), completed: msAgo(45 * 60_000) }
      },
      parts: [
        { id: 'prt_0010', messageID: 'msg_0002', type: 'step-start' },
        {
          id: 'prt_0011',
          messageID: 'msg_0002',
          type: 'reasoning',
          text: 'The current middleware passes the raw Authorization header to the verifier, so "Bearer xxx" never verifies. I should strip the prefix, and wrap verification in a try/catch that maps TokenError to a 401 with a JSON body.\n\nI also need to keep the untyped errors propagating — a 500 for a broken secret is correct, only expired/malformed tokens are the client’s fault.'
        },
        {
          id: 'prt_0012',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'read',
          state: { status: 'completed', title: 'src/auth/middleware.ts' }
        },
        {
          id: 'prt_0013',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'edit',
          state: { status: 'completed', title: 'src/auth/middleware.ts' }
        },
        {
          id: 'prt_0014',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', title: 'pnpm test' }
        },
        // An empty text part exists before its first token arrives; the
        // renderer must filter it, and this fixture proves it does.
        { id: 'prt_0015', messageID: 'msg_0002', type: 'text', text: '' },
        {
          id: 'prt_0016',
          messageID: 'msg_0002',
          type: 'patch',
          hash: 'a1b2c3d4',
          files: [
            '/workspace/opencode-cloud/src/auth/middleware.ts',
            '/workspace/opencode-cloud/src/auth/tokens.ts'
          ]
        },
        {
          id: 'prt_0017',
          messageID: 'msg_0002',
          type: 'todo',
          todo: [
            { content: 'Parse the Bearer prefix', status: 'completed' },
            { content: 'Introduce TokenError and map it to 401', status: 'completed' },
            { content: 'Align the login route error shape', status: 'in_progress' },
            { content: 'Add per-IP rate limiting for 401s', status: 'pending' },
            { content: 'Migrate sessions table to KV', status: 'cancelled' }
          ]
        },
        {
          id: 'prt_0018',
          messageID: 'msg_0002',
          type: 'text',
          text: ANSWER_MARKDOWN
        },
        { id: 'prt_0019', messageID: 'msg_0002', type: 'step-finish' }
      ]
    },
    {
      info: {
        id: 'msg_0003',
        role: 'user',
        time: { created: msAgo(40 * 60_000) }
      },
      parts: [
        {
          id: 'prt_0020',
          messageID: 'msg_0003',
          type: 'text',
          text: 'Now have a reviewer subagent double-check the change for auth bypasses.'
        }
      ]
    },
    {
      info: {
        id: 'msg_0004',
        role: 'assistant',
        modelID: 'anthropic/claude-opus-4-5',
        parentID: 'msg_0003',
        time: { created: msAgo(39 * 60_000), completed: msAgo(35 * 60_000) }
      },
      parts: [
        {
          id: 'prt_0030',
          messageID: 'msg_0004',
          type: 'subtask',
          agent: 'reviewer',
          description: 'Review the middleware change for auth bypasses'
        },
        {
          id: 'prt_0031',
          messageID: 'msg_0004',
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            title: 'Review auth middleware',
            metadata: { sessionId: 'agt_review' }
          }
        },
        {
          id: 'prt_0032',
          messageID: 'msg_0004',
          type: 'text',
          text: 'The reviewer found no bypass: the empty-token case still short-circuits before verification, and non-`TokenError` throws still become 500s rather than silent passes. One nit — the regex accepts `bearer` in lower case only after my fix; it now matches case-insensitively.'
        }
      ]
    },
    {
      info: {
        id: 'msg_0005',
        role: 'user',
        time: { created: msAgo(30 * 60_000) }
      },
      parts: [
        {
          id: 'prt_0040',
          messageID: 'msg_0005',
          type: 'text',
          text: 'Fetch the OWASP authentication cheat sheet and align our error copy with it.'
        }
      ]
    },
    {
      info: {
        id: 'msg_0006',
        role: 'assistant',
        modelID: 'anthropic/claude-opus-4-5',
        parentID: 'msg_0005',
        // No `completed`, and an error: the failure line renders under the
        // partial output.
        time: { created: msAgo(29 * 60_000) },
        error: { name: 'MessageAbortedError', data: { message: 'Aborted by user' } }
      },
      parts: [
        {
          id: 'prt_0050',
          messageID: 'msg_0006',
          type: 'tool',
          tool: 'webfetch',
          state: {
            status: 'error',
            title: 'https://cheatsheetseries.owasp.org/authentication'
          }
        },
        // A part type this UI does not know yet — renders the placeholder.
        { id: 'prt_0051', messageID: 'msg_0006', type: 'snapshot', snapshot: 'snap_9f2' },
        {
          id: 'prt_0052',
          messageID: 'msg_0006',
          type: 'text',
          text: 'The fetch failed behind the proxy, so I was going to fall back to the cached copy under docs/ when'
        }
      ]
    }
  ];
}

/** Reviewer subagent conversation; contains a nested task → grep-scout. */
export function reviewerTranscript(): SessionMessage[] {
  return [
    {
      info: { id: 'msg_0001', role: 'user', time: { created: msAgo(39 * 60_000) } },
      parts: [
        {
          id: 'prt_0001',
          messageID: 'msg_0001',
          type: 'text',
          text: 'Review the auth middleware change for auth bypasses. Focus on the empty-token path and the error mapping.'
        }
      ]
    },
    {
      info: {
        id: 'msg_0002',
        role: 'assistant',
        modelID: 'anthropic/claude-opus-4-5',
        parentID: 'msg_0001',
        time: { created: msAgo(38 * 60_000), completed: msAgo(36 * 60_000) }
      },
      parts: [
        {
          id: 'prt_0010',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'read',
          state: { status: 'completed', title: 'src/auth/middleware.ts' }
        },
        {
          id: 'prt_0011',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'task',
          state: {
            status: 'completed',
            title: 'Scan for auth bypass patterns',
            metadata: { sessionId: 'agt_review_grep' }
          }
        },
        {
          id: 'prt_0012',
          messageID: 'msg_0002',
          type: 'text',
          text: 'No bypass found. The empty-token branch still returns before verification, `TokenError` maps to 401, and everything else propagates as 500. Nit: make the Bearer prefix match case-insensitive.'
        }
      ]
    }
  ];
}

/** The grep-scout the reviewer spawned — third breadcrumb level. */
export function grepScoutTranscript(): SessionMessage[] {
  return [
    {
      info: { id: 'msg_0001', role: 'user', time: { created: msAgo(38 * 60_000) } },
      parts: [
        {
          id: 'prt_0001',
          messageID: 'msg_0001',
          type: 'text',
          text: 'Grep the repo for places that read req.user without going through authMiddleware.'
        }
      ]
    },
    {
      info: {
        id: 'msg_0002',
        role: 'assistant',
        modelID: 'anthropic/claude-sonnet-4-5',
        parentID: 'msg_0001',
        time: { created: msAgo(37 * 60_000), completed: msAgo(37 * 60_000) }
      },
      parts: [
        {
          id: 'prt_0010',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'grep',
          state: { status: 'completed', title: 'req\\.user' }
        },
        {
          id: 'prt_0011',
          messageID: 'msg_0002',
          type: 'text',
          text: 'Two hits, both inside routes mounted after the middleware. No unauthenticated access path.'
        }
      ]
    }
  ];
}

export function idleLineages(): Record<string, AgentSessionEntry[]> {
  const root: AgentSessionEntry = {
    id: 'oc_root',
    title: 'Refactor auth middleware with subagent review'
  };
  const reviewer: AgentSessionEntry = {
    id: 'agt_review',
    title: 'Review auth middleware',
    agent: 'reviewer',
    parentID: 'oc_root'
  };
  return {
    agt_review: [root, reviewer],
    agt_review_grep: [
      root,
      reviewer,
      {
        id: 'agt_review_grep',
        title: 'Scan for auth bypass patterns',
        agent: 'grep-scout',
        parentID: 'agt_review'
      }
    ]
  };
}

/** Static prefix for the live-streaming session; the ticker appends to it. */
export function workingTranscript(): SessionMessage[] {
  return [
    {
      info: { id: 'msg_0001', role: 'user', time: { created: msAgo(9 * 60_000) } },
      parts: [
        {
          id: 'prt_0001',
          messageID: 'msg_0001',
          type: 'text',
          text: 'Add a dark-mode toggle to the settings page. Respect prefers-color-scheme as the default and persist the override.'
        }
      ]
    },
    {
      info: {
        id: 'msg_0002',
        role: 'assistant',
        modelID: 'anthropic/claude-opus-4-5',
        parentID: 'msg_0001',
        time: { created: msAgo(8 * 60_000), completed: msAgo(7 * 60_000) }
      },
      parts: [
        {
          id: 'prt_0010',
          messageID: 'msg_0002',
          type: 'tool',
          tool: 'glob',
          state: { status: 'completed', title: 'web/src/**/Settings*' }
        },
        {
          id: 'prt_0011',
          messageID: 'msg_0002',
          type: 'text',
          text: 'Found the settings page and the theme tokens. I will add a three-state toggle (system / light / dark), store the override in localStorage, and stamp `data-theme` on the root element. Starting with the state hook.'
        }
      ]
    }
  ];
}

/** A short two-message exchange, reused by several mirror-state fixtures. */
export function shortTranscript(topic: {
  prompt: string;
  reply: string;
  baseMinutesAgo: number;
}): SessionMessage[] {
  return [
    {
      info: {
        id: 'msg_0001',
        role: 'user',
        time: { created: msAgo(topic.baseMinutesAgo * 60_000) }
      },
      parts: [
        {
          id: 'prt_0001',
          messageID: 'msg_0001',
          type: 'text',
          text: topic.prompt
        }
      ]
    },
    {
      info: {
        id: 'msg_0002',
        role: 'assistant',
        modelID: 'anthropic/claude-sonnet-4-5',
        parentID: 'msg_0001',
        time: {
          created: msAgo(topic.baseMinutesAgo * 60_000 - 60_000),
          completed: msAgo(topic.baseMinutesAgo * 60_000 - 120_000)
        }
      },
      parts: [
        {
          id: 'prt_0010',
          messageID: 'msg_0002',
          type: 'text',
          text: topic.reply
        }
      ]
    }
  ];
}
