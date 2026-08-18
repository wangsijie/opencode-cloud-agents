/**
 * Workspace tree fixture for the file browser.
 *
 * Covers nested directories, a symlink, an empty directory, a truncated
 * listing, a truncated large file, a binary file and the two kinds of image
 * the viewer previews: a PNG, which arrives as bytes, and an SVG, which is
 * text and arrives in the read itself.
 */
import type { MockWorkspaceDir } from '../types';

/** A 32×32 gradient PNG, so the image preview has something real to render. */
const LOGO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAG1UlEQVR42g3VkQKFMABA0eEwHIbh' +
  'MAyHwzAMh8NwGA6Hw8GFMAzDMBwOw/fOTxwhBFLQCZSgFwwCLRgFk8AIrGAWLIJV4AResAmCYBdE' +
  'QRJkQREcglNwCW7BI3gFVdAEn0AIiZR0EiXpJYNES0bJJDESK5kli2SVOImXbJIg2SVRkiRZUiSH' +
  '5JRcklvySF5JlTTJJxGiQ3Z0Haqj7xg6dMfYMXWYDtsxdywda4fr8B1bR+jYO2JH6sgdpePoODuu' +
  'jrvj6Xg7akfr+DqEUEhFp1CKXjEotGJUTAqjsIpZsShWhVN4xaYIil0RFUmRFUVxKE7FpbgVj+JV' +
  'VEVTfAohemRP16N6+p6hR/eMPVOP6bE9c8/Ss/a4Ht+z9YSevSf2pJ7cU3qOnrPn6rl7np63p/a0' +
  'nq9HiAE50A2ogX5gGNAD48A0YAbswDywDKwDbsAPbANhYB+IA2kgD5SBY+AcuAbugWfgHagDbeAb' +
  'EEIjNZ1GaXrNoNGaUTNpjMZqZs2iWTVO4zWbJmh2TdQkTdYUzaE5NZfm1jyaV1M1TfNphBiRI92I' +
  'GulHhhE9Mo5MI2bEjswjy8g64kb8yDYSRvaROJJG8kgZOUbOkWvkHnlG3pE60ka+ESEm5EQ3oSb6' +
  'iWFCT4wT04SZsBPzxDKxTrgJP7FNhIl9Ik6kiTxRJo6Jc+KauCeeiXeiTrSJb0IIgzR0BmXoDYNB' +
  'G0bDZDAGa5gNi2E1OIM3bIZg2A3RkAzZUAyH4TRchtvwGF5DNTTDZxDCIi2dRVl6y2DRltEyWYzF' +
  'WmbLYlktzuItmyVYdku0JEu2FMthOS2X5bY8ltdSLc3yWYSYkTPdjJrpZ4YZPTPOTDNmxs7MM8vM' +
  'OuNm/Mw2E2b2mTiTZvJMmTlmzplr5p55Zt6ZOtNmvhkhFuRCt6AW+oVhQS+MC9OCWbAL88KysC64' +
  'Bb+wLYSFfSEupIW8UBaOhXPhWrgXnoV3oS60hW9BiBW50q2olX5lWNEr48q0YlbsyryyrKwrbsWv' +
  'bCthZV+JK2klr5SVY+VcuVbulWflXakrbeVbEcIhHZ1DOXrH4NCO0TE5jMM6ZsfiWB3O4R2bIzh2' +
  'R3QkR3YUx+E4HZfjdjyO11EdzfE5hPBIT+dRnt4zeLRn9Ewe47Ge2bN4Vo/zeM/mCZ7dEz3Jkz3F' +
  'c3hOz+W5PY/n9VRP83weITbkRrehNvqNYUNvjBvThtmwG/PGsrFuuA2/sW2EjX0jbqSNvFE2jo1z' +
  '49q4N56Nd6NutI1v+38QkIEuoAJ9YAjowBiYAiZgA3NgCawBF/CBLRACeyAGUiAHSuAInIErcAee' +
  'wBuogRb4wv+DHbnT7aidfmfY0TvjzrRjduzOvLPsrDtux+9sO2Fn34k7aSfvlJ1j59y5du6dZ+fd' +
  'qTtt59v/H0RkpIuoSB8ZIjoyRqaIidjIHFkia8RFfGSLhMgeiZEUyZESOSJn5IrckSfyRmqkRb74' +
  '/yAhE11CJfrEkNCJMTElTMIm5sSSWBMu4RNbIiT2REykRE6UxJE4E1fiTjyJN1ETLfGl/wcZmeky' +
  'KtNnhozOjJkpYzI2M2eWzJpxGZ/ZMiGzZ2ImZXKmZI7Mmbkyd+bJvJmaaZkv/z8oyEJXUIW+MBR0' +
  'YSxMBVOwhbmwFNaCK/jCVgiFvRALqZALpXAUzsJVuAtP4S3UQit85f/BgTzoDtRBfzAc6IPxYDow' +
  'B/ZgPlgO1gN34A+2g3CwH8SDdJAPysFxcB5cB/fBc/Ae1IN28B3/D07kSXeiTvqT4USfjCfTiTmx' +
  'J/PJcrKeuBN/sp2Ek/0knqSTfFJOjpPz5Dq5T56T96SetJPv/H9wIS+6C3XRXwwX+mK8mC7Mhb2Y' +
  'L5aL9cJd+IvtIlzsF/EiXeSLcnFcnBfXxX3xXLwX9aJdfNf/gxt5092om/5muNE34810Y27szXyz' +
  '3Kw37sbfbDfhZr+JN+km35Sb4+a8uW7um+fmvak37ea7/x88yIfuQT30D8ODfhgfpgfzYB/mh+Vh' +
  'fXAP/mF7CA/7Q3xID/mhPBwP58P1cD88D+9DfWgP3/P/4EW+dC/qpX8ZXvTL+DK9mBf7Mr8sL+uL' +
  'e/Ev20t42V/iS3rJL+XleDlfrpf75Xl5X+pLe/ne/wcVWekqqtJXhoqujJWpYiq2MleWylpxFV/Z' +
  'KqGyV2IlVXKlVI7KWbkqd+WpvJVaaZWv/j9oyEbXUI2+MTR0Y2xMDdOwjbmxNNaGa/jG1giNvREb' +
  'qZEbpXE0zsbVuBtP423URmt87f/Bh/zoPtRH/zF86I/xY/owH/Zj/lg+1g/34T+2j/Cxf8SP9JE/' +
  'ysfxcX5cH/fH8/F+1I/28X38AK3esFvvYuNyAAAAAElFTkSuQmCC';

const LOGO_PNG = Uint8Array.from(atob(LOGO_PNG_BASE64), (char) =>
  char.charCodeAt(0)
);

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="28" fill="#3b82f6" />
  <path d="M20 34l9 9 16-18" stroke="#fff" stroke-width="6" fill="none" />
</svg>
`;

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
              'logo.png': {
                type: 'file',
                binary: true,
                size: LOGO_PNG.byteLength,
                bytes: LOGO_PNG
              },
              'icon.svg': { type: 'file', content: ICON_SVG }
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
