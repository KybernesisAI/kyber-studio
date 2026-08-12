import type { AgentSummary } from "@shared/ipc";

/**
 * Flatten eve's agent-info payload into something the UI cannot crash on.
 *
 * Every access is guarded because this comes from a remote agent that may run a
 * different eve version than we expect. A field that is missing, renamed, or a
 * different shape must degrade to an empty list — never throw, and never be
 * mistaken for a confident "none".
 */

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function named(items: unknown[], nameKey = "name"): { name: string; description?: string }[] {
  const out: { name: string; description?: string }[] = [];
  for (const item of items) {
    const o = obj(item);
    const name = str(o[nameKey]) ?? str(o.name);
    // An entry with no name is neither renderable nor identifiable — drop it
    // rather than show a blank row nobody can act on.
    if (name) out.push({ name, description: str(o.description) });
  }
  return out;
}

export function summarize(info: unknown): AgentSummary {
  const root = obj(info);
  const agent = obj(root.agent);
  const model = obj(agent.model);

  const tools = obj(root.tools);
  const skills = obj(root.skills);
  const channels = obj(root.channels);
  const subagents = obj(root.subagents);

  return {
    name: str(agent.name) ?? str(root.name),
    model: str(model.id) ?? str(agent.model) ?? str(root.model),

    // Arrays in eve's payload, but verified rather than assumed.
    schedules: arr(root.schedules).map((s) => {
      const o = obj(s);
      return {
        name: str(o.name) ?? "unnamed",
        cron: str(o.cron),
        hasRun: typeof o.hasRun === "boolean" ? o.hasRun : undefined,
        markdown: str(o.markdown),
      };
    }),

    connections: arr(root.connections).map((c) => {
      const o = obj(c);
      return {
        name: str(o.connectionName) ?? str(o.name) ?? "unnamed",
        description: str(o.description),
      };
    }),

    // A SURFACE, not a route. eve lists one entry per HTTP route, so a single
    // chat surface arrives as nine rows of session plumbing — which reads as
    // "this agent has seventeen channels" when it has three. Group by the
    // channel that owns the routes and count them instead.
    //
    // Authored, not available: available includes framework routes the author
    // never declared (connection callbacks and the like), and those are not
    // places anyone can reach the agent.
    channels: groupChannels(arr(channels.authored).length ? arr(channels.authored) : arr(channels.available)),

    skills: named(arr(skills.static)),

    // Authored only: the framework tools are eve's own and say nothing about
    // what this agent was built to do.
    tools: named(arr(tools.authored)),

    subagents: named(arr(subagents.local)),
  };
}

/** Human names for the channels we ship, so a surface reads as a surface. */
const CHANNEL_LABELS: Record<string, string> = {
  eve: "KYBER Studio & HTTP API",
  photon: "iMessage",
  slack: "Slack",
  telegram: "Telegram",
  discord: "Discord",
  teams: "Microsoft Teams",
  twilio: "SMS",
  linear: "Linear",
  github: "GitHub",
  kyb: "Management (KYBER Studio)",
};

function groupChannels(items: unknown[]): { name: string; urlPath?: string }[] {
  const byName = new Map<string, { name: string; urlPath?: string; routes: number }>();
  for (const item of items) {
    const o = obj(item);
    const raw = str(o.name);
    if (!raw) continue;
    // Framework route ids look like "eve/v1/connections/callback/get"; the
    // channel that owns them is the first segment.
    const key = raw.split("/")[0] ?? raw;
    const existing = byName.get(key);
    if (existing) existing.routes += 1;
    else byName.set(key, { name: key, urlPath: str(o.urlPath), routes: 1 });
  }
  return [...byName.values()].map((c) => ({
    name: CHANNEL_LABELS[c.name] ?? c.name,
    urlPath: c.routes > 1 ? `${c.routes} routes` : c.urlPath,
  }));
}
