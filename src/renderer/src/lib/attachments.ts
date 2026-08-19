import type { Attachment } from "../../../shared/ipc";

/**
 * Turning what a person dropped, picked, or pasted into something sendable.
 *
 * @remarks
 * Three gestures arrive here — the paperclip, a drag onto the composer, and a
 * paste — and they must produce identical results, because a file that attaches
 * one way and fails another is worse than a file that never attaches at all.
 */

/**
 * Per-file ceiling.
 *
 * @remarks
 * Attached files are inlined into the message as data URLs, which means they
 * become model context. A large file does not fail loudly at the boundary; it
 * spends the context window, slows the turn, and can push the conversation into
 * compaction — so the limit exists to make the failure immediate and legible
 * rather than mysterious and expensive. Twenty megabytes comfortably covers the
 * documents and screenshots people actually attach.
 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Ceiling across one message, for the same reason. */
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

/** A pending attachment, before it is sent. */
export interface PendingAttachment extends Attachment {
  /** Stable id, so removing one chip cannot remove the wrong file. */
  id: string;
}

export interface AttachResult {
  accepted: PendingAttachment[];
  /** Human-readable refusals, ready to show. Empty when everything landed. */
  rejected: string[];
}

/** Bytes as something a person reads without counting digits. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The file's media type, falling back to its extension.
 *
 * @remarks
 * The browser leaves `type` empty more often than expected — files dragged from
 * some applications, and anything with an extension it does not recognise. The
 * model needs a media type to decode the bytes at all, so guessing from the
 * extension beats sending nothing. The final fallback is deliberately the
 * generic binary type rather than a plausible-looking guess: a wrong specific
 * type makes a model try to decode something it cannot, which fails in a way
 * that reads like the file being corrupt.
 */
const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  py: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

export function mediaTypeFor(file: File): string {
  if (file.type) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || "application/octet-stream";
}

let counter = 0;

/**
 * Read files into pending attachments, refusing what cannot be sent.
 *
 * @remarks
 * `alreadyAttached` is the running total, because the interesting limit is per
 * MESSAGE rather than per gesture: five files dropped one at a time should be
 * refused at exactly the point five files dropped together would be.
 *
 * A refusal names the file and the reason. "Too large" without saying which of
 * four files, or what the limit is, sends someone hunting.
 */
export async function readFiles(
  files: readonly File[],
  alreadyAttached: readonly PendingAttachment[] = [],
): Promise<AttachResult> {
  const accepted: PendingAttachment[] = [];
  const rejected: string[] = [];
  let total = alreadyAttached.reduce((sum, file) => sum + file.size, 0);

  for (const file of files) {
    if (file.size === 0) {
      // A folder dragged onto the composer arrives as a zero-byte entry rather
      // than as its contents, and "0 B" is a confusing thing to be told.
      rejected.push(`${file.name} is empty, or is a folder. Attach the files inside it.`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      rejected.push(
        `${file.name} is ${formatSize(file.size)}. The limit is ${formatSize(MAX_FILE_BYTES)} per file.`,
      );
      continue;
    }
    if (total + file.size > MAX_TOTAL_BYTES) {
      rejected.push(
        `${file.name} would take this message past ${formatSize(MAX_TOTAL_BYTES)}. Send it separately.`,
      );
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      counter += 1;
      accepted.push({
        id: `att-${Date.now()}-${counter}`,
        name: file.name,
        mediaType: mediaTypeFor(file),
        size: file.size,
        bytes,
      });
      total += file.size;
    } catch (error) {
      // Reading can fail for a file that moved, or one on a volume that went
      // away between the drop and the read.
      rejected.push(`${file.name} could not be read: ${(error as Error).message}`);
    }
  }

  return { accepted, rejected };
}

/**
 * Files from a paste, or an empty list when the clipboard held only text.
 *
 * @remarks
 * A pasted screenshot is the fastest way anyone attaches anything, and it
 * arrives as a clipboard item with a generated name like "image.png" rather
 * than as a real file. Text pastes must fall through untouched: the composer
 * already handles those, and intercepting them would break ordinary typing.
 */
export function filesFromClipboard(data: DataTransfer): File[] {
  return Array.from(data.files ?? []);
}
