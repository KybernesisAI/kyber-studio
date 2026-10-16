---
story: 5
title: Conversation picker — an older thread stays open through a sync
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b (Ian's sessionChoice model, v0.5.17)
---
EXPECT: opening an older thread from the agent panel shows it, and it is still
the thread on screen after the 30 s cross-device sync has run.

SURPRISING: the view flips back to the newest thread within 30 s.

PRECONDITION (2026-10-16): the agent must serve GET /eve/v1/kyb/sessions
(@kybernesis/manage 0.10.0+). No agent reachable from Roamy does: Brandy has no
/kyb routes, and appydave-probe pins manage 0.7.0. Until one does, this FAILs at
"open an older thread". Point it at one with UAT_CLOUD_AGENT.

## steps
- openCloudAgent
- openOlderThread
- wait: 3000
- rememberView: picked
- shot: 5-1-older-thread
- waitSync: 40
- expectViewStill: picked
- shot: 5-2-after-sync
