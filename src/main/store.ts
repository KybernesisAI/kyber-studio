import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, dialog } from "electron";

/**
 * Durable state for the desktop.
 *
 * A coding session that vanishes when the app restarts is not a working session.
 * The agent keeps its own memory, but the transcript, the eve session ids, and
 * the project you were in all live here so reopening Studio resumes rather than
 * starts over.
 *
 * Written atomically-ish and read defensively: a corrupt file must degrade to an
 * empty history, never to an app that will not start.
 */

function file(name: string): string {
  const dir = app.getPath("userData");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

export function loadState<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveState(name: string, value: unknown): void {
  try {
    const tmp = file(`${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), "utf8");
    writeFileSync(file(name), readFileSync(tmp, "utf8"), "utf8");
  } catch {
    /* losing a save is survivable; crashing on one is not */
  }
}

/** Ask the OS for a folder. Returns null when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const res = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose a project folder",
    buttonLabel: "Use this folder",
  });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
}
