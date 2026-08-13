# Local execution: how a cloud agent works on your machine

Why KYBER Studio is built the way it is, and what we learned from prior art
before building it.

## The problem

A KYBER agent runs where it was deployed — Vercel, exe.dev, a client VM. Your
files are on your laptop. Nothing about "an agent in the cloud" gives it a way
to read `/Users/you/project`, and no firewall will let the cloud open a
connection *into* a laptop.

The answer is to invert the direction: **the desktop connects out, and the cloud
sends work down that pipe.**

```
  cloud agent                 relay (control plane)          KYBER Studio
  ───────────                 ─────────────────────          ────────────
  calls local_* tool ───────▶  queues the work
                               GET  /api/local-exec/requests ◀──── long poll
                                                                   (outbound only)
                                                             ┌──▶ consent card
                               POST /api/local-exec/frames   ◀┤    (once per effect)
                               POST /api/local-exec/responses ◀┘
  polls /status      ◀────────  correlated by job id
```

No inbound port, no tunnel, no port forwarding — which is also why it works
behind corporate NAT.

## Design decisions, and why

### Consent is per effect, not per tool

The actions a user approves are named by what happens to their machine:

```
run-command · read-file · write-file · list-directory
```

Not by which tool asked. This matters more than it looks: `local_edit` and
`local_write` both declare `write-file`, and `local_search` declares
`read-file`, because they are the same consequence for your files. If
permissions were named per tool, adding a second tool that reaches an existing
effect would quietly bypass consent already given. Two tools were added after
the fact and needed zero new permissions, which is the property working.

Default is `ask`. A fresh install must not hand an agent someone's machine
silently.

### A working folder is not a fence

Studio has an optional working folder. It is a default starting directory, not a
boundary — permission to act on the machine is granted once, per effect, and an
agent with that permission may work wherever it is asked to.

This was wrong in the first version, which treated the folder as a mode: pick a
folder to "enable" local access, with no way back. That fences the agent out of
everything until the user performs a setup step, and models the relationship
badly. Someone given access to your laptop has access to your laptop; the
directory you happen to be in is where they start.

Whether to use the sandbox or the local machine is decided by **the ask**, not by
a switch — "build me a demo" goes to the agent's sandbox exactly as it would
from Slack, "look at my repo" goes local. Prior art agrees: the reference
implementation we studied has no folder picker at all, and distinguishes the two
purely by which tool the model reaches for.

### The timeout is on silence, not duration

Studio streams output frames as a command produces them. Each frame resets an
idle clock, and the agent gives up only when the work goes quiet.

The first version used a fixed deadline, which is backwards at both ends: a
healthy three-minute build was killed, and a hung command held the line for the
full timeout before anyone noticed. Inverting it means a twenty-minute build
finishes while a genuine hang is caught in a couple of minutes.

This is why `/api/local-exec/call` returns a job id instead of the answer. A
serverless function has a bounded lifetime and a real build does not, so no
single request may be asked to outlive the work. The agent polls `/status`; the
model still sees one blocking tool call, and the waiting happens somewhere
allowed to wait.

### Failure modes are distinct answers

Disconnected, declined, and failed are three different things, and each returns
as itself. An agent that cannot reach the desktop says the desktop is closed —
it does not conclude your files are missing, and it does not retry in a loop.

## What we deliberately have not built yet

- **A separate exec daemon.** Execution runs in Studio's main process. Commands
  are spawned as children so a runaway command cannot take the window down, but
  a bug in the exec module can. The reference design isolates this in a
  supervised child process, and that is the next hardening step.
- **Background work that outlives a connection.** A dev server or a very long
  install should detach and wake the agent when it finishes.
- **A considered size bound.** File limits here are incidental parameters rather
  than a reasoned cap. Bytes ship base64 over JSON, so a large file costs several
  times its size in memory — worth bounding deliberately.
- **Command policy.** No denylist, and nothing that fails closed on a command it
  cannot analyze. Not needed for one person on their own laptop; needed the day
  this reaches a client with a security team.

## Who is allowed, and how nobody types a credential

Two separate questions, and both must be answered before anything runs.

**Identity — which agent is calling?** A signed agent credential, verified
offline against the org's keys. It has to exist: with a standing permission in
place, a relay that took the agent's NAME from the request body would let anyone
who guessed `sid` run commands on that user's laptop. A name in a body is a
claim, not proof.

**Consent — did this person allow that agent on this machine?** A standing grant
(`local_exec_grant`), no expiry, recorded per device. "Always allow" means
always: whether the work starts in a chat window, a schedule, or a message sent
from a phone. It ends when the person revokes it, the device is removed, or the
agent is disabled. An expiring grant would be us quietly re-asking a question
they already answered.

An authenticated agent with no grant reaches nothing. A granted agent that
cannot prove which agent it is reaches nothing either.

### The credential is installed by software, never by a person

This is the part that matters for anyone shipping this to a client. The earlier
design had an operator copying a secret out of an admin screen and pasting it
into a deployment's env file — not a setup step a customer will ever perform
correctly, or at all.

KYBER Studio is signed in as the owner, so it can mint from the control plane;
it already talks to the agent over an authenticated channel, so it can install
there. One switch in the agent's settings — *Work on this computer* — does all
three steps:

1. `POST {issuer}/api/agents/credential` — mint it (owner-or-manage only)
2. `POST {agent}/eve/v1/kyb/credential` — install it; the agent restarts to load it
3. `POST {issuer}/api/local-exec/grant` — record the standing permission

Order matters: credential first, permission last. An agent that is allowed but
cannot identify itself has a grant that does nothing, and a half-finished setup
should look unfinished rather than allowed.

The install route is deliberately **not** a general env-write route. It accepts
only keys that identify the agent to the control plane, and no value can be read
back out. A general one would set a model key or a webhook secret, and would sit
one authenticated bug away from being the most dangerous route in the agent.

## What is still not solved

Reaching a desktop is not its own revocable capability on the agent edge. "May
talk to this agent" and "may run commands on my laptop" are one decision today,
taken at the point where the person allows the machine. The standing grant is
where that split belongs when it comes.

There is also no command policy — no denylist, nothing that fails closed on a
command it cannot analyse. Fine for one person on their own laptop; needed the
day this reaches a client with a security team.
