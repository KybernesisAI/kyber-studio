---
type: north-star
horizon: quest
status: open
created: 2026-10-03
ratified_by: David, in the kybernesis orchestrator window, 2026-10-03
parent: ~/dev/ad/brains/kybernesis/orchestrator-charter.md
ticket: K013 (~/dev/ad/brains/kybernesis/tickets.md)
---

# Quest North Star — coding agents in KYBER Studio, backed by Claude Code

```yaml
north_star: "Do my per-project coding from KYBER Studio instead of a wall of iTerm windows —
  each project is a Studio agent that is a Claude Code session in that repo's folder."
horizon: quest
status: open
first_waypoint: "kybsite — the kybernesis-site repo — as ONE Studio agent, used end to end by David."
bearing: |
  Studio (appydave branch only) gains a LOCAL coding-agent type: name + folder + model. A message
  spawns the user's own installed, already-signed-in `claude` CLI as a subprocess in that folder
  (`-p`, stream-json, resumed session), streams the reply into the conversation, and keeps the
  session id so the next message continues it. Transcripts stay where Claude Code writes them
  (~/.claude/projects), so AngelEye can index them.
```

## Why
David runs ~11 long-lived coding windows (3 Kybernesis, 8 FliVideo). They can't be messaged,
tracked or found from one place. B540 (2026-09-06,
`~/dev/ad/brains/north-star/deliver-2026-09-06-B540-claude-code-session-as-agent.md`) proved the
folder half — a Claude Code session in a folder with CLAUDE.md *is* the agent — and found Studio
could not host it only because Studio knew no non-eve agent type. Studio is now ours to change on
`appydave`.

## Hard constraints
- **Anthropic terms** (code.claude.com/docs/en/agent-sdk/overview, read 2026-10-03): *"Unless
  previously approved, Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products."* So: Studio never handles a Claude login or token — it only
  launches the user's own `claude` binary, exactly as a terminal does. **This feature stays on
  `appydave`; it is never offered to Ian's `main` / customers without Anthropic approval or an
  API-key mode.**
- No change to the eve agent path (Sally, Tuber keep working).
- Done = David sends a message to "kybsite" in Studio and Claude Code answers from the
  kybernesis-site repo; a second message continues the same session; the transcript is on disk.

## Side quests (parked, not abandoned)
Moving the 8 FliVideo windows across · lifecycle/restart after reboot · messaging between coding
agents · surfacing transcripts via AngelEye inside Studio.
