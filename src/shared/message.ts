import type { Attachment } from "./ipc";

/**
 * What one user turn looks like on the wire, with or without files.
 *
 * @remarks
 * Kept out of the main process so it can be tested without an Electron window
 * or a live agent: the ordering rule below is the kind of thing that is obvious
 * while writing it and invisible the day someone reorders the array.
 */

/** A text segment of a user turn. */
export interface TextPart {
  type: "text";
  text: string;
}

/** One attached file, inlined so the model receives the bytes with the turn. */
export interface FilePart {
  type: "file";
  data: string;
  filename?: string;
  mediaType: string;
}

export type MessageContent = string | (TextPart | FilePart)[];

/** Base64 without Node's Buffer, so this stays usable from the renderer too. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return typeof btoa === "function"
    ? btoa(binary)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Buffer.from(bytes).toString("base64");
}

/**
 * Build the message for a turn.
 *
 * @remarks
 * A plain string when nothing is attached — the overwhelming case, and the
 * shape every turn used before attachments existed. Sending a one-element part
 * array instead would work, but it would change the wire format of every
 * ordinary message for no benefit.
 *
 * The text part comes FIRST, deliberately. A model reads the turn in order, and
 * a file arriving ahead of its instruction is a document dropped on a desk with
 * no note attached: the request that explains what to do with it has not been
 * read yet.
 *
 * Files are inlined as data URLs rather than referenced by path. A path would
 * mean the agent reaching into the user's filesystem to fetch it, which is a
 * different act with its own consent, and not what someone means when they hand
 * over a file.
 */
export function buildMessage(text: string, attachments?: readonly Attachment[]): MessageContent {
  if (!attachments || attachments.length === 0) return text;
  return [
    { type: "text", text },
    ...attachments.map((file) => ({
      type: "file" as const,
      data: `data:${file.mediaType};base64,${toBase64(file.bytes)}`,
      filename: file.name,
      mediaType: file.mediaType,
    })),
  ];
}
