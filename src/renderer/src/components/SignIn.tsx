import { type ReactNode, useEffect, useRef, useState } from "react";
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
 *
 * Everything below the code exists because that "wrong profile" case had no way
 * out. The code is good for ten minutes, and those minutes used to be
 * unconditional: no cancel, no countdown, and no way to reopen a tab that had
 * been closed. Waiting is a reasonable thing to ask of someone only when they
 * can see how long is left and stop.
 */
export function SignIn(): ReactNode {
  const { signIn, cancelSignIn, authError } = useStore();
  const [code, setCode] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState<number | null>(null);
  const deadline = useRef<number | null>(null);

  useEffect(() => {
    if (!code) {
      setLeft(null);
      return;
    }
    // Ten minutes, matching the control plane's expiry. Shown rather than
    // implied: a countdown turns "waiting…" into a decision the person can make.
    deadline.current = Date.now() + 600_000;
    const tick = (): void =>
      setLeft(Math.max(0, Math.round(((deadline.current ?? 0) - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [code]);

  const begin = async (): Promise<void> => {
    setBusy(true);
    setCopied(false);
    try {
      const started = await signIn((c, verificationUri) => {
        setCode(c);
        setUrl(verificationUri ?? null);
      });
      if (!started) {
        setCode(null);
        setUrl(null);
      }
    } finally {
      setBusy(false);
    }
  };

  const startAgain = async (): Promise<void> => {
    await cancelSignIn();
    setCode(null);
    setUrl(null);
    setCopied(false);
    await begin();
  };

  const expired = left === 0;

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
            <button
              className="signin__code"
              title="Copy the code"
              onClick={() => {
                void navigator.clipboard.writeText(code);
                setCopied(true);
              }}
            >
              {code}
            </button>
            <p className="signin__hint">
              {expired
                ? "That code expired. Start again for a new one."
                : copied
                  ? "Copied. Approve it in your browser."
                  : "Approve this code in your browser. Waiting…"}
              {!expired && left !== null ? (
                <span className="signin__left">
                  {" "}
                  {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left
                </span>
              ) : null}
            </p>
            <div className="signin__actions">
              {url && !expired ? (
                <button
                  className="btn"
                  onClick={() => void window.studio?.openExternal(url)}
                  title="Open the approval page again"
                >
                  Open browser
                </button>
              ) : null}
              <button className="btn" onClick={() => void startAgain()} disabled={busy}>
                Start again
              </button>
            </div>
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

        <ControlPlane />
      </div>
    </div>
  );
}

/**
 * Which control plane this app signs in to.
 *
 * Ours is the default and stays one line of small print — the address only
 * becomes a question for someone running their own, and for them it has to be
 * answerable without a rebuild. Changing it signs the app out, because the
 * identity and every agent grant belong to the control plane that issued them.
 */
function ControlPlane(): ReactNode {
  const [state, setState] = useState<{ url: string; isDefault: boolean; default: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.studio?.controlPlane().then(setState);
  }, []);

  const apply = async (next: string | null): Promise<void> => {
    setError(null);
    try {
      const now = await window.studio!.setControlPlane(next);
      setState(now);
      setEditing(false);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!state) return null;
  const host = state.url.replace(/^https?:\/\//, "");

  if (!editing) {
    return (
      <div className="signin__issuer">
        {host}
        {state.isDefault ? null : " · custom"}
        <button className="signin__issuer-btn" onClick={() => { setEditing(true); setDraft(state.isDefault ? "" : host); }}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="signin__issuer signin__issuer--editing">
      <input
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={state.default.replace(/^https?:\/\//, "")}
        spellCheck={false}
        autoFocus
        onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) void apply(draft); if (e.key === "Escape") setEditing(false); }}
      />
      <div className="signin__issuer-row">
        <button className="btn btn--small" onClick={() => void apply(draft)} disabled={!draft.trim()}>Use this</button>
        {state.isDefault ? null : <button className="btn btn--small" onClick={() => void apply(null)}>Use the default</button>}
        <button className="btn btn--small" onClick={() => { setEditing(false); setError(null); }}>Cancel</button>
      </div>
      {error ? <div className="signin__error">{error}</div> : null}
    </div>
  );
}
