/**
 * Finding the files an agent has handed back, inside the words it used.
 *
 * @remarks
 * Agents do not stream binaries to a client: the protocol's file part carries
 * metadata about what the USER attached. What an agent actually produces
 * arrives one of two ways, and both are plain text in the middle of a sentence:
 *
 * - **A link**, when the file was published — a report uploaded somewhere the
 *   user can reach.
 * - **A path**, when the agent wrote to the user's own machine under local
 *   access.
 *
 * Both currently render as text. A link is at least clickable; a path is a
 * string the user has to select, copy, and paste into a file manager, which is
 * the "path into a sandbox they cannot see" this exists to remove.
 *
 * The rule for what counts is deliberately narrow. Every URL in a reply is not
 * a delivered file — most are references, documentation, a pull request — and a
 * card offering to save a documentation page is noise that teaches people to
 * ignore cards.
 */

/** A file the agent produced, as found in its message. */
export interface DeliveredFile {
  /** Exactly as written, so it can be matched against the rendered text. */
  raw: string;
  /** What to call it in the UI. */
  name: string;
  /** Where it lives: a URL to fetch, or a path on this machine. */
  location: "remote" | "local";
  /** Lowercase, without the dot. Empty when there is none. */
  extension: string;
}

/**
 * Extensions that mean "a file someone wants to keep".
 *
 * @remarks
 * Web page extensions are deliberately absent. A link ending in `.html` is
 * almost always a page to read rather than a document to save, and offering to
 * download it is the noise described above. Archives and installers are absent
 * for a different reason: nothing should encourage a one-click save of an
 * executable arriving from a model's output.
 */
const KEEPABLE = new Set([
  "pdf", "csv", "tsv", "json", "xml", "yaml", "yml",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "heic",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods",
  "md", "txt", "rtf",
  "mp3", "wav", "m4a", "mp4", "mov", "webm",
]);

function extensionOf(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0];
  const base = withoutQuery.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

function nameOf(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0];
  const base = withoutQuery.split("/").pop() ?? withoutQuery;
  try {
    return decodeURIComponent(base);
  } catch {
    // A malformed escape should not lose the file; the raw name still helps.
    return base;
  }
}

/** URLs, including those wrapped in markdown link syntax. */
const URL_PATTERN = /https?:\/\/[^\s)<>"'\]]+/g;

/**
 * Absolute paths on this machine, and `~` paths.
 *
 * @remarks
 * Bounded to characters a path plausibly holds, and stopped at whitespace. A
 * path with spaces in it will be cut short, which is a real limitation: the
 * alternative is guessing where a sentence ends, and a card pointing at the
 * wrong file is worse than no card.
 */
const PATH_PATTERN = /(?:^|[\s(`"'])((?:~|\/(?:Users|home|tmp|var|opt|private))[^\s`"'<>|]*)/g;

/**
 * Files the agent handed back in this message.
 *
 * @remarks
 * Deduplicated by what was written, because a reply that names a file in a
 * sentence and again in a list means one file, not two.
 */
export function deliveredFiles(text: string): DeliveredFile[] {
  const found = new Map<string, DeliveredFile>();

  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:]+$/, "");
    const extension = extensionOf(raw);
    if (!KEEPABLE.has(extension)) continue;
    found.set(raw, { raw, name: nameOf(raw), location: "remote", extension });
  }

  for (const match of text.matchAll(PATH_PATTERN)) {
    const raw = match[1].replace(/[.,;:]+$/, "");
    const extension = extensionOf(raw);
    if (!KEEPABLE.has(extension)) continue;
    found.set(raw, { raw, name: nameOf(raw), location: "local", extension });
  }

  return [...found.values()];
}
