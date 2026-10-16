---
story: 99
title: A short name, the way the product owner would say it
human: false
source: docs/acceptance-plan.md
---
EXPECT: what should happen, in the acceptance plan's own words. Printed when a
human judgement is required.

SURPRISING: what would be alarming, in the acceptance plan's own words. Printed
on failure, so the report reads like the plan rather than like a stack trace.

## steps
- type: search box ~ "the text to type"
- press: Search
- expectScreen: result-count ~ 3 results
- expectHook: getEventLog ~ search_completed
- defer: "Ask the question the harness must not answer itself."
