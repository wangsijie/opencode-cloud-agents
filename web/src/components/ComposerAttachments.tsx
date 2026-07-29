import { useRef, useState, type ClipboardEvent } from 'react';
import type { MessageAttachment } from '../api';
import { CloseIcon, PlusIcon } from './icons';

/**
 * Image attachments for the two composers.
 *
 * Everything about picking, pasting, previewing and removing images before a
 * send lives here so the session page and the new-session page stay one
 * behaviour. The limits mirror the server's (`normalizeSessionAttachments`);
 * checking them here turns a rejected request into an inline message before
 * anything is uploaded.
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
  /** FileReader result — both the chip preview and the payload source. */
  dataUrl: string;
}

export function useComposerAttachments(onError: (message: string) => void) {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  // Files still being read; sending mid-read would silently drop them.
  const [readingCount, setReadingCount] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

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
      const reader = new FileReader();
      setReadingCount((count) => count + 1);
      reader.onload = () => {
        setAttachments((entries) => [
          ...entries,
          {
            id,
            mime: file.type,
            filename: file.name || 'image',
            size: file.size,
            dataUrl: reader.result as string
          }
        ]);
        setReadingCount((count) => count - 1);
      };
      reader.onerror = () => {
        onError(`Could not read ${file.name || 'the image'}`);
        setReadingCount((count) => count - 1);
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
    /** True while any picked file is still being read into a preview. */
    reading: readingCount > 0,
    fileInput,
    addFiles,
    onPaste,
    remove: (id: string) =>
      setAttachments((entries) => entries.filter((entry) => entry.id !== id)),
    clear: () => setAttachments([]),
    /** Put a send's snapshot back after a failure, like the prompt text. */
    restore: (entries: ComposerAttachment[]) =>
      setAttachments((current) => (current.length > 0 ? current : entries))
  };
}

export type ComposerAttachmentsApi = ReturnType<typeof useComposerAttachments>;

/** The request payload for a snapshot of attachments. */
export function toAttachmentPayload(
  attachments: ComposerAttachment[]
): MessageAttachment[] {
  return attachments.map((entry) => ({
    mime: entry.mime,
    filename: entry.filename,
    data: entry.dataUrl.slice(entry.dataUrl.indexOf(',') + 1)
  }));
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

/** Preview thumbnails above the textarea, each with a remove control. */
export function AttachmentChips({ api }: { api: ComposerAttachmentsApi }) {
  if (api.attachments.length === 0) {
    return null;
  }
  return (
    <div className="attachment-chips">
      {api.attachments.map((entry) => (
        <div key={entry.id} className="attachment-chip">
          <img src={entry.dataUrl} alt={entry.filename} />
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
