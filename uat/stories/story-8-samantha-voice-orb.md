---
story: 8
title: Samantha shows the voice orb, and David judges a spoken round-trip
human: true
source: .appynet/briefs/kyberstudio-uat.md (added 2026-10-16, top priority)
---
EXPECT: Samantha is in the agent list. Opening her shows the voice control,
because her agent answers /eve/v1/voice/manifest with enabled: true. Speaking to
her and hearing her answer is for David to judge, by ear.

SURPRISING: Samantha is missing from the list (no grant for this account), or
she opens with no voice control (manifest not enabled, or the agent unreachable
from this machine).

PRECONDITION (2026-10-16): david@kybernesis.ai is a member of the Kybernesis org
with no grant on samantha. Only the org owner/admin, or Samantha's owner, can
give access. Until then this story FAILs at the first step, which is correct.

## steps
- openSamantha
- shot: 8-1-samantha-open
- expectVoiceOrb
- shot: 8-2-voice-orb
- defer: Press the voice control, say "What day is it today?", and judge whether Samantha answers aloud, intelligibly, in her own voice, without cutting you off.
