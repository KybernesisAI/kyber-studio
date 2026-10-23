import { artifactList, type ArtifactSummary } from "@shared/artifacts";
import { activeSession, authHeaders } from "./controlPlane";

/**
 * The person's artifacts on one agent, for the Artifacts drawer.
 *
 * @remarks
 * Fetched with the person's own token, like the viewer's content (see
 * agentContent.ts): the agent answers only with what this person may see. A
 * 404 is an agent whose manage predates the routes, which reads differently
 * from an agent that has made nothing yet.
 */
export async function agentArtifacts(input: {
  url: string;
}): Promise<{ ok: boolean; artifacts?: ArtifactSummary[]; error?: string }> {
  let target: URL;
  try {
    target = new URL(`${input.url.replace(/\/$/, "")}/eve/v1/kyb/artifacts`);
  } catch {
    return { ok: false, error: "This agent has no address." };
  }
  try {
    const s = await activeSession();
    if (!s) return { ok: false, error: "You are signed out. Sign in again to see this." };
    const res = await fetch(target, { headers: authHeaders(s, { bundle: true }), signal: AbortSignal.timeout(20_000) });
    if (res.status === 404) return { ok: false, error: "This agent cannot keep artifacts yet. It needs an update." };
    if (!res.ok) return { ok: false, error: `The agent answered ${res.status}.` };
    return { ok: true, artifacts: artifactList(await res.json()) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
