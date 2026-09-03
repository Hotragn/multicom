# 90-second demo

## Before recording

- Use two browser sessions in the same room: one private commander link and one responder link.
- Start with the scripted fault armed and both health indicators red.
- Keep the browser console closed and zoom at 100%.
- Record original narration and system audio only.
- Keep the finished video under three minutes; the target cut is 90 seconds.

## Storyboard

**0:00–0:08 — The problem**

Show the critical status header. Say: “Production is down. Three engineers, three browser agents, one shared incident room.”

**0:08–0:22 — Native agent access**

Show two agents calling `join_room` and `get_service_status`. Briefly reveal the browser's registered WebMCP tools. Say: “The page exposes twelve narrow tools. No copy-paste and no hidden backend integration.”

**0:22–0:48 — Evidence and disagreement**

Query logs, run `pool_in_use`, and show hypotheses arrive in both sessions. Point at the injection-trap line. Say: “Logs are marked untrusted and rendered only as text. The agents use the evidence, but never follow the instruction inside it.”

**0:48–1:08 — Decide safely**

Propose `scale_pool:default`, vote from both participants, and request confirmation. Show the commander dialog. Say: “Agents can argue and vote, but they cannot approve their own write.” Click approve.

**1:08–1:23 — Verify recovery**

Apply the mitigation. Hold on the falling error rate until both pages turn green. Say: “The room verifies the target after the action. Every connected tab resolves together.”

**1:23–1:30 — Close**

Show the resolved summary and activity history. Say: “multicom: a multiplayer incident room built directly on WebMCP.”

## Capture list

- Critical status header with MTTR timer
- Two sessions showing the same new hypothesis
- Literal injection-trap log output
- Passed mitigation and human confirmation dialog
- Resolved state in both sessions
- Browser tool list showing exactly 12 tools
