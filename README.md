# KYBER Studio

The desktop app for talking to your Kybernesis agents — and for letting them
work on your machine when the work is yours.

Agents run where they were deployed: Vercel, exe.dev, a client VM. Studio is a
door onto them, alongside Slack and iMessage rather than instead of either. The
same agent, the same memory, the same tools; a different surface.

> Status: early. It works end to end — sign in, list your agents, hold a
> conversation, and have an agent read, search, edit, and run things on your
> machine. Several panels are still fixtures, and the local-execution capability
> is not yet governed. Both are called out below rather than glossed over.

## What it does

- **Chat with your remote agents.** Streaming replies, markdown and code blocks,
  and a live line saying what the agent is doing — thinking, using a named tool,
  delegating to a subagent — derived from the agent's own event stream rather
  than a generic spinner.
- **Sign in through the control plane.** RFC 8628 device flow, so desktop access
  is governed by exactly the same grants as every other surface. The token is
  encrypted with the OS keychain and never reaches the renderer.
- **Work on your own machine.** An agent can search, read, edit, write, and run
  commands locally through Studio. You approve each kind of action once.
- **See agents talk to each other.** Agent-to-agent traffic collapses into one
  openable line instead of drowning your conversation.

## Running it

```bash
npm install
npm run dev          # or: npm run build && npm start
```

Sign-in points at `https://agent.kybernesis.ai` by default; override with
`KYBERNESIS_ISSUER`. Set `KYBER_STUDIO_DEBUG_STREAM=1` to print the raw agent
event stream, which is the fastest way to see what an agent is actually doing.

## Local execution

Studio holds an outbound connection to the control plane and runs what you
approve. Nothing listens on a port here, so it works behind NAT with no tunnel.

Consent is per **effect** — `run-command`, `read-file`, `write-file`,
`list-directory` — not per tool, so a new tool that reaches an existing effect
cannot bypass consent you already gave. Default is ask.

The optional working folder is a default starting directory, not a boundary.
Whether an agent builds in its own sandbox or on your machine is decided by what
you asked for, not by a mode.

See [docs/local-execution.md](docs/local-execution.md) for the design and its
current gaps.

## Known gaps

- **Panels are partly fixtures.** Routines, connections, and channels render but
  do not yet read from or write to the agent's deployment.
- **Local execution is not governed.** The agent authenticates to the relay with
  a shared secret. It must become its own revocable capability — "may talk to
  this agent" and "may run commands on my laptop" are different decisions.
- **Exec runs in the main process.** Commands are spawned as children, but a bug
  in the exec module can still take the window down.

## Built with

Electron, React, TypeScript, and [eve](https://eve.dev) on the agent side.

---

© Kybernesis. Licensed under the MIT License — see [LICENSE](LICENSE).
