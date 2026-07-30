import { useRef, useState, type ClipboardEvent } from 'react';
import {
  deleteAttachmentUpload,
  uploadAttachment,
  type MessageAttachment
} from '../api';
import { CloseIcon, PlusIcon } from './icons';

/**
 * Image attachments for the two composers.
 *
 * Everything about picking, pasting, previewing and removing images before a
 * send lives here so the session page and the new-session page stay one
 * behaviour. The limits mirror the server's; checking them here turns a rejected
 * request into an inline message before anything is uploaded.
 *
 * Each image is uploaded as it arrives, not when the message is sent. The wait
 * is then spent while the user is still typing, the send itself carries nothing
 * but keys, and an upload that fails fails on its own chip — with a retry —
 * rather than taking a whole message with it.
 */

const ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
];
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024;

export const ATTACHMENT_ACCEPT = ATTACHMENT_MIME_TYPES.join(',');

export interface ComposerAttachment {
  id: string;
  mime: string;
  filename: string;
  size: number;
  /** FileReader result — the chip preview and the optimistic bubble thumbnail. */
  dataUrl?: string;
  /** Where this image is on its way into R2. */
  status: 'uploading' | 'ready' | 'failed';
  /** The R2 key a prompt names. Present once `status` is `ready`. */
  key?: string;
  /** Why the upload failed, shown on the chip next to its retry control. */
  error?: string;
  /** Kept for retrying a failed upload without re-picking the file. */
  file: File;
}

export function useComposerAttachments(onError: (message: string) => void) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  function patch(id: string, changes: Partial<ComposerAttachment>) {
    setAttachments((entries) =>
      entries.map((entry) =>
        entry.id === id ? { ...entry, ...changes } : entry
      )
    );
  }

  /**
   * Send one file to the Hub, marking the chip along the way.
   *
   * A missing chip when the answer comes back means the user removed it
   * mid-upload; the object is deleted rather than adopted, since nothing holds
   * its key any more.
   */
  function upload(id: string, file: File) {
    patch(id, { status: 'uploading', error: undefined });
    uploadAttachment(file)
      .then((stored) => {
        setAttachments((entries) => {
          if (!entries.some((entry) => entry.id === id)) {
            void deleteAttachmentUpload(stored.key).catch(() => undefined);
            return entries;
          }
          return entries.map((entry) =>
            entry.id === id
              ? { ...entry, status: 'ready' as const, key: stored.key }
              : entry
          );
        });
      })
      .catch((cause: unknown) => {
        patch(id, {
          status: 'failed',
          error: cause instanceof Error ? cause.message : String(cause)
        });
      });
  }

  function addFiles(files: File[]) {
    // Snapshot-based checks would go stale across async FileReader completions,
    // so count and total are tracked through the functional updates below.
    let accepted = 0;
    let acceptedBytes = 0;
    const current = attachments;
    const currentBytes = current.reduce((sum, entry) => sum + entry.size, 0);
    for (const file of files) {
      if (!ATTACHMENT_MIME_TYPES.includes(file.type)) {
        onError('Only PNG, JPEG, WebP and GIF images can be attached');
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        onError('Each image can be up to 5MB');
        continue;
      }
      if (current.length + accepted >= MAX_ATTACHMENTS) {
        onError('Up to 4 images per message');
        break;
      }
      if (currentBytes + acceptedBytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
        onError('Images can total up to 10MB per message');
        continue;
      }
      accepted += 1;
      acceptedBytes += file.size;
      const id = crypto.randomUUID();
      setAttachments((entries) => [
        ...entries,
        {
          id,
          mime: file.type,
          filename: file.name || 'image',
          size: file.size,
          status: 'uploading',
          file
        }
      ]);
      // The upload and the preview read run in parallel: neither waits on the
      // other, and the chip renders as soon as either lands.
      upload(id, file);
      const reader = new FileReader();
      reader.onload = () => {
        patch(id, { dataUrl: reader.result as string });
      };
      reader.readAsDataURL(file);
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) {
      return;
    }
    // A mixed clipboard (say, a rich-text copy) still pastes its text; only a
    // bare image paste is consumed entirely by the attachment.
    if (!event.clipboardData.types.includes('text/plain')) {
      event.preventDefault();
    }
    addFiles(files);
  }

  return {
    attachments,
    /**
     * True while any image is not yet safely in R2 — still uploading, or failed
     * and waiting on a retry or a removal. The send gate: a message sent now
     * would silently go out without the image the user attached.
     */
    reading: attachments.some((entry) => entry.status !== 'ready'),
    fileInput,
    addFiles,
    onPaste,
    /** Re-run one failed upload. The file is still in hand; nothing re-picks. */
    retry: (id: string) => {
      const entry = attachments.find((candidate) => candidate.id === id);
      if (entry && entry.status === 'failed') {
        upload(id, entry.file);
      }
    },
    remove: (id: string) => {
      const entry = attachments.find((candidate) => candidate.id === id);
      if (entry?.key) {
        void deleteAttachmentUpload(entry.key).catch(() => undefined);
      }
      setAttachments((entries) => entries.filter((item) => item.id !== id));
    },
    clear: () => setAttachments([]),
    /**
     * Put a send's snapshot back after a failure, like the prompt text. The
     * uploads are still in R2 — keys only die on delivery — so the restored
     * chips are ready to send again as they stand.
     */
    restore: (entries: ComposerAttachment[]) =>
      setAttachments((current) => (current.length > 0 ? current : entries))
  };
}

