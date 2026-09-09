import type { RemoteAgent } from "@shared/ipc";

type Probe = (url: string) => Promise<boolean>;

/**
 * Compatibility for control planes that still return one daemon-wide URL for
 * several path-routed agents. Only shared URLs are candidates, and the derived
 * route must answer its own health probe before Studio uses it.
 */
export async function resolveSharedGatewayUrls(
  agents: RemoteAgent[],
  probe: Probe,
): Promise<RemoteAgent[]> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const base = normalized(agent.url);
    if (base) counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  return await Promise.all(
    agents.map(async (agent) => {
      const base = normalized(agent.url);
      if (!base || (counts.get(base) ?? 0) < 2) return agent;

      const candidate = `${base}/agents/${encodeURIComponent(agent.name)}`;
      return (await probe(candidate)) ? { ...agent, url: candidate } : agent;
    }),
  );
}

function normalized(url: string | null): string | null {
  const value = url?.trim().replace(/\/+$/, '');
  return value || null;
}
