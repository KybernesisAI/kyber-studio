---
story: 3
title: Local agent kybsite — a Claude Code turn answers
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b
---
EXPECT: kybsite (Claude Code in kybernesis-site) answers in its conversation.

SURPRISING: "claude CLI not found", "folder does not exist", or no answer.

NOTE: the prompt forbids tools. kybernesis-site may have a live session working
in it, and this story must never touch that repo.

## steps
- openAgent: kybsite
- send: "Reply with exactly: KYBSITE-UAT-OK. Do not use any tools and do not read or change any files."
- expectReply: KYBSITE-UAT-OK ~ 240
- shot: 3-kybsite-reply
