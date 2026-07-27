/**
 * Workspace tree fixture for the file browser.
 *
 * Covers nested directories, a symlink, an empty directory, a truncated
 * listing, a truncated large file and a binary file.
 */
import type { MockWorkspaceDir } from '../types';

const README = `# opencode-cloud

Experiment running the OpenCode web UI inside Cloudflare Sandbox.

## Local development

\`\`\`bash
pnpm dev        # worker + containers
pnpm dev:mock   # frontend only, mock data
\`\`\`
`;

const MIDDLEWARE = `import { TokenError, verifyToken } from './tokens';

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.replace(/^Bearer /i, '');
  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  try {
    req.user = verifyToken(token);
  } catch (cause) {
    if (cause instanceof TokenError) {
      return res.status(401).json({ error: cause.message });
    }
    throw cause;
  }
  next();
}
`;

const LOCKFILE_HEAD = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@opencode-ai/sdk':
        specifier: 1.18.4
        version: 1.18.4
# … (truncated in the mock fixture)
`;

export function repoWorkspace(): MockWorkspaceDir {
  return {
    type: 'dir',
    entries: {
      src: {
        type: 'dir',
        entries: {
          auth: {
            type: 'dir',
            entries: {
              'middleware.ts': { type: 'file', content: MIDDLEWARE },
              'tokens.ts': {
                type: 'file',
                content:
                  "import { createVerifier } from 'fast-jwt';\n\nexport class TokenError extends Error {}\n"
              },
              'middleware.test.ts': {
                type: 'file',
                content: "import { describe, it } from 'node:test';\n"
              }
            }
          },
          routes: {
            type: 'dir',
            entries: {
              'login.ts': {
                type: 'file',
                content: "export async function login(req, res) {}\n"
              }
            }
          },
          'index.ts': { type: 'file', content: "export {};\n" }
        }
      },
      web: {
        type: 'dir',
        entries: {
          assets: {
            type: 'dir',
            entries: {
              'logo.png': { type: 'file', binary: true, size: 48_213 }
            }
          },
          'index.html': {
            type: 'file',
            content: '<!doctype html>\n<div id="root"></div>\n'
          }
        }
      },
      docs: {
        type: 'dir',
        entries: {
          'authentication.md': {
            type: 'file',
            content: '# Authentication\n\nThe API expects `Authorization: Bearer <token>`.\n'
          }
        }
      },
      // Empty directory — renders the "Empty directory." row.
      tmp: { type: 'dir', entries: {} },
      // Truncated listing — renders the "first 2000 entries" note.
      vendor: {
        type: 'dir',
        truncated: true,
        entries: {
          'left-pad': { type: 'dir', entries: {} },
          'is-odd': { type: 'dir', entries: {} }
        }
      },
      'AGENTS.md': { type: 'symlink', content: README, size: README.length },
      'README.md': { type: 'file', content: README },
      'package.json': {
        type: 'file',
        content: '{\n  "name": "opencode-cloud",\n  "private": true\n}\n'
      },
      'pnpm-lock.yaml': {
        type: 'file',
        content: LOCKFILE_HEAD,
        truncated: true,
        size: 512_000
      },
      '.gitignore': { type: 'file', content: 'node_modules\ndist\n.wrangler\n' }
    }
  };
}
