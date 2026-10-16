---
story: 4
title: Scheduled turn — posts into the agent's conversation
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b
---
EXPECT: uat-scratch has a schedule at 00:00, so the first scheduler tick after
launch posts it as a turn in uat-scratch's conversation, marked as scheduled,
and the agent answers it there.

SURPRISING: nothing posts (the scheduler is not running), it posts twice, or it
runs somewhere hidden instead of in the conversation.

NOTE: config.mjs resets local-schedule-state.json at the start of every run, so
today's slot is always due.

## steps
- openAgent: uat-scratch
- expectReply: SCHEDULED-UAT-OK ~ 240
- expectVisible: scheduled 00:00
- shot: 4-scheduled-turn
