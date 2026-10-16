---
story: 99
title: SELF-TEST — a deliberately broken assertion
human: false
---
EXPECT: this story MUST fail. It exists to prove the harness can detect a false claim.

SURPRISING: if this story PASSES, the harness is broken and every other green
result in this suite is worthless.

## steps
- expectVisible: THIS TEXT IS NOT ON SCREEN AND NEVER WILL BE
