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
        {/* The Kybernesis K, regular weight (the brand's weight for 32 to 96px).
            One ink, coloured from CSS: Void on light, Paper on dark. */}
        <svg className="signin__mark" viewBox="0 0 147.36 210.16" role="img" aria-label="Kybernesis">
          <path fillRule="evenodd" d="M77.28 23.00L58.16 11.96L39.04 0.92L19.92 11.96L0.80 23.00L0.80 45.08L0.80 55.08L0.80 75.08L0.80 85.08L0.80 95.08L0.80 147.16L11.26 153.20L28.58 163.20L39.04 169.24L49.50 163.20L66.82 153.20L70.08 151.32L70.08 155.08L70.08 165.08L70.08 175.08L70.08 187.16L89.20 198.20L108.32 209.24L118.78 203.20L127.44 198.20L136.10 193.20L146.56 187.16L146.56 175.08L146.56 165.08L146.56 155.08L146.56 143.00L127.44 131.96L115.52 125.08L127.44 118.20L146.56 107.16L146.56 95.08L146.56 85.08L146.56 75.08L146.56 63.00L136.10 56.96L127.44 51.96L118.78 46.96L108.32 40.92L89.20 51.96L77.28 58.85L77.28 55.08L77.28 45.08ZM39.04 40.92L23.52 31.96L11.60 25.08L23.52 18.20L39.04 9.24L54.56 18.20L66.48 25.08L54.56 31.96ZM70.08 63.00L54.56 71.96L45.90 76.96L42.64 78.85L42.64 47.16L58.16 38.20L70.08 31.32L70.08 45.08L70.08 55.08ZM49.50 86.96L46.24 85.08L49.50 83.20L58.16 78.20L70.08 71.32L70.08 75.08L70.08 85.08L70.08 95.08L70.08 98.85L66.82 96.96ZM8.00 55.08L8.00 45.08L8.00 31.32L19.92 38.20L35.44 47.16L35.44 87.16L45.90 93.20L63.22 103.20L70.08 107.16L70.08 138.85L66.82 136.96L58.16 131.96L35.44 118.85L35.44 158.85L32.18 156.96L14.86 146.96L8.00 143.00L8.00 95.08L8.00 85.08L8.00 75.08ZM89.20 131.96L80.54 136.96L77.28 138.85L77.28 111.32L80.54 113.20L89.20 118.20L101.12 125.08ZM63.22 146.96L45.90 156.96L42.64 158.85L42.64 131.32L54.56 138.20L63.22 143.20L66.48 145.08ZM92.80 71.96L84.14 66.96L80.88 65.08L92.80 58.20L108.32 49.24L115.18 53.20L123.84 58.20L132.50 63.20L135.76 65.08L123.84 71.96L108.32 80.92ZM77.28 103.00L77.28 95.08L77.28 85.08L77.28 75.08L77.28 71.32L80.54 73.20L89.20 78.20L104.72 87.16L104.72 118.85L92.80 111.96L84.14 106.96ZM139.36 103.00L123.84 111.96L111.92 118.85L111.92 87.16L127.44 78.20L139.36 71.32L139.36 75.08L139.36 85.08L139.36 95.08ZM84.14 146.96L80.88 145.08L84.14 143.20L92.80 138.20L108.32 129.24L123.84 138.20L135.76 145.08L123.84 151.96L108.32 160.92L92.80 151.96ZM77.28 183.00L77.28 175.08L77.28 165.08L77.28 155.08L77.28 151.32L80.54 153.20L89.20 158.20L104.72 167.16L104.72 195.08L104.72 198.85L92.80 191.96ZM115.18 196.96L111.92 198.85L111.92 195.08L111.92 167.16L127.44 158.20L139.36 151.32L139.36 155.08L139.36 165.08L139.36 175.08L139.36 183.00L132.50 186.96L123.84 191.96Z" />
        </svg>
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
