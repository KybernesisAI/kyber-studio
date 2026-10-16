---
story: 1
title: Cold start — signed in, and the agent list loads
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b
---
EXPECT: Studio opens signed in (or waits while you sign in once), and the sidebar
lists both kinds of agent: the cloud agent this machine can reach, and the local
Claude Code agents.

SURPRISING: a blank window, a sign-in screen that never clears, or a sidebar
missing the local agents (the appydave additions) or the cloud agents (the
control plane).

NOTE: Brandy is the cloud agent because it is the only one reachable from Roamy
(through the SSH tunnel to the M4). Override with UAT_CLOUD_AGENT.

## steps
- waitSignedIn: 900
- expectVisible: kybsite
- expectVisible: uat-scratch
- expectCloudAgentListed
- shot: 1-agent-list