export type ComposerAttachmentsApi = ReturnType<typeof useComposerAttachments>;

/**
 * The request payload for a snapshot of attachments: the upload keys, nothing
 * else. The bytes went up when the images were picked. Callers only reach this
 * behind the `reading` gate, so every entry has its key by now.
 */
export function toAttachmentPayload(
  attachments: ComposerAttachment[]
): MessageAttachment[] {
  return attachments
    .filter((entry): entry is ComposerAttachment & { key: string } =>
      typeof entry.key === 'string'
    )
    .map((entry) => ({ key: entry.key }));
}

/** The "+" button and its hidden file input. */
export function AttachButton({
  api,
  disabled
}: {
  api: ComposerAttachmentsApi;
  disabled: boolean;
}) {
  return (
    <>
      <button
        className="icon-button"
        type="button"
        disabled={disabled}
        onClick={() => api.fileInput.current?.click()}
        aria-label="Attach images"
        title="Attach images"
      >
        <PlusIcon />
      </button>
      <input
        ref={api.fileInput}
        type="file"
        hidden
        multiple
        accept={ATTACHMENT_ACCEPT}
        onChange={(event) => {
          api.addFiles([...(event.target.files ?? [])]);
          // Reset so picking the same file again fires another change event.
          event.target.value = '';
        }}
      />
    </>
  );
}

/**
 * Preview thumbnails above the textarea, each with a remove control.
 *
 * A chip wears its upload state: dimmed while the bytes are on their way up,
 * and a retry control when they never arrived — the failure belongs to that
 * image, not to the message around it.
 */
export function AttachmentChips({ api }: { api: ComposerAttachmentsApi }) {
  if (api.attachments.length === 0) {
    return null;
  }
  return (
    <div className="attachment-chips">
      {api.attachments.map((entry) => (
        <div
          key={entry.id}
          className={`attachment-chip${
            entry.status === 'uploading' ? ' uploading' : ''
          }${entry.status === 'failed' ? ' failed' : ''}`}
        >
          {entry.dataUrl ? (
            <img src={entry.dataUrl} alt={entry.filename} />
          ) : (
            <span className="attachment-placeholder" aria-hidden="true" />
          )}
          {entry.status === 'failed' ? (
            <button
              type="button"
              className="attachment-retry"
              aria-label={`Upload of ${entry.filename} failed${
                entry.error ? `: ${entry.error}` : ''
              }. Retry`}
              title={
                entry.error
                  ? `Upload failed: ${entry.error} — click to retry`
                  : 'Upload failed — click to retry'
              }
              onClick={() => api.retry(entry.id)}
            >
              ↻
            </button>
          ) : null}
          <button
            type="button"
            className="attachment-remove"
            aria-label={`Remove ${entry.filename}`}
            title={`Remove ${entry.filename}`}
            onClick={() => api.remove(entry.id)}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
