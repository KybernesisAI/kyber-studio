# Brief — local Claude Code agents in KYBER Studio (first waypoint: kybsite)

Written 2026-10-03 by the Kybernesis orchestrator. Read
`/Users/davidcruwys/dev/kybernesis/kyber-studio/docs/planning/claude-code-agents/north-star.md` first —
it is the direction and holds the hard constraints. Also read
`/Users/davidcruwys/dev/kybernesis/kyber-studio/docs/SESSION-BRIEF-appydave.md` (branch discipline,
how to launch the dev build on CDP :9333, shared-state warning).

## You report to the orchestrator
Session `kybernesis` (cwd `/Users/davidcruwys/dev/kybernesis/`). Its messages carry David's
instructions. Report in one message when done or blocked; never sit idle. Problems found along the
way → one message (what · evidence · proposed fix); don't fix out of scope.
Git: you may run `git add`, `git commit`, `git push origin appydave` as separate commands
(David's allow rules). Never touch `main`.

## Build
1. **Spike first (report before building):** how Studio models an agent today (`src/shared/types.ts`
   — `Agent` requires an eve `url`; sidebar from `GET /api/me/agents`; send path in
   `src/main/controlPlane.ts`). Propose the smallest way to add a second kind of agent that is
   local-only and not from the control plane. One message, with the file list.
2. **The local coding agent:** config `{ id, name, folder, model }` stored locally (user data dir,
   atomic write like other state). Seed one: `kybsite` → `/Users/davidcruwys/dev/kybernesis/kybernesis-site`,
   model `sonnet`.
3. **Send:** spawn the user's `claude` binary (resolve on PATH; never bundle, never read or store
   credentials) with cwd = folder: `-p <message> --output-format stream-json --verbose
   --model <model> --permission-mode auto`, and `--resume <sessionId>` after the first turn.
   Stream assistant text into the conversation; persist the session id per agent.
4. **Lifecycle:** one process per turn; Stop button kills the child; a crash shows the stderr tail.
5. **Tests** for the arg-building and stream parsing (pure functions), plus the existing suite green.

## Done (orchestrator re-verifies by driving Studio on :9333)
- "kybsite" appears in the sidebar, marked as local.
- Message "What branch are you on and what does this repo do, in two lines?" → a reply that
  names `appydave` and the Kybernesis site.
- A second message continues the same session (`--resume`), and the transcript exists under
  `~/.claude/projects/`.
- Sally and Tuber still work.
STOP after Done and report. Do not start the FliVideo windows.
