import { useCallback, useEffect, useState } from 'react';
import {
  downloadWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  type WorkspaceFile,
  type WorkspaceListing
} from '../api';
import { formatBytes } from '../format';
import { DownloadIcon, RefreshIcon } from './icons';

/**
 * The checkout, one directory at a time.
 *
 * Deliberately not a tree: on a phone a tree is a column of half-width labels,
 * and the thing being browsed here is a repository someone already knows the
 * shape of. A path bar plus a list navigates it in the same number of taps
 * without the horizontal budget.
 */
export function FileBrowser({ sessionId }: { sessionId: string }) {
  const [listing, setListing] = useState<WorkspaceListing>();
  const [file, setFile] = useState<WorkspaceFile>();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const openDirectory = useCallback(
    async (next: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await listWorkspaceFiles(sessionId, next);
        setListing(result);
        setFile(undefined);
        setPath(result.path);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  const openFile = useCallback(
    async (next: string) => {
      setLoading(true);
      setError(undefined);
      try {
        setFile(await readWorkspaceFile(sessionId, next));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  const downloadFile = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const blob = await downloadWorkspaceFile(sessionId, target);
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = target.split('/').pop() ?? target;
        anchor.click();
        URL.revokeObjectURL(href);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    void openDirectory('');
  }, [openDirectory]);

  const pathParts = path.split('/').filter(Boolean);

  return (
    <div className="file-browser">
      <div className="file-path" aria-label="Workspace path">
        <div className="file-breadcrumbs">
          <button
            className="link-button"
            type="button"
            disabled={loading}
            onClick={() => void openDirectory('')}
          >
            Repo root
          </button>
          {pathParts.map((part, index) => {
            const target = pathParts.slice(0, index + 1).join('/');
            return (
              <span className="file-breadcrumb" key={target}>
                <span aria-hidden="true">/</span>
                <button
                  className="link-button mono"
                  type="button"
                  disabled={loading}
                  onClick={() => void openDirectory(target)}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </div>
        <button
          className="icon-button refresh"
          type="button"
          disabled={loading}
          aria-label="Refresh workspace"
          title="Refresh workspace"
          onClick={() => void (file ? openFile(file.path) : openDirectory(path))}
        >
          <RefreshIcon />
        </button>
      </div>

      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}

      {file ? (
        <div className="file-view">
          <div className="file-view-header">
            <span className="mono">{file.path.split('/').pop()}</span>
            <span className="muted">{formatBytes(file.size)}</span>
          </div>
          {file.binary ? null : (
            <pre className="file-content mono">{file.content}</pre>
          )}
          {file.binary || file.truncated ? (
            <div className="file-download">
              {file.truncated ? (
                <span className="muted">
                  File is large; showing the first 256 KB.
                </span>
              ) : null}
              <button
                className="button"
                type="button"
                disabled={loading}
                onClick={() => void downloadFile(file.path)}
              >
                <DownloadIcon />
                Download
              </button>
            </div>
          ) : null}
        </div>
      ) : listing ? (
        <ul className="file-list">
          {listing.parent !== undefined ? (
            <li>
              <button
                className="file-entry"
                type="button"
                disabled={loading}
                onClick={() => void openDirectory(listing.parent ?? '')}
              >
                <span className="file-icon">↑</span>
                <span className="mono">..</span>
              </button>
            </li>
          ) : null}
          {listing.entries.map((entry) => (
            <li key={entry.path}>
              <button
                className="file-entry"
                type="button"
                disabled={loading}
                onClick={() =>
                  void (entry.type === 'directory'
                    ? openDirectory(entry.path)
                    : openFile(entry.path))
                }
              >
                <span className="file-icon">
                  {entry.type === 'directory' ? '📁' : '📄'}
                </span>
                <span className="mono">{entry.name}</span>
                {entry.type === 'file' ? (
                  <span className="muted file-size">{formatBytes(entry.size)}</span>
                ) : null}
              </button>
            </li>
          ))}
          {listing.entries.length === 0 ? (
            <li className="muted">Empty directory.</li>
          ) : null}
          {listing.truncated ? (
            <li className="muted">Too many entries; listing the first 2000.</li>
          ) : null}
        </ul>
      ) : loading ? (
        <p className="muted">Reading the directory…</p>
      ) : null}
    </div>
  );
}
