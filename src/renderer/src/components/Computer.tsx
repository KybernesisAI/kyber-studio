import { type ReactNode, useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import { useStore } from "../lib/store";
import { connectComputer } from "../lib/computer";
import { IS_MAC, IS_WINDOWS, computerCloseLabel } from "../lib/platform";
import type { Agent } from "@shared/types";

/**
 * The agent's computer, in two sizes.
 *
 * The card sits under Host/Model in the agent panel: a live, view-only scaled
 * image of the screen. Hover shows one control, "Open". The view is the same
 * screen filling the window, with the mouse and keyboard going to the computer,
 * so a person can sign in to a site for the agent or finish something by hand.
 *
 * No VNC dialog anywhere: Studio is already signed in as the owner, and the
 * agent's management routes hand over a ticket and the credentials. A fresh
 * ticket per connection, because a WebSocket cannot carry the bearer header.
 */

type Phase = "connecting" | "live" | "failed";

/**
 * Control, Shift, Alt and Meta, left and right, as the keysyms noVNC sends for
 * them. Meta has two families: noVNC sends Super for the Meta key, and Meta
 * when a key reports Meta from the Alt key's position. AltGr is not here; the
 * close shortcut cannot leave it held. A release for a key that is not down
 * does nothing.
 */
const MODIFIER_KEYS: readonly (readonly [number, string])[] = [
  [0xffe3, "ControlLeft"],
  [0xffe4, "ControlRight"],
  [0xffe1, "ShiftLeft"],
  [0xffe2, "ShiftRight"],
  [0xffe9, "AltLeft"],
  [0xffea, "AltRight"],
  [0xffeb, "MetaLeft"],
  [0xffec, "MetaRight"],
  [0xffe7, "MetaLeft"],
  [0xffe8, "MetaRight"],
];

/**
 * How long the key releases get to leave before the connection closes. A
 * relay may drop frames that reach it in the same read as the close frame
 * (websockify 0.10 does; 0.11 and later forward them first), and then a
 * modifier stays held on the computer. The delay separates when the frames
 * are sent, which makes that unlikely rather than impossible.
 */
export const RELEASE_BEFORE_DISCONNECT_MS = 250;

/**
 * Let go of a screen we were controlling. The close shortcut's own modifier
 * went down on the computer before its Esc arrived, and noVNC's clean-up
 * sends nothing once it is disconnecting, so release every modifier while
 * still connected, then disconnect a moment later.
 */
export function releaseAndDisconnect(rfb: Pick<RFB, "sendKey" | "disconnect">, interactive: boolean): void {
  const disconnect = (): void => {
    try {
      rfb.disconnect();
    } catch {
      /* already gone */
    }
  };
  if (!interactive) {
    disconnect();
    return;
  }
  for (const [keysym, code] of MODIFIER_KEYS) rfb.sendKey(keysym, code, false);
  setTimeout(disconnect, RELEASE_BEFORE_DISCONNECT_MS);
}

function useScreen(agent: Agent | undefined, interactive: boolean, generation: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const target = ref.current;
    if (!agent || !target) return;
    let rfb: RFB | null = null;
    let cancelled = false;
    setPhase("connecting");
    setError(null);

    void connectComputer(agent)
      .then((conn) => {
        if (cancelled) return;
        rfb = new RFB(target, conn.url, {
          shared: true,
          credentials: conn.password ? { password: conn.password } : undefined,
        });
        rfb.viewOnly = !interactive;
        rfb.scaleViewport = true;
        rfb.background = "transparent";
        rfb.focusOnClick = interactive;
        // The card is small and often open; keep its bytes down. The view
        // gets the full picture.
        rfb.qualityLevel = interactive ? 8 : 4;
        rfb.compressionLevel = interactive ? 2 : 6;
        rfb.addEventListener("connect", () => {
          setPhase("live");
          if (!interactive) {
            // A picture, not a control: nothing in the card may take focus.
            for (const el of target.querySelectorAll("canvas")) el.setAttribute("tabindex", "-1");
            rfb?.blur();
          }
        });
        rfb.addEventListener("disconnect", (e) => {
          const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
          if (!cancelled) {
            setPhase("failed");
            setError(clean ? "The screen closed." : "Lost the screen.");
          }
        });
        rfb.addEventListener("credentialsrequired", () => {
          // Should never happen: the ticket response carries the password.
          setPhase("failed");
          setError("The agent did not share its screen credentials.");
        });
        rfb.addEventListener("securityfailure", (e) => {
          setPhase("failed");
          setError((e as CustomEvent<{ reason?: string }>).detail?.reason ?? "The screen refused the connection.");
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPhase("failed");
        setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      if (rfb) releaseAndDisconnect(rfb, interactive);
      rfb = null;
    };
  }, [agent?.id, agent?.url, interactive, generation]);

  return { ref, phase, error };
}

/** Under Host/Model: the screen, small and live. */
export function ComputerCard(): ReactNode {
  const { agents, activeAgentId, computers, setComputerOpen, computerOpen } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const computer = computers[activeAgentId];
  const [generation, setGeneration] = useState(0);
  // One connection to the screen at a time: the card lets go while the view holds it.
  const { ref, phase, error } = useScreen(computerOpen ? undefined : agent, false, generation);
  if (!agent || !computer) return null;

  return (
    <div className="computer">
      <button
        className="computer__screen"
        style={{ aspectRatio: `${computer.screen.width} / ${computer.screen.height}` }}
        onClick={() => (phase === "failed" ? setGeneration((g) => g + 1) : setComputerOpen(true))}
        aria-label={`Open ${agent.name}'s computer`}
      >
        <div ref={ref} className="computer__canvas" />
        {phase !== "live" ? (
          <span className="computer__state">
            {phase === "connecting" ? "Connecting…" : (error ?? "Unavailable") + " · Retry"}
          </span>
        ) : null}
        {phase === "live" ? (
          <span className="computer__open">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
            </svg>
            Open
          </span>
        ) : null}
      </button>
      <div className="computer__caption">{agent.name}&rsquo;s computer</div>
    </div>
  );
}

/** The whole window: the screen, with the mouse and keyboard going to it. */
export function ComputerView(): ReactNode {
  const { agents, activeAgentId, computerOpen, setComputerOpen } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const [generation, setGeneration] = useState(0);
  const { ref, phase, error } = useScreen(computerOpen ? agent : undefined, true, generation);

  useEffect(() => {
    if (!computerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      // Escape belongs to the computer too, so only a modified one closes the view.
      if (!(e.key === "Escape" && (e.metaKey || e.ctrlKey))) return;
      // Keep the chord from the computer as the view closes.
      e.preventDefault();
      e.stopPropagation();
      setComputerOpen(false);
    };
    // Capture phase: once the screen has focus, noVNC's keydown handler on its
    // canvas stops every key from propagating, so a bubbling listener here
    // would never hear the chord.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [computerOpen, setComputerOpen]);

  if (!computerOpen || !agent) return null;
  return (
    <div className="computer-view">
      <div className="computer-view__bar">
        <span className="computer-view__title">{agent.name}&rsquo;s computer</span>
        <span className="computer-view__hint">
          {phase === "live" ? "You are in control. Anything you sign in to here stays signed in for the agent." : phase === "connecting" ? "Connecting…" : (error ?? "Unavailable")}
        </span>
        {phase === "failed" ? (
          <button className="btn" onClick={() => setGeneration((g) => g + 1)}>Retry</button>
        ) : null}
        <button className="computer-view__close" onClick={() => setComputerOpen(false)} aria-label="Close the computer view" title={computerCloseLabel(IS_MAC, IS_WINDOWS)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6.5 2.5v4h-4M6.5 6.5L2 2M9.5 13.5v-4h4M9.5 9.5L14 14" />
          </svg>
        </button>
      </div>
      <div className="computer-view__stage">
        <div ref={ref} className="computer-view__canvas" />
      </div>
    </div>
  );
}
