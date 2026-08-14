# KYBER Studio

The desktop app for talking to your Kybernesis agents — and for letting them
work on your machine, your accounts, and your own tools when the work is yours.

Agents run where they were deployed: Vercel, exe.dev, a client VM. Studio is a
door onto them, alongside Slack and iMessage rather than instead of either. The
same agent, the same memory, the same tools; a different surface.

> Status: shipping. Signed, notarized, and self-updating. Sign in, hold a
> conversation, connect Gmail or Calendar in a click, point the agent at an MCP
> server on your laptop, and have it read, search, edit, and run things locally.
> What is still missing is listed at the bottom, not glossed over.

## What it does

- **Chat with your remote agents.** Streaming replies, markdown and code blocks,
  and a live line saying what the agent is doing — thinking, using a named tool,
  delegating to a subagent — derived from the agent's own event stream rather
  than a generic spinner.
- **Sign in through the control plane.** RFC 8628 device flow, so desktop access
  is governed by exactly the same grants as every other surface. The token is
  encrypted with the OS keychain and never reaches the renderer.
- **Connect your apps.** Gmail, Calendar, Drive, Slack, Notion, Linear, GitHub
  and more, each one click. What you connect becomes tools in your next session,
  under your account and nobody else's.
- **Bring your own tools.** Any MCP server — a command on your laptop or a URL —
  becomes agent tools. Remote servers are handshaked before they are saved, so a
  bad URL fails while you are typing it rather than during a demo.
- **Work on your own machine.** An agent can search, read, edit, write, and run
  commands locally through Studio. You approve each kind of action once.
- **Write routines from chat.** "Every weekday at 8, brief me" becomes a real
  schedule on the agent's deployment — no repository access required.
- **Put several agents in one room.** A group conversation where each agent
  answers under its own name. Tag one and only they reply; tag `@everyone` and
  they all do; tag nobody and the room's lead answers and brings the others in.
  Agents hand work to each other by naming each other, and whoever is brought in
  is caught up on what they missed.
- **See agents talk to each other.** When an agent consults another deployment,
  the exchange collapses into one line naming who was asked — click it to read
  the whole thing as its own conversation, instead of it drowning yours.
- **Address anyone with `@`.** The menu offers the agents you can actually
  reach: in a room, its members; elsewhere, the peers the control plane says
  this agent may call.

## Running it

```bash
npm install
npm run dev          # or: npm run build && npm start
```

Use `scripts/dev.sh` rather than launching by hand — it kills the previous run
by PID and asserts that exactly one app is left. (`pkill -f` matches the caller
and orphans the child, which is how four Studios end up open at once.)

Sign-in points at `https://agent.kybernesis.ai` by default; override with
`KYBERNESIS_ISSUER`. Set `KYBER_STUDIO_DEBUG_STREAM=1` to print the raw agent
event stream, which is the fastest way to see what an agent is actually doing.

## Releases

Tag `v*` and the pipeline builds, signs, notarizes, and publishes. A running
copy notices within hours and offers an update in the sidebar. See
`.claude/skills/kyber-studio-release` — it starts by launching the packaged app,
because a build that passes CI can still fail to open.

## Local execution

Studio holds an outbound connection to the control plane and runs what you
approve. Nothing listens on a port here, so it works behind NAT with no tunnel.

Consent is per **effect** — `run-command`, `read-file`, `write-file`,
`list-directory`, `local-mcp` — not per tool, so a new tool that reaches an
existing effect cannot bypass consent you already gave. MCP servers are approved
per server; listing what a server offers is exempt, since being asked to approve
something before you can see what it is helps nobody.

The optional working folder is a default starting directory, not a boundary.
Whether an agent builds in its own sandbox or on your machine is decided by what
you asked for, not by a mode.

See [docs/local-execution.md](docs/local-execution.md) for the design and its
current gaps.

## Group conversations

A room lives entirely in this app. Each member keeps its own session with its
own deployment — they are separate services, and sharing a session between them
would leak one agent's context into another's — and Studio is what puts a
message in front of all of them. No agent needs to know the feature exists,
which is what makes it work with any agent you have.

**Addressing is the routing.** Naming a member sends it to them alone;
`@everyone` sends it to the room; naming nobody follows the room's setting
(the lead answers, by default). Matching is literal and needs the `@`, so an
agent called Design is not summoned by the word design in a sentence.

**An agent's reply reaches another agent only when it names them** — no
fallback, and a depth cap behind that. With a fallback, one reply becomes a
reply from everyone, each of which can trigger another round; that is a fork
bomb with a billing account.

**A hand-off carries what the receiving agent missed**, bounded to the recent
messages. Without it, an agent brought into a conversation asks the room for
context the room already has.

Each member takes one turn at a time, with the rest queued; a member that stops
responding is released by a watchdog and says so in the room; and Stop cancels
every member still working, dropping what was queued behind them.

## Known gaps

- **Two consent systems that cannot revoke each other.** The control plane holds
  a standing per-device grant; Studio holds per-effect permissions in a local
  file. Revoking in one does not revoke the other.
- **Reaching a desktop is not its own capability.** "May talk to this agent" and
  "may run commands on my laptop" are still one decision.
- **Exec runs in the main process.** Commands are spawned as children, but a bug
  in the exec module can still take the window down.
- **MCP servers are per-machine.** Your second laptop has a different set, and
  nothing in the UI says which machine a server is on.
- **Tool volume is unmanaged.** Two connected services can be fifty tool
  definitions in every prompt. Connect what you need.
- **A room's hand-off convention is a prompt, not a protocol.** Each turn tells
  the agent it is in a room and that naming someone hands off to them. A
  well-behaved agent follows it; nothing enforces it. A misbehaving one is
  ignored rather than able to start a cascade, which is why relay has no
  fallback.
- **A relayed message runs under YOUR identity.** When one agent hands to
  another, the second acts with your authority on the first one's say-so. Fine
  among your own agents; worth deciding deliberately anywhere else.

## Built with

Electron, React, TypeScript, and [eve](https://eve.dev) on the agent side.
Agent-side capabilities come from [`@kybernesis/local`](https://www.npmjs.com/package/@kybernesis/local),
[`@kybernesis/connectors`](https://www.npmjs.com/package/@kybernesis/connectors),
and [`@kybernesis/manage`](https://www.npmjs.com/package/@kybernesis/manage).

---

© Kybernesis. Licensed under the MIT License — see [LICENSE](LICENSE).
