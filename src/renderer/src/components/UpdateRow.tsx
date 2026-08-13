import { type ReactNode, useEffect, useState } from "react";
import type { UpdateState } from "@shared/ipc";
import { Icon } from "./primitives";

/**
 * The update control, in the sidebar footer.
 *
 * Invisible when there is nothing to do — an app that permanently displays "up
 * to date" is spending a row of a person's screen on reassurance. It appears
 * when a release lands, shows progress while downloading, and then becomes the
 * restart.
 *
 * Downloading is a separate press from installing, deliberately. The download
 * can happen while someone works; the restart takes their conversation with it,
 * so that moment is theirs to choose.
 */
export function UpdateRow(): ReactNode {
  const [state, setState] = useState<UpdateState>({ status: "idle", version: null });

  useEffect(() => {
    let live = true;
    void window.studio?.updaterState().then((s) => {
      if (live) setState(s);
    });
    const stop = window.studio?.onUpdater(setState);
    return () => {
      live = false;
      stop?.();
    };
  }, []);

  if (state.status === "available") {
    return (
      <button className="foot-row" onClick={() => void window.studio?.updaterDownload()}>
        <Icon name="download" size={15} />
        <span className="foot-row__label">Update available</span>
        {state.version ? <span className="foot-row__note">v{state.version}</span> : null}
      </button>
    );
  }

  if (state.status === "downloading") {
    return (
      <div className="foot-row">
        <Icon name="download" size={15} />
        <span className="foot-row__label">Downloading…</span>
        <span className="foot-row__note">{state.percent ?? 0}%</span>
      </div>
    );
  }

  if (state.status === "downloaded") {
    return (
      <button className="foot-row foot-row--accent" onClick={() => void window.studio?.updaterInstall()}>
        <Icon name="arrowUp" size={15} />
        <span className="foot-row__label">Restart to update</span>
        {state.version ? <span className="foot-row__note">v{state.version}</span> : null}
      </button>
    );
  }

  return null;
}
