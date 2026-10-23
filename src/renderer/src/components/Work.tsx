import { visibleSteps, type Step } from "@kybernesis/cards";
import { type ReactNode, useState } from "react";
import { Icon } from "./primitives";
import { Spinner } from "./Spinner";

/**
 * What the agent did in a turn, as steps.
 *
 * Live, each tool call is a line: a chip naming what it touched (MEMORY,
 * POSTHOG, COMPUTER) and one sentence of what it did. When the turn ends the
 * lines fold to one, so a finished conversation reads as questions and answers
 * with the work one click away, not as a log.
 *
 * A step still marked running after its turn ended (a cancelled or abandoned
 * turn) is shown as stopped rather than spinning forever.
 */

function StepLine({ step, live }: { step: Step; live: boolean }): ReactNode {
  const running = step.status === "running" && live;
  return (
    <div className={`step step--${running ? "running" : step.status}`}>
      <span className="step__chip">{step.chip}</span>
      <span className="step__label">{step.label}</span>
      <span className="step__state">
        {running ? (
          <Spinner />
        ) : step.status === "failed" ? (
          <span className="is-bad">Failed</span>
        ) : step.status === "rejected" || step.status === "running" ? (
          <span>Stopped</span>
        ) : (
          <Icon name="check" size={12} />
        )}
      </span>
    </div>
  );
}

/** "Memory, PostHog and Gmail". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function WorkSteps({ steps, live }: { steps: Step[]; live: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const shown = visibleSteps(steps);
  if (shown.length === 0) return null;
  const running = live && shown.some((s) => s.status === "running");

  if (running || open) {
    return (
      <div className="work">
        {!running ? (
          <button className="work__toggle" onClick={() => setOpen(false)}>
            <Icon name="chevronRight" size={11} />
            <span>Hide steps</span>
          </button>
        ) : null}
        <div className="work__steps">
          {shown.map((step) => (
            <StepLine key={step.callId} step={step} live={live} />
          ))}
        </div>
      </div>
    );
  }

  const chips = [...new Set(shown.map((s) => s.chip))];
  const failed = shown.filter((s) => s.status === "failed").length;
  return (
    <div className="work">
      <button className="work__toggle" onClick={() => setOpen(true)}>
        <Icon name="chevronRight" size={11} />
        <span>
          Used {joinNames(chips.slice(0, 4))}
          {chips.length > 4 ? ` and ${chips.length - 4} more` : ""}
          {` · ${shown.length} ${shown.length === 1 ? "step" : "steps"}`}
          {failed ? <span className="is-bad">{` · ${failed} failed`}</span> : null}
        </span>
      </button>
    </div>
  );
}
