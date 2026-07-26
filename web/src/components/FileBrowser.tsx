import { useCallback, useEffect, useState } from 'react';
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  type WorkspaceFile,
  type WorkspaceListing
} from '../api';
import { formatBytes } from '../format';

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

  useEffect(() => {
    void openDirectory('');
  }, [openDirectory]);

  return (
    <div className="file-browser">
      <div className="file-path">
        <button
          className="link-button"
          type="button"
          disabled={loading}
          onClick={() => void openDirectory('')}
        >
          Repo root
        </button>
        {path ? <span className="mono">/{path}</span> : null}
        <button
          className="link-button refresh"
          type="button"
          disabled={loading}
          onClick={() => void (file ? openFile(file.path) : openDirectory(path))}
        >
          Refresh
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
            <span className="mono">{file.path}</span>
            <span className="muted">{formatBytes(file.size)}</span>
            <button
              className="link-button"
              type="button"
              onClick={() => setFile(undefined)}
            >
              Back to directory
            </button>
          </div>
          {file.binary ? (
            <p className="muted">Binary file — no preview.</p>
          ) : (
            <>
              <pre className="file-content mono">{file.content}</pre>
              {file.truncated ? (
                <p className="muted">File is large; showing the first 256 KB.</p>
              ) : null}
            </>
          )}
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
