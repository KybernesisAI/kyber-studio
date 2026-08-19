import { createWriteStream } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dialog, shell } from "electron";

/**
 * Taking delivery of a file the agent produced.
 *
 * @remarks
 * Two cases, and they are genuinely different. A file the agent wrote to this
 * machine already exists — the only thing missing is a way to open it without
 * copying a path out of a chat bubble. A file the agent published exists
 * somewhere else, and taking delivery means fetching it.
 *
 * Everything here runs in the main process, and nothing accepts an instruction
 * from the model: the renderer passes a location the USER clicked on. That
 * distinction matters, because "download this and open it" is exactly the
 * sentence a hostile document would like an agent to repeat.
 */

/** Refuse a download that would fill the disk; nothing legitimate is this big. */
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

export interface DeliveryResult {
  ok: boolean;
  /** Where it ended up, when it was saved. */
  path?: string;
  error?: string;
  /** True when the user closed the save dialog; not a failure to report loudly. */
  cancelled?: boolean;
}

/** `~` is not a directory: the shell expands it, and node does not. */
function expand(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** Whether a local file the agent named is actually there. */
export async function localFileExists(path: string): Promise<boolean> {
  try {
    const target = resolve(expand(path));
    const info = await stat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Open a local file with whatever the system uses for it. */
export async function openLocalFile(path: string): Promise<DeliveryResult> {
  const target = resolve(expand(path));
  try {
    await access(target);
  } catch {
    // A file the agent wrote in a sandbox is not on this machine, and the
    // difference is invisible in the sentence that named it.
    return { ok: false, error: "That file is not on this computer." };
  }
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true, path: target };
}

/** Show a local file in the file manager, selected. */
export async function revealLocalFile(path: string): Promise<DeliveryResult> {
  const target = resolve(expand(path));
  if (!(await localFileExists(target))) {
    return { ok: false, error: "That file is not on this computer." };
  }
  shell.showItemInFolder(target);
  return { ok: true, path: target };
}

async function download(url: string, destination: string): Promise<DeliveryResult> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { ok: false, error: `Could not reach it: ${(error as Error).message}` };
  }
  if (!response.ok) {
    return { ok: false, error: `The server answered ${response.status}.` };
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: "That file is too large to download here." };
  }
  if (!response.body) return { ok: false, error: "The response had no content." };
  try {
    await mkdir(join(destination, ".."), { recursive: true });
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
    return { ok: true, path: destination };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * Save a published file, asking the user where it should go.
 *
 * @remarks
 * Asking rather than dropping it in Downloads: a file arriving from an agent is
 * something the user decided to keep, and choosing the destination is the
 * moment they confirm that. It also means nothing is ever written to disk
 * without a dialog the user saw.
 */
export async function saveRemoteFile(input: {
  url: string;
  suggestedName: string;
}): Promise<DeliveryResult> {
  const choice = await dialog.showSaveDialog({
    defaultPath: join(homedir(), "Downloads", basename(input.suggestedName)),
    title: "Save file",
  });
  if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true };
  return await download(input.url, choice.filePath);
}

/**
 * Fetch a published file to a temporary location and open it.
 *
 * @remarks
 * For looking rather than keeping. It lands in the system temp directory
 * precisely so it is not quietly accumulating in the user's own folders — if
 * they want it, the save action puts it where they choose.
 */
export async function openRemoteFile(input: {
  url: string;
  suggestedName: string;
}): Promise<DeliveryResult> {
  const folder = join(tmpdir(), "kyber-studio-files");
  await mkdir(folder, { recursive: true });
  const target = join(folder, basename(input.suggestedName) || "file");
  const result = await download(input.url, target);
  if (!result.ok) return result;
  const error = await shell.openPath(target);
  return error ? { ok: false, error } : { ok: true, path: target };
}
