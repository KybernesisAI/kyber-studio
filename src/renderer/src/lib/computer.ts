import type { Agent } from "@shared/types";

/**
 * One connection's worth of what the RFB client needs: the relay socket URL
 * with a fresh single-use ticket, and the credentials the agent handed over
 * inside the authed exchange. The person never sees a VNC login.
 */
export interface ComputerConnection {
  url: string;
  password?: string;
  screen: { width: number; height: number };
}

export async function connectComputer(agent: Agent): Promise<ComputerConnection> {
  if (!window.studio || !agent.url) throw new Error("This agent has no URL.");
  const res = await window.studio.manage({ url: agent.url, path: "/computer/ticket", body: {} });
  if (!res.ok) {
    const detail = (res.data as { error?: string } | null)?.error;
    throw new Error(detail ?? `The agent would not open its screen (${res.status}).`);
  }
  const data = res.data as {
    ticket: string;
    path: string;
    computer: { screen: { width: number; height: number } };
    credentials: { password?: string } | null;
  };
  const base = new URL(agent.url);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  base.pathname = data.path;
  base.search = `?ticket=${encodeURIComponent(data.ticket)}`;
  return { url: base.toString(), password: data.credentials?.password, screen: data.computer.screen };
}
