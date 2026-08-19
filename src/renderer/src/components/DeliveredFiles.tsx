import { type ReactNode, useEffect, useState } from "react";
import type { DeliveredFile } from "../../../shared/deliveredFiles";
import { Icon } from "./primitives";

/**
 * Files the agent handed back, as something you can act on.
 *
 * @remarks
 * These sit UNDER the reply rather than replacing anything in it. The agent's
 * sentence explaining what the file is stays exactly as written — the card adds
 * the two verbs the sentence could not carry.
 *
 * A local file gets Open and Reveal, because it already exists and the only
 * thing missing was a way to reach it without copying a path out of a chat
 * bubble. A published file gets Open and Save, because taking delivery means
 * fetching it, and where it lands should be the user's choice rather than a
 * folder we picked for them.
 */

function extensionLabel(file: DeliveredFile): string {
  return file.extension ? file.extension.toUpperCase() : "FILE";
}

function FileRow({ file }: { file: DeliveredFile }): ReactNode {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Whether a local file is really there.
   *
   * Undefined until checked. A file written inside a sandbox is named in the
   * same shape as one written to the user's disk, and offering Open for
   * something that cannot be opened is worse than offering nothing.
   */
  const [present, setPresent] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (file.location !== "local") return;
    let live = true;
    void window.studio.fileExists(file.raw).then((exists) => {
      if (live) setPresent(exists);
    });
    return () => {
      live = false;
    };
  }, [file.raw, file.location]);

  // Nothing to offer for a path that is not on this machine.
  if (file.location === "local" && present === false) return null;

  const run = async (action: () => Promise<{ ok: boolean; error?: string; cancelled?: boolean; path?: string }>, doneLabel: string): Promise<void> => {
    setBusy(true);
    setStatus(null);
    const result = await action();
    setBusy(false);
    // A closed dialog is a decision, not an error: saying nothing is right.
    if (result.cancelled) return;
    setStatus(result.ok ? doneLabel : (result.error ?? "That did not work."));
  };

  return (
    <div className="dfile">
      <span className="dfile__kind">{extensionLabel(file)}</span>
      <span className="dfile__name" title={file.raw}>
        {file.name}
      </span>
      {status ? <span className="dfile__status">{status}</span> : null}
      <span className="dfile__actions">
        {file.location === "local" ? (
          <>
            <button
              className="dfile__btn"
              disabled={busy || present === undefined}
              onClick={() => void run(() => window.studio.openLocalFile(file.raw), "Opened")}
            >
              Open
            </button>
            <button
              className="dfile__btn"
              disabled={busy || present === undefined}
              onClick={() => void run(() => window.studio.revealLocalFile(file.raw), "Shown in Finder")}
            >
              Reveal
            </button>
          </>
        ) : (
          <>
            <button
              className="dfile__btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.studio.openRemoteFile({ url: file.raw, suggestedName: file.name }),
                  "Opened",
                )
              }
            >
              {busy ? "Working…" : "Open"}
            </button>
            <button
              className="dfile__btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.studio.saveRemoteFile({ url: file.raw, suggestedName: file.name }),
                  "Saved",
                )
              }
            >
              Save…
            </button>
          </>
        )}
      </span>
    </div>
  );
}

export function DeliveredFiles({ files }: { files: DeliveredFile[] }): ReactNode {
  if (files.length === 0) return null;
  return (
    <div className="dfiles">
      {files.map((file) => (
        <FileRow key={file.raw} file={file} />
      ))}
    </div>
  );
}

export { Icon };
