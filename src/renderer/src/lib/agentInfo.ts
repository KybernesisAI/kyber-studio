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

    // Grouped objects: prefer what the agent actually exposes, and fall back to
    // the authored set when "available" is absent.
    channels: (arr(channels.available).length ? arr(channels.available) : arr(channels.authored)).map(
      (c) => {
        const o = obj(c);
        return { name: str(o.name) ?? "unnamed", urlPath: str(o.urlPath) };
      },
    ),

    skills: named(arr(skills.static)),

    // Authored only: the framework tools are eve's own and say nothing about
    // what this agent was built to do.
    tools: named(arr(tools.authored)),

    subagents: named(arr(subagents.local)),
  };
}
