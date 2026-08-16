import { FileBrowser } from './FileBrowser';

/**
 * The session's own file directory.
 *
 * `/workspace/artifacts` is a sibling of the checkout rather than a directory
 * inside it, so what lands here never appears in the diff — which is the point:
 * it is for the files that are not a change to the repository. The user uploads
 * into it and the agent reads and writes it, told about it by the instructions
 * every wake installs.
 *
 * It lives in the workspace, so it is exactly as durable as the session and no
 * more: there is no mirror outside the container, a sleeping session cannot be
 * browsed, and a session that is lost takes its files with it. That is the same
 * bargain the workspace panel makes, and the reason this is a tab beside it
 * rather than a separate store with its own lifetime.
 */
export function ArtifactsPanel({
  sessionId,
  attached,
  cleaned = false
}: {
  sessionId: string;
  attached: boolean;
  /** The container was removed by the idle sweep; there are no files left. */
  cleaned?: boolean;
}) {
  return (
    <section className="workspace-panel">
      {attached ? (
        <FileBrowser
          sessionId={sessionId}
          root="artifacts"
          rootLabel="Artifacts"
          writable
          emptyMessage="No files yet. Drop files here to give them to the agent, or ask it to write its output to artifacts/."
        />
      ) : cleaned ? (
        <p className="muted">
          This session was cleaned up, so its files no longer exist.
        </p>
      ) : (
        <p className="muted">
          This session is asleep. Send a message to wake the container, then you
          can upload and download files here.
        </p>
      )}
    </section>
  );
}
