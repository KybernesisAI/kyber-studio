/**
 * The KYBER Studio domain model.
 *
 * Studio is the customer's console for agents that already exist. Agents run
 * where they were deployed — Vercel, exe.dev, a client VM — and Studio is a
 * door onto them alongside Slack and iMessage, not a replacement for either.
 *
 * Chat is the front door, but the app is not read-only: connections, channels,
 * routines, instructions, and agent identity are all managed here, because a
 * customer who lives in this app should never be told to go open a terminal to
 * connect Gmail or add Slack. What it deliberately does NOT do is scaffold and
 * deploy a new agent from nothing — that stays with `kyb init` and the FDE.
 */

/** A remote agent the user has a control-plane grant for. */
export interface Agent {
  /** Agents this one may call, as granted in the control plane. */
  peers?: { id: string; name: string; purpose?: string }[];
  id: string;
  /** Display name in the sidebar and header. */
  name: string;
  /** One-line role, shown under the name in Settings. */
  title?: string;
  description?: string;
  /** Base URL of the agent's eve deployment, e.g. https://sid-agent.exe.xyz */
  url: string;
  /** Hex color for the generated avatar mark. */
  accent: string;
  /** Sidebar organization. */
  pinned?: boolean;
  sectionId?: string | null;
  hidden?: boolean;
  unread?: boolean;
  notifications?: boolean;
  /** Populated from the transport; never assumed. */
  status?: "online" | "offline" | "unknown";
  lastMessageAt?: number;
  lastMessagePreview?: string;
}

export interface Section {
  id: string;
  name: string;
  collapsed?: boolean;
}

export type MessageRole = "user" | "agent";

/** One rendered block in a conversation. */
export type Block =
  | { kind: "text"; id: string; role: MessageRole; text: string; at: number }
  | {
      kind: "connection";
      id: string;
      at: number;
      /** e.g. "Gmail" */
      name: string;
      description: string;
      toolCount: number;
      icon?: string;
      accounts: { id: string; label: string; connected: boolean }[];
    }
  | { kind: "peer-activity"; id: string; at: number; events: PeerEvent[] }
  | {
      kind: "authorization";
      id: string;
      at: number;
      /** The connection asking, e.g. "gmail". */
      name: string;
      description?: string;
      /** Where the user signs in. Opened in their real browser, never in-app. */
      url?: string;
      userCode?: string;
      instructions?: string;
      expiresAt?: string;
      /** Set when the flow resolves, so the card stops asking. */
      outcome?: string;
    }
  | {
      kind: "question";
      id: string;
      at: number;
      /** eve's requestId, which the answer must carry back. */
      requestId: string;
      prompt: string;
      options?: { id: string; label: string; description?: string; style?: string }[];
      allowFreeform?: boolean;
      /** Set once answered, so the transcript keeps what was chosen. */
      answered?: string;
    };

/** One agent-to-agent hop, as reported by the dispatch layer. */
export interface PeerEvent {
  id: string;
  direction: "inbound" | "outbound";
  peer: { id: string; name: string; accent: string };
  text: string;
  at: number;
}

/**
 * Collapsed summary of a run of agent-to-agent events.
 *
 * Three shapes, because they read very differently in a transcript: one hop is
 * a sentence, a broadcast is a count of recipients, and a back-and-forth is a
 * count of messages. Anything else would either bury the peer names or lie
 * about the direction of the conversation.
 */
export type PeerSummary =
  | { kind: "single"; direction: "inbound" | "outbound"; peer: PeerEvent["peer"] }
  | { kind: "fanout"; peers: PeerEvent["peer"][] }
  | { kind: "thread"; messageCount: number; peers: PeerEvent["peer"][] };

export function summarizePeerEvents(events: PeerEvent[]): PeerSummary | null {
  if (events.length === 0) return null;
  const peers = new Map<string, PeerEvent["peer"]>();
  for (const e of events) peers.set(e.peer.id, e.peer);
  const unique = [...peers.values()];
  const first = events[0];
  if (events.length === 1 && first) {
    return { kind: "single", direction: first.direction, peer: first.peer };
  }
  if (events.every((e) => e.direction === "outbound") && unique.length >= 2) {
    return { kind: "fanout", peers: unique };
  }
  return { kind: "thread", messageCount: events.length, peers: unique };
}

export function peerSummaryLabel(s: PeerSummary, self?: string): string {
  // Named on both sides where possible — "Kyber asked Sid" reads as a fact
  // about the conversation, where "2 messages with 1 agents" reads as a
  // debug counter that also happens to be ungrammatical.
  const asker = self ? `${self} asked` : "Asked";
  switch (s.kind) {
    case "single":
      return s.direction === "inbound"
        ? `Message from ${s.peer.name}`
        : `${asker} ${s.peer.name}`;
    case "fanout":
      return `${asker} ${s.peers.length} agents`;
    case "thread": {
      const who = s.peers.length === 1 && s.peers[0] ? s.peers[0].name : `${s.peers.length} agents`;
      return `${asker} ${who} · ${s.messageCount} messages`;
    }
  }
}

/** A recurring instruction the agent runs on a schedule. */
export interface Routine {
  id: string;
  agentId: string;
  name: string;
  instruction: string;
  active: boolean;
  /** Human-readable for now; the agent's own scheduler owns the cron. */
  schedules: string[];
  runHistory: { at: number; ok: boolean }[];
}

/** A capability offered in the Plugins marketplace. */
export interface Plugin {
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  added?: boolean;
}

/**
 * A surface the agent can be reached on, besides Studio itself.
 *
 * Studio manages these rather than merely listing them: a customer adding Slack
 * to their agent should do it here. `configured` reflects what the agent's
 * deployment actually reports, never what we hope is true — an unconfigured
 * channel that renders as connected is worse than one that renders as missing.
 */
export interface Channel {
  id: string;
  kind: "slack" | "imessage" | "telegram" | "discord" | "sms" | "http";
  label: string;
  description: string;
  icon: string;
  configured: boolean;
  /** Short status line, e.g. "@kybernesis · 3 channels" or "needs a bot token". */
  detail?: string;
}

/** An external system the agent can read and write. */
export interface Connection {
  id: string;
  name: string;
  description: string;
  icon: string;
  toolCount?: number;
  accounts: { id: string; label: string; connected: boolean }[];
}

/**
 * A capability the agent can be told to run, offered by the composer's `/` menu.
 * Skills come from the agent's own deployment — Studio lists what the agent
 * reports rather than a hardcoded set, so a skill added by the FDE shows up
 * here without an app release.
 */
export interface Skill {
  id: string;
  name: string;
  description: string;
}
