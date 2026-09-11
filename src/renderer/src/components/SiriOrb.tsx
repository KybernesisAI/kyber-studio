/**
 * SiriOrb — animated voice orb with state-based visual feedback.
 *
 * Ported from the Samantha desktop app. Self-contained: no Tailwind, no design
 * system. The visual is a pure CSS conic-gradient sphere (SiriOrb.css); this
 * component only drives its colours, glow, and overlays from `state` and
 * `audioLevel`.
 */

import React, { useMemo } from "react";
import "./SiriOrb.css";

export type OrbState = "idle" | "listening" | "thinking" | "speaking" | "error" | "connecting";
export type OrbSize = "sm" | "md" | "lg" | "xl";

export interface SiriOrbProps {
  state?: OrbState;
  size?: OrbSize;
  audioLevel?: number;
  onClick?: () => void;
  className?: string;
}

const sizeMap: Record<OrbSize, number> = { sm: 128, md: 192, lg: 256, xl: 320 };

const cx = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(" ");

export const SiriOrb: React.FC<SiriOrbProps> = ({
  state = "idle",
  size = "md",
  audioLevel = 0,
  onClick,
  className = "",
}) => {
  const sizeValue = sizeMap[size];

  const animationDuration = useMemo(() => {
    switch (state) {
      case "speaking":
        return 6;
      case "thinking":
        return 8;
      case "connecting":
        return 10;
      case "listening":
        return 15;
      default:
        return 25;
    }
  }, [state]);

  const audioScale = state === "listening" && audioLevel > 0 ? 1 + audioLevel * 0.2 : 1;

  const glowIntensity = useMemo(() => {
    switch (state) {
      case "listening":
        return `0 0 ${30 + audioLevel * 40}px rgba(147, 51, 234, ${0.6 + audioLevel * 0.4})`;
      case "speaking":
        return "0 0 35px rgba(147, 51, 234, 0.7)";
      case "connecting":
        return "0 0 20px rgba(245, 158, 11, 0.6)";
      case "error":
        return "0 0 20px rgba(239, 68, 68, 0.5)";
      default:
        return "0 0 10px rgba(147, 51, 234, 0.3)";
    }
  }, [state, audioLevel]);

  const colors = useMemo(() => {
    if (state === "connecting") {
      return {
        bg: "oklch(70% 0.35 85)",
        c1: "oklch(65% 0.30 75)",
        c2: "oklch(75% 0.33 95)",
        c3: "oklch(70% 0.37 80)",
      };
    }
    if (state === "error") {
      return {
        bg: "oklch(50% 0.25 25)",
        c1: "oklch(55% 0.30 20)",
        c2: "oklch(45% 0.28 30)",
        c3: "oklch(50% 0.32 15)",
      };
    }
    return {
      bg: "oklch(95% 0.02 264.695)",
      c1: "oklch(75% 0.15 350)",
      c2: "oklch(80% 0.12 200)",
      c3: "oklch(78% 0.14 280)",
    };
  }, [state]);

  const blurAmount = sizeValue < 50 ? Math.max(sizeValue * 0.008, 1) : Math.max(sizeValue * 0.015, 4);
  const contrastAmount = sizeValue < 50 ? Math.max(sizeValue * 0.004, 1.2) : Math.max(sizeValue * 0.008, 1.5);

  return (
    <div
      className={cx("siri-orb-wrapper", className)}
      style={{
        width: `${sizeValue}px`,
        height: `${sizeValue}px`,
        transform: `scale(${audioScale})`,
        filter: `drop-shadow(${glowIntensity})`,
      }}
    >
      {/* Invisible click target on top so clicks always land. */}
      <div
        className="siri-orb-click-target"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick?.();
        }}
      />

      <div
        className="siri-orb"
        style={
          {
            width: "100%",
            height: "100%",
            "--bg": colors.bg,
            "--c1": colors.c1,
            "--c2": colors.c2,
            "--c3": colors.c3,
            "--animation-duration": `${animationDuration}s`,
            "--blur-amount": `${blurAmount}px`,
            "--contrast-amount": contrastAmount,
          } as React.CSSProperties
        }
      />

      {state === "listening" && audioLevel > 0.1 && (
        <>
          <div className="orb-ring orb-ring--ping" style={{ opacity: audioLevel * 0.6 }} />
          <div className="orb-ring orb-ring--pulse" style={{ transform: "scale(1.2)", opacity: audioLevel * 0.4 }} />
        </>
      )}

      {state === "speaking" && (
        <div className="orb-overlay">
          <div className="orb-bars">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="orb-bar" style={{ animationDelay: `${i * 100}ms` }} />
            ))}
          </div>
        </div>
      )}

      {state === "connecting" && (
        <div className="orb-overlay">
          <div className="orb-dots">
            {[0, 1, 2].map((i) => (
              <div key={i} className="orb-dot" style={{ animationDelay: `${i * 200}ms` }} />
            ))}
          </div>
        </div>
      )}

      {state === "error" && <div className="orb-ring orb-ring--error" />}
    </div>
  );
};

SiriOrb.displayName = "SiriOrb";
