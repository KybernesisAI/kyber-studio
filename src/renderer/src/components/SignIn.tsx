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
        <KMark />
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

/** The Kybernesis K, the same mark as the app icon, drawn in ink with no tile. */
function KMark(): ReactNode {
  return (
    <svg className="signin__mark" viewBox="0 0 147.36 210.16" role="img" aria-label="Kybernesis">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M78.08 22.54L58.56 11.27L39.04 0.00L19.52 11.27L0.00 22.54L0.00 45.08L0.00 55.08L0.00 75.08L0.00 85.08L0.00 95.08L0.00 147.62L10.86 153.89L28.18 163.89L39.04 170.16L49.90 163.89L67.22 153.89L69.28 152.70L69.28 155.08L69.28 165.08L69.28 175.08L69.28 187.62L88.80 198.89L108.32 210.16L119.18 203.89L127.84 198.89L136.50 193.89L147.36 187.62L147.36 175.08L147.36 165.08L147.36 155.08L147.36 142.54L127.84 131.27L117.12 125.08L127.84 118.89L147.36 107.62L147.36 95.08L147.36 85.08L147.36 75.08L147.36 62.54L136.50 56.27L127.84 51.27L119.18 46.27L108.32 40.00L88.80 51.27L78.08 57.46L78.08 55.08L78.08 45.08ZM39.04 40.00L23.92 31.27L13.20 25.08L23.92 18.89L39.04 10.16L54.16 18.89L64.88 25.08L54.16 31.27ZM69.28 62.54L54.16 71.27L45.50 76.27L43.44 77.46L43.44 47.62L58.56 38.89L69.28 32.70L69.28 45.08L69.28 55.08ZM49.90 86.27L47.84 85.08L49.90 83.89L58.56 78.89L69.28 72.70L69.28 75.08L69.28 85.08L69.28 95.08L69.28 97.46L67.22 96.27ZM8.80 55.08L8.80 45.08L8.80 32.70L19.52 38.89L34.64 47.62L34.64 87.62L45.50 93.89L62.82 103.89L69.28 107.62L69.28 137.46L67.22 136.27L58.56 131.27L34.64 117.46L34.64 157.46L32.58 156.27L15.26 146.27L8.80 142.54L8.80 95.08L8.80 85.08L8.80 75.08ZM88.80 131.27L80.14 136.27L78.08 137.46L78.08 112.70L80.14 113.89L88.80 118.89L99.52 125.08ZM62.82 146.27L45.50 156.27L43.44 157.46L43.44 132.70L54.16 138.89L62.82 143.89L64.88 145.08ZM93.20 71.27L84.54 66.27L82.48 65.08L93.20 58.89L108.32 50.16L114.78 53.89L123.44 58.89L132.10 63.89L134.16 65.08L123.44 71.27L108.32 80.00ZM78.08 102.54L78.08 95.08L78.08 85.08L78.08 75.08L78.08 72.70L80.14 73.89L88.80 78.89L103.92 87.62L103.92 117.46L93.20 111.27L84.54 106.27ZM138.56 102.54L123.44 111.27L112.72 117.46L112.72 87.62L127.84 78.89L138.56 72.70L138.56 75.08L138.56 85.08L138.56 95.08ZM84.54 146.27L82.48 145.08L84.54 143.89L93.20 138.89L108.32 130.16L123.44 138.89L134.16 145.08L123.44 151.27L108.32 160.00L93.20 151.27ZM78.08 182.54L78.08 175.08L78.08 165.08L78.08 155.08L78.08 152.70L80.14 153.89L88.80 158.89L103.92 167.62L103.92 195.08L103.92 197.46L93.20 191.27ZM114.78 196.27L112.72 197.46L112.72 195.08L112.72 167.62L127.84 158.89L138.56 152.70L138.56 155.08L138.56 165.08L138.56 175.08L138.56 182.54L132.10 186.27L123.44 191.27Z"
      />
    </svg>
  );
}
