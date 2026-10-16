---
story: 2
title: Chat with a cloud agent — send, and a streamed reply
human: false
source: .appynet/briefs/kyberstudio-uat.md step 4b
---
EXPECT: typing to the cloud agent puts my message on screen at once, and the
agent's answer arrives in the same conversation.

SURPRISING: the message never appears, the spinner never stops, or an error
card about grants or reachability.

## steps
- openCloudAgent
- send: "Reply with exactly: UAT-CLOUD-OK"
- expectReplyStreamed: 180
- expectReply: UAT-CLOUD-OK ~ 5
- shot: 2-cloud-reply
