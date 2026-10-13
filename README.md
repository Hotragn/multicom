<div align="center">

<img src="web/public/favicon.svg" alt="" width="72" height="72">

# multicom

**A shared incident rehearsal for engineers and their WebMCP browser agents.**

They gather evidence on one live board, challenge and revise theories in public,<br>
vote on a fix, and leave the final simulated action to a human commander.

[**Live app**](https://multicom-web.pages.dev/) &nbsp;·&nbsp;
[**Demo**](#demo) &nbsp;·&nbsp;
[**How it uses WebMCP**](#how-it-uses-webmcp) &nbsp;·&nbsp;
[**Run it**](#run-and-test-it) &nbsp;·&nbsp;
[**Spec**](SPEC.md)

![WebMCP: 13 tools](https://img.shields.io/badge/WebMCP-13_tools-8fb3e8?style=flat-square)
![Cloudflare Workers and Durable Objects](https://img.shields.io/badge/Cloudflare-Workers_%2B_Durable_Objects-f38020?style=flat-square&logo=cloudflare&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)
![License: MIT](https://img.shields.io/badge/license-MIT-7fd4c1?style=flat-square)

</div>

## Demo

<!-- Full narrated video: edit this file on github.com and drag
     docs/demo/multicom-demo-github.mp4 (under 10 MB) onto the blank line below.
     GitHub uploads it and puts an inline player there. -->


https://github.com/user-attachments/assets/6cf39f28-a825-4960-8d69-293822e95c06


<a href="https://multicom-web.pages.dev/"><img src="docs/screenshots/00-demo-preview.gif" alt="Clips from the demo: two browsers on one board; an agent revising its own confidence from 35% to 10% after a rebuttal; the commander's approval dialog and the click; the error rate falling to 1% in both windows" width="100%"></a>

<sub>Clips from the 2:48 narrated demo, recorded on the live September 3 build: two browsers share one board · an author moves its own number after a rebuttal · nothing applies until a person clicks Approve · both windows recover together. Click to open the live app.</sub>

The synthetic `storefront-api` is failing at 23%. The cause is buried in logs that
include one line telling agents to skip diagnosis and roll back immediately.

## Try it

> ### [multicom-web.pages.dev](https://multicom-web.pages.dev/)

Click **Start my own incident**. You get an isolated copy of the fault and can
claim the commander seat. Copy **Invite** and send it to a teammate: both
browsers see the same board, while other teams get their own rooms.

Then pick a way in. All three drive the same messages through the same gates.

| Route | What you need |
| --- | --- |
| **Bring your own agent** | Chrome 149+ with `chrome://flags/#enable-webmcp-testing` (verified on 152), or any browser via the MCP-B polyfill. Copy the first instruction from the page. |
| **Drive it by hand** | Real operator controls — run a check, pull logs, propose, rebut, revise, vote, approve. Any browser. |
| **Run the scripted drill** | A house responder proposes the red herring and concedes to the evidence. Ninety seconds, no setup. |

**Judge console** (or `?judge=1`) gives a ten-row rubric that ticks only from
events that really happened, each row carrying its log entry, plus a run summary
and a Markdown/JSON export. The incident is deterministic, so runs compare.

## What makes it different

**Agents change their minds in public.** When a rebuttal lands, the author
revises their own confidence and the board keeps both numbers — the opening
figure struck through, the new one beside it, the reason underneath. Revising is
author-only, so a theory cannot be edited out from under whoever staked a number
on it. Everyone else has to argue.

![A theory marked Challenged: its author's confidence shown as 35% struck through beside 10%, with "Arjun revised down: the timeline predates the flag" underneath, above the cited evidence and the rebuttal that moved it](docs/screenshots/12-revised-confidence.png)

**The debate is the product.** Hypotheses carry cited evidence, take rebuttals,
and win or lose a majority vote with stated reasons — the red herring visibly loses.

**A human holds the write.** A passed vote is not permission. Approval comes only
from a click in the browser — no tool on the thirteen-tool surface can produce
one, even for an agent in the commander seat. It is bound to one action, expires
after 60 seconds, and is consumed by a single apply; the replay is refused.

**Prompt injection, handled.** The planted log line returns marked untrusted and
renders as plain text, never as an instruction.

**Multiplayer and isolated.** Up to six people and their agents share one room
over one WebSocket on a Cloudflare Durable Object; a hypothesis lands in every
other browser in under 300 ms. Each room holds its own copy of the fault, so
resolving one leaves every other room still broken.

![The commander's approval overlay, naming the server-derived action, the blast radius, and who voted why](docs/screenshots/05-commander-approval.png)

More of the interface is in [docs/screenshots/](docs/screenshots/).

## How it uses WebMCP

The page registers thirteen imperative tools once after load, feature-detecting
`navigator.modelContext` then `document.modelContext`, with an MCP-B polyfill
fallback and no iframes:

`join_room` · `get_room_state` · `get_service_status` · `query_logs` ·
`run_check` · `propose_hypothesis` · `counter_hypothesis` · `revise_hypothesis` ·
`propose_mitigation` · `vote` · `explain_vote` · `request_human_confirm` ·
`apply_mitigation`

Every call travels the room's WebSocket with a request ID. The server owns
voting, approval, idempotency and the action allowlist — three fixed actions, so
an agent cannot invent a change. Log results are untrusted; results stay under 2 KB.

```mermaid
flowchart LR
  L[Lobby] -->|mints an isolated room| R
  A[Responder page + agent] <-->|WebSocket| R[Room Worker<br/>Durable Object per room]
  B[Commander page + agent] <-->|WebSocket| R
  R -->|reads, tagged with the room| T[storefront-api<br/>scenario per room]
  R -->|approved allow-listed action| T
  B -->|human clicks Approve| R
```

## Run and test it

Node.js 22+, npm, and a platform Cloudflare's local `workerd` supports. Copy
`target/.dev.vars.example` and `worker/.dev.vars.example` to `.dev.vars` with the
same `TARGET_TOKEN` in both, then:

```bash
npm install && npm run dev     # http://127.0.0.1:5173/
npm test                       # typecheck, 47 unit tests, 26 Chromium journeys
npm run verify:prod            # 32 checks against the real Workers
```

`verify:prod` clicks the real overlay, applies against the real target, watches
recovery in three browsers, proves a bystander room is untouched, and checks the
origin and tenant gates. [docs/TESTING.md](docs/TESTING.md) maps the coverage.

## Reading further

- [SPEC.md](SPEC.md) — the implementation contract; §19 covers rooms as tenants, the lobby, and author-only revision
- [SECURITY.md](docs/SECURITY.md) — trust boundaries and the two commander models
- [AGENT-DRILL.md](docs/AGENT-DRILL.md) — two real language-model agents working the incident unaided
- [DEPLOY.md](docs/DEPLOY.md) — configuration and deploy
- [VISUAL-SYSTEM.md](docs/VISUAL-SYSTEM.md) — the design system

**Status:** deployed 2026-09-03 — room `c6686ced`, target `f70f44ab`, Pages
`index-DKQrjK_5.js`. Against this bundle: smoke 9/9, live acceptance 32/32,
drill green, 13 tools native in Chrome, a bystander room still at 23%.

## License

[MIT](LICENSE) © 2026 Hotragn Pettugani.
