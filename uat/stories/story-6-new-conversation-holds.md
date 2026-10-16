---
story: 6
title: New conversation — the view clears and holds through a sync
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b; the 2026-10-16 merge ruling
---
EXPECT: after talking to the agent, "New conversation" empties the view with the
"Fresh start" hint, and 40 s later — after a cross-device sync has run — it is
still empty. The thread just left is not adopted back.

SURPRISING: the old conversation reappears within 30 s. That was the bug both
appydave (retiredSessions) and main (sessionChoice) fixed; the merge keeps
main's model and records "New conversation" as a pick of no thread.

## steps
- openCloudAgent
- send: "Reply with exactly: BEFORE-RESET"
- expectReply: BEFORE-RESET ~ 180
- waitIdle: 60
- shot: 6-1-before-reset
- pressNewConversation
- expectFreshStart
- shot: 6-2-fresh-start
- waitSync: 40
- expectFreshStart
- shot: 6-3-after-sync
