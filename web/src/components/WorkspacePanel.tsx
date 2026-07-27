import { FileBrowser } from './FileBrowser';

/**
 * The container's files.
 *
 * This panel carried a shell beside them until the terminal was removed: its
 * PTY was proxied on a path the Sandbox's control-plane gate never admitted, so
 * the tab had never once opened. Files are the half that worked. A terminal can
 * come back when it is built against that gate rather than around it.
 *
 * Reading a directory needs the container up and never wakes it — a sleeping
 * session says so instead.
 *
 * It is a tab in the details sidebar, which is collapsed by default: opening it
 * is the request, and a session page that listed files on every poll would run
 * container commands for a user who came to read a conversation.
 */
export function WorkspacePanel({
  sessionId,
  attached
}: {
  sessionId: string;
  attached: boolean;
}) {
  return (
    <section className="workspace-panel">
      {attached ? (
        <FileBrowser sessionId={sessionId} />
      ) : (
        <p className="muted">
          This session is asleep. Send a message to wake the container, then you
          can browse its files.
        </p>
      )}
    </section>
  );
}
