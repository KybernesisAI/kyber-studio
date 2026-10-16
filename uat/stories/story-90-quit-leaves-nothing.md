---
story: 7
title: Quit — local turns stop and nothing is left running
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b
---
EXPECT: with a local Claude Code turn still running, quitting Studio stops that
turn and everything it started, and the app's whole process tree is gone.

SURPRISING: a `claude` or `sleep` process still alive after Studio has quit.

NOTE: always the LAST story (file sorts after 8 and 9) because it quits the app.
Quit is app.quit() through the main inspector — the closure the Quit menu item
calls. It does not prove macOS delivers ⌘Q.

## steps
- openAgent: uat-scratch
- send: "Run the shell command `sleep 120` in your working folder, then reply SLEPT."
- wait: 20000
- shot: 7-1-turn-running
- quitAndCheckProcesses
