import { activeSession, authHeaders } from "./controlPlane";

/**
 * Pictures and artifacts a card points at, fetched from the agent.
 *
 * @remarks
 * A card is data the agent wrote, so everything here treats its addresses as
 * untrusted. Only the agent's own origin is fetched, and only with a plain GET:
 * a card naming some other host gets a link the person can choose to open, never
 * a request from this machine. Answers are size-capped and type-checked before
 * they reach the window.
 *
 * The person's own token goes with the request, because what an agent shows one
 * person (a screenshot of their checkout, their private artifact) is not for the
 * next person who asks.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const ARTIFACT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `src` on the agent's own origin, or null for anywhere else. */
export function onAgent(agentUrl: string, src: string): URL | null {
  try {
    const base = new URL(agentUrl);
    const target = new URL(src, base);
    return target.origin === base.origin ? target : null;
  } catch {
    return null;
  }
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > cap) return null;
  const body = new Uint8Array(await res.arrayBuffer());
  return body.byteLength > cap ? null : body;
}

async function agentGet(target: URL): Promise<Response> {
  const s = await activeSession();
  if (!s) throw new Error("You are signed out. Sign in again to see this.");
  return fetch(target, { headers: authHeaders(s, { bundle: true }), signal: AbortSignal.timeout(30_000) });
}

/** An image on the agent, as a data URL the window may show. */
export async function agentImage(input: { url: string; src: string }): Promise<{ ok: boolean; dataUrl?: string; error?: string }> {
  const target = onAgent(input.url, input.src);
  if (!target) return { ok: false, error: "That picture is not on the agent." };
  try {
    const res = await agentGet(target);
    if (!res.ok) return { ok: false, error: `The agent answered ${res.status}.` };
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return { ok: false, error: "That is not a picture." };
    const body = await readCapped(res, MAX_IMAGE_BYTES);
    if (!body) return { ok: false, error: "That picture is too large to show here." };
    return { ok: true, dataUrl: `data:${type};base64,${Buffer.from(body).toString("base64")}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/**
 * One artifact's content, from the agent's artifacts routes (manage 0.25+).
 *
 * The format comes from the agent's answer (`x-artifact-format`), not from the
 * card, so a card cannot make markdown run as a page. No version means the
 * latest, which is what an Open on an older card should show.
 */
export async function agentArtifact(input: {
  url: string;
  artifactId: string;
  version?: number;
}): Promise<{ ok: boolean; content?: string; format?: "html" | "markdown"; version?: number; latest?: number; error?: string }> {
  if (!ARTIFACT_ID.test(input.artifactId)) return { ok: false, error: "That is not an artifact." };
  const base = input.url.replace(/\/$/, "");
  const target = new URL(`${base}/eve/v1/kyb/artifacts/${encodeURIComponent(input.artifactId)}/content`);
  if (input.version !== undefined) target.searchParams.set("v", String(input.version));
  try {
    const res = await agentGet(target);
    if (res.status === 404) return { ok: false, error: "This agent cannot show that artifact. It may be someone else's, or the agent needs an update." };
    if (!res.ok) return { ok: false, error: `The agent answered ${res.status}.` };
    const body = await readCapped(res, MAX_ARTIFACT_BYTES);
    if (!body) return { ok: false, error: "That artifact is too large to show here." };
    const number = (name: string): number | undefined => {
      const n = Number(res.headers.get(name));
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    return {
      ok: true,
      content: new TextDecoder().decode(body),
      format: res.headers.get("x-artifact-format") === "markdown" ? "markdown" : "html",
      version: number("x-artifact-version"),
      latest: number("x-artifact-latest"),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
