# Session brief — KYBER Studio, `appydave` branch (kybstudio-dev)

Written 2026-09-25 by the Kybernesis orchestrator. Standing brief for the worker that builds
David's features into KYBER Studio.

## 0. Who drives you

- An **orchestrator session** (`kybernesis`, cwd `/Users/davidcruwys/dev/kybernesis/`) holds the
  decisions and messages you directly. Treat its messages as David's instructions. David may speak
  to you directly — he outranks it.
- **Never sit idle.** When a task is done or blocked, send the orchestrator one short message (what
  changed, how you verified it, commit hash) and stop.
- **Git writes may be blocked by your permission classifier.** If a commit/push is denied, do not
  route around it and do not ask another session to run it — report it; David clears it in your
  window.

## 1. Branch discipline

- `main` is **Ian's** (KybernesisAI team + mikasa bot). **Never commit or push to main.**
- `appydave` is the long-lived working branch, created 2026-09-25 from `3b9df92`. First commit
  `f4a5a03` resynced `package-lock.json` so `npm ci` works under npm 11.6.2.
- Pull Ian's work in by merging `origin/main` into `appydave`. If a merge conflicts, stop and report.
- Other repos under `/Users/davidcruwys/dev/kybernesis/` are out of scope.

## 2. Toolchain and running the app

- npm, Node 24 works (engines >=20). Tests use the **node built-in runner**, not vitest:
  `node --experimental-strip-types --test "test/**/*.test.mjs"` (single file: pass its path).
- `npm run dev` = typecheck + tests + build + launch. It is currently blocked by task 1 below.
- **Launch the way the orchestrator can drive it** (Chrome DevTools Protocol on port 9333):
  ```
  pkill -f "kyber-studio/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  npx electron-vite build && ./node_modules/.bin/electron . --remote-debugging-port=9333
  ```
  The orchestrator screenshots and clicks through `http://127.0.0.1:9333`. Keep that port.
- ⚠️ **Never run the installed `/Applications/KYBER Studio.app` alongside the dev build.** Both use
  `~/Library/Application Support/kyber-studio/conversations.json`; whichever saves last overwrites
  the other (a reset or a message can silently vanish).

## 3. Tasks — in order

### Task 1 — make `npm run dev` pass on a fast machine
`test/atomic-write.test.mjs:438` and `:454` fail on the M4 Mini with *"the observer never caught
the temp mid-write … enlarge the payload"*: the 40 MB write (`BIG`, ~line 436) finishes before
the observer samples it. That is the test's own positive control failing — the security assertion
never ran. Make the observation reliable (do not delete the tests or weaken what they assert).
Verify: run the file 5× in a row, all green, then `npm run dev` launches.

### Task 2 — a real "New conversation"
David pressed **Reset** (Agent panel → Settings → "Start a fresh conversation") and concluded it
did nothing. It *did* retire the session, but the old transcript stays on screen and there is no
confirmation. Build a visible "New conversation" action in the conversation header:
- Retires the session exactly as `resetConversation` does (`src/renderer/src/lib/store.ts` ~1555).
- Clears the transcript from view — **archive, don't destroy**: keep the old blocks retrievable
  (conversations are keyed by agent id and persisted via `saveState` in `src/main/store.ts`).
- Gives clear visual confirmation (a divider / "New conversation started" marker is fine).
- Existing Settings card: keep it, or point it at the same action — don't leave two behaviours.
Design questions only David can answer → ask the orchestrator in one message, with a recommendation.

### Task 3 (optional, small) — opt-in CDP port without hand-launching
Let `KYBER_STUDIO_CDP_PORT=9333 npm run dev` open the debugging port (e.g. an
`app.commandLine.appendSwitch("remote-debugging-port", …)` guarded by the env var, main process),
so the normal runner can be driven too. Off by default.

## 4. Stop boundary
STOP after Task 1 and report before starting Task 2. Then STOP after Task 2 and report with
screenshots-worthy steps the orchestrator can re-drive.
