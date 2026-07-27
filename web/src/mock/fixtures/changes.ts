/**
 * `SessionChanges` fixtures for the changes panel.
 *
 * The panel splits `diff` on `diff --git` headers and keys each block by its
 * `+++ b/` path, so blocks must carry exact git-style headers. The file list
 * covers every `ChangedFile` status; blocks include a rename and a binary
 * marker; one fixture sets `diffTruncated`.
 */
import type { SessionChanges } from '../../api';
import {
  gitAdded,
  gitBinary,
  gitDeleted,
  gitModified,
  gitRenamed,
  minutesAgo
} from './util';

const MIDDLEWARE_BLOCK = gitModified('src/auth/middleware.ts', [
  "-import { verifyToken } from './tokens';",
  "+import { TokenError, verifyToken } from './tokens';",
  ' ',
  ' export function authMiddleware(req, res, next) {',
  "-  const token = req.headers.authorization;",
  "+  const header = req.headers.authorization ?? '';",
  "+  const token = header.replace(/^Bearer /i, '');",
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
]);

const TOKENS_BLOCK = gitModified('src/auth/tokens.ts', [
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
]);

const TEST_BLOCK = gitAdded('src/auth/middleware.test.ts', [
  "+import { describe, it } from 'node:test';",
  "+import assert from 'node:assert/strict';",
  "+import { authMiddleware } from './middleware';",
  '+',
  "+describe('authMiddleware', () => {",
  "+  it('rejects a missing token with a JSON body', () => {",
  '+    const res = fakeResponse();',
  '+    authMiddleware({ headers: {} }, res, () => assert.fail());',
  '+    assert.equal(res.statusCode, 401);',
  "+    assert.deepEqual(res.body, { error: 'Missing bearer token' });",
  '+  });',
  '+});'
]);

const LEGACY_BLOCK = gitDeleted('src/auth/legacy-session.ts', [
  '-// Cookie-based sessions, superseded by bearer tokens.',
  '-export function readLegacySession(req) {',
  "-  return req.cookies?.session ?? null;",
  '-}'
]);

const DOCS_BLOCK = gitRenamed('docs/auth.md', 'docs/authentication.md', [
  ' # Authentication',
  ' ',
  '-The API accepts a raw token in the Authorization header.',
  '+The API expects `Authorization: Bearer <token>`.',
  '+Errors come back as `{ "error": "…" }` with a 401 status.',
  ' ',
  ' Tokens are issued by the login route and expire after 12 hours.'
]);

const LOGO_BLOCK = gitBinary('web/assets/logo.png');

const CONFLICT_BLOCK = gitModified('src/routes/login.ts', [
  " import { issueToken } from '../auth/tokens';",
  ' ',
  ' export async function login(req, res) {',
  '+<<<<<<< HEAD',
  '+  const token = await issueToken(req.body, { ttlHours: 12 });',
  '+=======',
  '+  const token = await issueToken(req.body, { ttlHours: 24 });',
  '+>>>>>>> origin/main',
  '-  const token = await issueToken(req.body);',
  '   res.json({ token });',
  ' }'
]);

/** Rich fixture for the idle session: every status, nested paths, extras. */
export function idleChanges(): SessionChanges {
  return {
    observedAt: minutesAgo(1),
    repoKey: 'wangsijie/opencode-cloud',
    branch: 'opencode/refactor-auth',
    defaultBranch: 'main',
    onDefaultBranch: false,
    head: { sha: 'a1b2c3d', subject: 'wip: middleware refactor' },
    files: [
      { path: 'src/auth/middleware.ts', status: 'modified' },
      { path: 'src/auth/tokens.ts', status: 'modified' },
      { path: 'src/auth/middleware.test.ts', status: 'added' },
      { path: 'src/auth/legacy-session.ts', status: 'deleted' },
      {
        path: 'docs/authentication.md',
        status: 'renamed',
        renamedFrom: 'docs/auth.md'
      },
      { path: 'web/assets/logo.png', status: 'modified' },
      { path: 'src/routes/login.ts', status: 'conflicted' },
      { path: 'notes/scratchpad.md', status: 'untracked' }
    ],
    diff: [
      MIDDLEWARE_BLOCK,
      TOKENS_BLOCK,
      TEST_BLOCK,
      LEGACY_BLOCK,
      DOCS_BLOCK,
      LOGO_BLOCK,
      CONFLICT_BLOCK
    ].join('\n'),
    diffTruncated: false,
    unpushedCommits: 2,
    publishBranch: 'opencode/refactor-auth',
    remoteBranch: 'origin/opencode/refactor-auth'
  };
}

/** Smaller fixture for the streaming session, with the truncation note. */
export function workingChanges(): SessionChanges {
  return {
    observedAt: minutesAgo(0),
    repoKey: 'wangsijie/logto',
    branch: 'opencode/dark-mode-toggle',
    defaultBranch: 'master',
    onDefaultBranch: false,
    head: { sha: 'f9e8d7c', subject: 'feat: theme override store' },
    files: [
      { path: 'web/src/components/SettingsPage.tsx', status: 'modified' },
      { path: 'web/src/useTheme.ts', status: 'added' }
    ],
    diff: [
      gitModified('web/src/components/SettingsPage.tsx', [
        " import { useState } from 'react';",
        "+import { useTheme } from '../useTheme';",
        ' ',
        ' export function SettingsPage() {',
        '+  const { theme, setTheme } = useTheme();',
        '   return (',
        '     <section>',
        "+      <ThemeToggle value={theme} onChange={setTheme} />",
        '       <ProfileForm />',
        '     </section>',
        '   );',
        ' }'
      ]),
      gitAdded('web/src/useTheme.ts', [
        "+import { useEffect, useState } from 'react';",
        '+',
        "+export type Theme = 'system' | 'light' | 'dark';",
        '+',
        '+export function useTheme() {',
        "+  const [theme, setTheme] = useState<Theme>(",
        "+    () => (localStorage.getItem('theme') as Theme) ?? 'system'",
        '+  );',
        '+  useEffect(() => {',
        "+    localStorage.setItem('theme', theme);",
        "+    document.documentElement.dataset.theme = theme;",
        '+  }, [theme]);',
        '+  return { theme, setTheme };',
        '+}'
      ])
    ].join('\n'),
    diffTruncated: true,
    unpushedCommits: 0,
    publishBranch: 'opencode/dark-mode-toggle'
  };
}
