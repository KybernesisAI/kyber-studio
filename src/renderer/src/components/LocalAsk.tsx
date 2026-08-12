import { type ReactNode, useEffect, useState } from "react";
import type { LocalAsk as Ask } from "@shared/ipc";
import { Icon } from "./primitives";

/**
 * The consent card for anything that touches this machine.
 *
 * Deliberately plain about the effect and the exact target: an agent asking to
 * run `rm -rf build` should show that command, not "the agent wants to use a
 * tool". Approving is a real decision, so the card names what will happen, who
 * asked, and offers the honest three answers rather than a yes/no that hides
 * the standing choice.
 */
export function LocalAskCard(): ReactNode {
  const [queue, setQueue] = useState<Ask[]>([]);

  useEffect(() => {
    if (!window.studio) return;
    const offAsk = window.studio.onLocalAsk((ask) =>
      setQueue((q) => (q.some((x) => x.id === ask.id) ? q : [...q, ask])),
    );
    const offDone = window.studio.onLocalDone(({ id }) =>
      setQueue((q) => q.filter((x) => x.id !== id)),
    );
    return () => {
      offAsk();
      offDone();
    };
  }, []);

  const current = queue[0];
  if (!current) return null;

  const answer = (allow: boolean, remember: boolean): void => {
    void window.studio.localAnswer({ id: current.id, allow, remember });
    setQueue((q) => q.filter((x) => x.id !== current.id));
  };

  return (
    <div className="ask">
      <div className="ask__head">
        <span className="ask__warn">
          <Icon name="alert" size={15} />
        </span>
        <span className="ask__title">{current.label}</span>
        <button className="topbar__btn" title="Not now" onClick={() => answer(false, false)}>
          <Icon name="close" size={13} />
        </button>
      </div>

      {current.detail ? <div className="ask__detail">{current.detail}</div> : null}

      <div className="ask__who">
        {current.agent} is asking. This applies to every agent you use.
      </div>

      <div className="ask__actions">
        <button className="btn btn--primary" onClick={() => answer(true, true)}>
          Always allow
        </button>
        <button className="btn" onClick={() => answer(true, false)}>
          Allow once
        </button>
        <button className="btn" onClick={() => answer(false, true)}>
          Never
        </button>
      </div>

      {queue.length > 1 ? (
        <div className="ask__more">{queue.length - 1} more waiting</div>
      ) : null}
    </div>
  );
}
