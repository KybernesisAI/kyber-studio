# The UAT harness

Drives the **real** app the way a person does, and defers anything only a human
can judge.

```bash
node uat/run.mjs                 # every story
node uat/run.mjs 2 4             # only stories 2 and 4
node uat/run.mjs --self-test     # the deliberately-broken story; MUST fail
UAT_VERBOSE=1 node uat/run.mjs   # every action and assertion, raw
UAT_KEEP_HOME=1 node uat/run.mjs # keep the isolated home for inspection
```

Requires Node 22+ (global `WebSocket` and `fetch`). **Build first** if `src/`
changed — CDP attaches to built output, and driving a stale build looks exactly
like a product bug.

## Adopting it

Edit **`config.mjs`** and nothing else. Seven TODOs: app slug, ports, isolated
home + seeding, service launch/wait, app launch, and any extra verbs.

| File | |
|---|---|
| `config.mjs` | **the only file you edit** |
| `cdp.mjs` | protocol plumbing — do not edit |
| `harness.mjs` | generic verbs + expectations — **extend** with app verbs |
| `run.mjs` | launch / isolate / run / teardown / report — do not edit |
| `stories/` | one markdown file per case |
| `self-test/` | the deliberately-broken story |

## Adding a story — no code

Copy `STORY-TEMPLATE.md` into `stories/`, name it `story-N-slug.md`, edit it.
**That is the whole process.** No code touched, nothing registered, no rebuild.
The runner discovers `stories/*.md` and sorts by filename.

Adding a **verb** is the only thing that edits `harness.mjs` + `config.mjs`.

## Verdicts

| | |
|---|---|
| `PASS` | every step succeeded |
| `FAIL` | an expectation was not met, or an action did not happen |
| `HUMAN` | reached the point of judgement and **deferred to a person** |
| `ERROR` | the harness itself broke |

**`HUMAN` is never `PASS`.** A story ending in `defer:` cannot go green.

## The vocabulary

*Actions* — `press` · `type` (`placeholder ~ text`) · `select` · `hook` · `wait`

*Assertions* — `expectVisible` · `expectScreen` (`testid ~ text`) ·
`expectHook` (`hookName ~ text`) · `show` · `showHook` · `note`

*The escape hatch* — `defer: "the question a human must answer"`

## The boundary — do not erode this

**The harness does not grade how anything looked, sounded or felt.**

> **Automate reach, not judgement.** Get the app into the state where a human
> judgement is cheap to make, then stop and ask.

A green suite reporting PASS on something the harness cannot actually perceive
is worse than no harness, because it retires the human gate that was catching
exactly that. If you find yourself writing an assertion about how something
*sounded*, you are writing the wrong assertion — write a `defer:`.

## How it works

Two CDP targets, because they see different things:

- **renderer** (`--remote-debugging-port`) drives the real UI. Controls are
  found by the text a human reads on them; inputs are set via the native setter
  plus a bubbling event, which is what React actually observes.
- **main** (`--inspect`) reads the test-hooks global for what has no DOM:
  internal event logs, tray labels, window visibility.

Anything reachable through the real UI is driven through the renderer. The main
hooks are for state the UI cannot show, **never a shortcut around a control that
exists**. A hook must be the *same closure* the real control calls — one that
reimplements the action tests the hook.

→ Full rationale: `~/dev/ad/brains/testing-patterns/drivable-seams.md`

## Status — 2026-10-17 (0.5.17 on appydave, last run on Roamy)

1. PASS: 1 cold start, 2 cloud chat (Brandy via a temporary tunnel), 3 kybsite, 4 scheduled turn, 6 new conversation holds, 7 quit leaves nothing. Self-test fails as it must.
2. Story 5 (picker) is blocked: it needs a reachable agent on `@kybernesis/manage` ≥0.10 that serves `/kyb/sessions`. Brandy has 0.7-era routes and the picker shows "Loading…" forever.
3. Story 8 (voice orb) is stood down. There is no "Samantha" agent to grant. Voice is the per-agent `@kybernesis/voice` package plus that agent's own OpenAI key, and no agent has it yet. Which agent gets it is parked for David (see `~/dev/ad/brains/kybernesis/kyber-studio-voice-setup.md`).
4. Story 9 (computer) is blocked: no reachable agent has `@kybernesis/computer`, which needs Docker on the agent's host. The appydave-probe upgrade (manage 0.19 + computer on its exe.dev VM) is proposed, not started.
5. Re-run: `node uat/run.mjs [n…]`; point at agents with `UAT_CLOUD_AGENT`, `UAT_COMPUTER_AGENT`, `UAT_SAMANTHA`.
