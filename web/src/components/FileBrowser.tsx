import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteArtifactFile,
  downloadWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  uploadArtifactFile,
  type WorkspaceFile,
  type WorkspaceListing,
  type WorkspaceRoot
} from '../api';
import { formatBytes } from '../format';
import { DownloadIcon, RefreshIcon, TrashIcon, UploadIcon } from './icons';

/**
 * A container directory, one level at a time.
 *
 * Deliberately not a tree: on a phone a tree is a column of half-width labels,
 * and the thing being browsed here is a repository someone already knows the
 * shape of. A path bar plus a list navigates it in the same number of taps
 * without the horizontal budget.
 *
 * Serves both roots. The checkout is read-only — changing it is the agent's
 * job, and git's record — so `writable` turns on the upload and delete
 * controls for the artifacts directory alone.
 */
export function FileBrowser({
  sessionId,
  root = 'checkout',
  rootLabel = 'Repo root',
  writable = false,
  emptyMessage = 'Empty directory.'
}: {
  sessionId: string;
  root?: WorkspaceRoot;
  rootLabel?: string;
  writable?: boolean;
  emptyMessage?: string;
}) {
  const [listing, setListing] = useState<WorkspaceListing>();
  const [file, setFile] = useState<WorkspaceFile>();
  const [path, setPath] = useState('');
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [dropping, setDropping] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);

  const openDirectory = useCallback(
    async (next: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await listWorkspaceFiles(sessionId, next, root);
        setListing(result);
        setFile(undefined);
        setPath(result.path);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, root]
  );

  const openFile = useCallback(
    async (next: string) => {
      setLoading(true);
      setError(undefined);
      try {
        setFile(await readWorkspaceFile(sessionId, next, root));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [sessionId, root]
  );

  const downloadFile = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const blob = await downloadWorkspaceFile(sessionId, target, root);
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
    [sessionId, root]
  );

  // Uploads land in the directory being viewed, which is the one place the
  // reader is already thinking about; there is no destination picker because
  // navigating there first is the picker.
  const uploadFiles = useCallback(
    async (files: readonly File[]) => {
      if (files.length === 0) {
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        for (const upload of files) {
          await uploadArtifactFile(
            sessionId,
            path ? `${path}/${upload.name}` : upload.name,
            upload
          );
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
      await openDirectory(path);
    },
    [sessionId, path, openDirectory]
  );

  const removeFile = useCallback(
    async (target: string, directory: boolean) => {
      // A file is one download away from being back; a directory delete is
      // recursive and is the one misclick here worth a question.
      if (directory && !window.confirm(`Delete ${target} and everything in it?`)) {
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        await deleteArtifactFile(sessionId, target);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
      await openDirectory(path);
    },
    [sessionId, path, openDirectory]
  );

  useEffect(() => {
    void openDirectory('');
  }, [openDirectory]);

  const pathParts = path.split('/').filter(Boolean);

  return (
    <div
      className={`file-browser${dropping ? ' dropping' : ''}`}
      {...(writable
        ? {
            onDragOver: (event: React.DragEvent) => {
              event.preventDefault();
              setDropping(true);
            },
            onDragLeave: () => setDropping(false),
            onDrop: (event: React.DragEvent) => {
              event.preventDefault();
              setDropping(false);
              void uploadFiles(Array.from(event.dataTransfer.files));
            }
          }
        : {})}
    >
      <div className="file-path" aria-label="Workspace path">
        <div className="file-breadcrumbs">
          <button
            className="link-button"
            type="button"
            disabled={loading}
            onClick={() => void openDirectory('')}
          >
            {rootLabel}
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
        <div className="file-actions">
          {writable ? (
            <>
              <input
                className="file-picker"
                ref={filePicker}
                type="file"
                multiple
                onChange={(event) => {
                  void uploadFiles(Array.from(event.target.files ?? []));
                  // Cleared so picking the same file twice in a row still fires.
                  event.target.value = '';
                }}
              />
              <button
                className="icon-button"
                type="button"
                disabled={loading}
                aria-label="Upload files"
                title={`Upload into ${path || rootLabel}`}
                onClick={() => filePicker.current?.click()}
              >
                <UploadIcon />
              </button>
            </>
          ) : null}
          <button
            className="icon-button"
            type="button"
            disabled={loading}
            aria-label="Refresh workspace"
            title="Refresh workspace"
            onClick={() =>
              void (file ? openFile(file.path) : openDirectory(path))
            }
          >
            <RefreshIcon />
          </button>
        </div>
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
              {writable ? (
                <button
                  className="icon-button file-delete"
                  type="button"
                  disabled={loading}
                  aria-label={`Delete ${entry.name}`}
                  title={`Delete ${entry.name}`}
                  onClick={() =>
                    void removeFile(entry.path, entry.type === 'directory')
                  }
                >
                  <TrashIcon />
                </button>
              ) : null}
            </li>
          ))}
          {listing.entries.length === 0 ? (
            <li className="muted">{emptyMessage}</li>
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
