---
story: 9
title: The agent's computer — live card, full view, and a visible task
human: true
source: commit 08ea02b ("The agent's computer: a live card under Host/Model and a full in-app view, through the agent's own ticketed relay")
---
EXPECT: For an agent that has a computer (its /eve/v1/kyb/computer answers with
a computer, not null), the agent panel shows a live Computer card under
Host/Model. Opening it shows the full in-app view. Asking the agent to open a
web page makes that page appear in the view while it happens.

SURPRISING: no card for an agent that has a computer; a card that never shows a
picture; the view frozen while the agent says it is working.

PRECONDITION (2026-10-16): no agent reachable from Roamy with this account has
a computer. The exe.xyz agents (cdv-agent, ndis-advisor, appydave-probe,
ndis-agent) answer 503 at the proxy; brandy (M4, via tunnel) has no /kyb routes;
tuber and sally are not running anywhere. The agent comes from UAT_COMPUTER_AGENT.

## steps
- openComputerAgent
- shot: 9-1-agent-open
- expectComputerCard
- shot: 9-2-computer-card
- openComputerView
- shot: 9-3-computer-view
- send: Please open https://example.com in the browser on your computer and tell me the page title.
- expectReply: Example Domain ~ 180
- shot: 9-4-after-task
- defer: Look at screenshots 9-3 and 9-4 (or the live view). Did you see the page open on the agent's computer while it worked, and does the view look right?
