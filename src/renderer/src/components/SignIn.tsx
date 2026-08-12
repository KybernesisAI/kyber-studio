import { type ReactNode, useState } from "react";
import { useStore } from "@/lib/store";
import { Icon } from "./primitives";

/**
 * Device-flow sign-in (RFC 8628).
 *
 * The user approves in a browser against the Kybernesis control plane, and the
 * identity token that comes back is what every agent's HTTP door verifies. That
 * means Studio access is governed by exactly the same grants as Slack and
 * iMessage — revoke someone in the control plane and the desktop goes with it.
 *
 * The user code is shown in the app as well as opened in the browser, because
 * an auto-opened tab that lands on the wrong profile is common and the code is
 * then the only way to finish.
 */
export function SignIn(): ReactNode {
  const { signIn, authError } = useStore();
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = async (): Promise<void> => {
    setBusy(true);
    try {
      const started = await signIn((c) => setCode(c));
      if (!started) setCode(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__mark">K</div>
        <h1 className="signin__title">KYBER Studio</h1>
        <p className="signin__sub">
          Sign in with your Kybernesis account to reach the agents you have been granted.
        </p>

        {code ? (
          <>
            <div className="signin__code">{code}</div>
            <p className="signin__hint">
              Approve this code in your browser. Waiting…
            </p>
          </>
        ) : (
          <button className="btn btn--primary signin__btn" onClick={begin} disabled={busy}>
            {busy ? "Opening your browser…" : "Sign in"}
          </button>
        )}

        {authError ? (
          <div className="signin__error">
            <Icon name="close" size={13} /> {authError}
          </div>
        ) : null}

        <div className="signin__issuer">{useStore.getState().issuer}</div>
      </div>
    </div>
  );
}
