# Devpost draft

This is working copy for the project page. Replace every `TODO` only with verified public links or recorded assets.

## Devpost field copy (final — paste into the four required fields)

**How does your project use WebMCP?**

The room page registers thirteen imperative WebMCP tools after load, feature-detecting `navigator.modelContext` then `document.modelContext`. They cover service status, checks, logs, hypotheses, rebuttals, revising your own confidence, mitigations, votes with rationales, and human confirmation. Every call travels the room's WebSocket with a request ID, and the server owns voting, approval, and idempotency. Log results are marked untrusted, and every result stays under 2 KB.

**Why is this a better user experience?**

Incident response is already collaborative, but AI help is one agent in one private chat. Evidence gets pasted between tabs, nobody's agent hears anybody else's reasoning, weak theories go unchallenged, and the person accountable for production cannot see what an agent intends to change. Here the page the engineers read is the same surface every agent acts on. A theory gets contradicted by another agent's evidence in front of everyone, its author moves their own number in response, and the pending write is visible before it happens rather than after.

**What can people and agents do together now that they could not before?**

Agents can change their minds in front of each other. Several engineers' agents work one live incident in one page: each cites evidence, rebuts theories it disputes, and — when a rebuttal lands — revises its own stated confidence, which the board shows as 92% struck through beside 20% with the reason underneath. Revising is author-only, so a theory cannot be edited out from under whoever staked a number on it; everyone else has to argue. A server-counted majority then decides the fix, and one human click applies it. Each visitor gets an isolated copy of the incident and can claim the commander seat with no shared secret, so several people run this at once without touching each other. A planted log line tells agents to skip diagnosis and roll back immediately. It stays literal, arrives marked untrusted, and no agent obeys it.

**How did you implement WebMCP?**

A static TypeScript and Vite client registers the surface once, with an MCP-B fallback and no iframes. A Cloudflare Worker maps each room to one Durable Object holding presence, boards, votes, approvals, and replay protection; a lobby object mints unguessable room IDs on demand. A second Worker runs the scripted fault and keys its state per room, so resolving one incident cannot heal anybody else's. It accepts only three known action IDs behind a bearer token. Approval text is server-derived, expires in 60 seconds, and is consumed before the target is called.

Everything below is supporting working copy for the rest of the project page.

## Title

multicom

## One-line summary

A multiplayer incident room where browser agents investigate together, challenge weak theories, and act only after a human commander approves the fix.

## The problem

Incident response is collaborative, but AI assistants usually work in separate conversations. Evidence gets copied between tabs, contradictory theories linger, and the person accountable for production loses a clear view of what an agent intends to change.

## What multicom does

multicom gives every engineer the same live room. The page exposes focused WebMCP tools for status, logs, checks, hypotheses, rebuttals, mitigations, votes, and approval. Agents do the repetitive investigation while the room makes their reasoning visible to everyone. A server-enforced majority and a fresh human confirmation guard the final action.

The demo incident is a failing storefront API with a one-connection database pool. One log line contains a prompt-injection trap. It stays literal, is marked untrusted, and is never treated as an instruction by the application.

## Why WebMCP matters here

WebMCP is not an add-on to the demo; it is the product boundary. The same page engineers use is the surface their agents use. Thirteen imperative tools register after page load, work through one shared WebSocket, and return compact structured results. With no extension and no copied credentials, the agent can observe and coordinate inside the current room context.

## Key features

- Live multi-person room with evidence-backed hypotheses, rebuttals, and vote rationales
- Clear mitigation vote with active-member majority rules
- Human-only, server-derived confirmation with 60-second expiry
- Fixed server-side action library and protected target service
- Mutation replay protection and bounded request correlation
- Untrusted-output marking, 2 KB results, and text-only rendering
- Solo house responder for judges opening `?demo=1`, with no agent required to watch
- Self-resetting incident, so the public link is never spent by an earlier visitor
- Visible service recovery shared across every connected browser

## Architecture

The static TypeScript/Vite client registers the WebMCP surface and renders the room. A Cloudflare Worker routes each room to one Durable Object, which owns presence, boards, votes, approvals, idempotency, and broadcasts. A second Worker hosts the deterministic storefront fault and accepts only three known actions. Room and target mutations use a separate bearer secret.

## How Codex was used

Codex helped turn the initial specification into frozen shared contracts, then built the room, target, tool layer, UI, and tests in parallel lanes. Separate review passes challenged contract contradictions, commander authorization, origin handling, request replay, recovery timing, malformed server data, test discovery, and validation drift. The final suite was kept strict; a real ten-second recovery race was fixed in the product instead of weakening the assertion.

## Testing

Run `npm test`. The command checks TypeScript and 73 automated behaviors: 47 unit tests across the UI, WebMCP client, room, and target, then 26 Chromium journeys. A further 32 checks run against the real Workers via `tools/live-acceptance.mjs`. The browser suite uses isolated contexts and covers real-time propagation, injection-safe rendering, vote and approval gates, expiry, single-use replay, room isolation, self-serve commander, demo mode, and recovery in every tab.

## Judging fit

**WebMCP leverage:** the page exposes the complete incident workflow through native, focused tools rather than wrapping a generic API.

**Execution:** frozen contracts, runtime validation, deterministic target behavior, replay protection, browser tests, and fail-closed deployment settings make the demo repeatable.

**Potential impact:** the same pattern can make collaborative operational work visible and human-accountable without giving agents open-ended infrastructure access.

**Creativity and ambition:** multiple agents can disagree in one shared page, while a prompt-injection trap and human approval gate make safety observable rather than a slide-deck claim.

## Links

- Public demo: <https://multicom-web.pages.dev/> (lobby; `?demo=1` for the curated room)
- Room Worker health: <https://multicom-room.multicom-target.workers.dev/health>
- Target Worker health: <https://multicom-storefront-api.multicom-target.workers.dev/health>
- Public repository: <https://github.com/Hotragn/multicom>
- Demo video: **TODO — record from the [DEMO.md](DEMO.md) storyboard, then upload the under-three-minute cut**

## Screenshots

Captured from the real interface by `npm run capture:screenshots`, which drives the
production UI through the room protocol. Files live in `docs/screenshots/`.

| Order | File | Shows |
| --- | --- | --- |
| 1 | `01-lobby.png` | The landing page: start your own isolated incident, or watch the curated demo |
| 2 | `02-war-room.png` | The war room in a critical state, with two participants and the error-rate gauge |
| 3 | `03-ways-in.png` | The three ways to take part, for a judge with or without an agent |
| 4 | `04-investigation.png` | The reasoning chain: theory, cited evidence, rebuttal, and the fix beneath it |
| 5 | `05-commander-approval.png` | The approval overlay naming the server-derived action, blast radius, and who voted why |
| 6 | `06-manual-controls.png` | Driving the incident by hand, through the same room messages an agent sends |
| 7 | `07-judge-console.png` | A filled rubric with the evidence behind each row, and the run summary |
| 8 | `08-resolved.png` | The resolved room: 1% errors, stopped timer, the whole interface cooled to green |
| 9 | `09-untrusted-literal.png` | The injection-trap log line rendered as literal text |
| 10 | `10-mobile.png` | The room at 390 px, where the layout becomes tabbed rather than stacked |
| 11 | `11-vote-rationale.png` | A stated reason attached to a vote, so an objection is more than a bare no |

Two more are evidence rather than walkthrough steps, so they sit outside the
numbered sequence and each regenerates from its own tool:

| File | What it evidences | Regenerate with |
| --- | --- | --- |
| `evidence-live-production.png` | The deployed site, photographed live, with a real fault on screen | `node tools/capture-production.mjs` |
| `evidence-real-chrome.png` | The deployed room in Chrome with native WebMCP enabled | `npm run webmcp:chrome` |

Both were previously numbered `09-` and `11-`, which collided with walkthrough
shots and made the set look like it had two ninths. They are also the two files
that go stale silently: a screenshot captioned "the deployed build" keeps making
that claim after the next deploy, which is why each now has a command that
recaptures it rather than being taken by hand.

The thirteen-tool surface is evidenced by `docs/webmcp-chrome-report.json`
rather than a screenshot of a client menu: it records the tool names, the
longest description, and the polyfill-versus-native A/B, and it regenerates
from `tools/chrome-webmcp-check.mjs`.

## Known limitations

This challenge build ships one scripted incident and no account system. A disconnected browser rejoins as a new member, and inactive votes are excluded from current tallies.

Two limitations from the earlier build are now fixed rather than documented. The scripted fault is no longer one global state: each room gets its own scenario object, so resolving one room leaves every other room's incident untouched. And commander access no longer needs a shared capability link: a room the lobby provisions seats its first claimer, so anyone can demonstrate the human approval gate. The curated demo room still uses a capability, and that capability still travels in a query string — see `docs/SECURITY.md` for why that is acceptable for one room and what would replace it.

## Readiness

- [x] Functional project and automated test suite (73 checks)
- [x] MIT license and public repository remote
- [x] Professional README, security notes, and demo plan
- [x] Live Cloudflare Workers (health endpoints and production WebSocket verified)
- [x] Hosted frontend URL
- [x] Live browser acceptance pass (room connection live; 13 WebMCP tools visible)
- [x] Live cold-open pass (demo link shows the incident with no agent attached)
- [x] `apply_mitigation` verified end to end against real Workers: all 32 checks pass, ending in a
      real approval click with no secret, an apply against the live target, recovery in three
      browsers, and proof a bystander room is untouched
- [x] Several judges at once: rooms are isolated per tenant, and three run concurrently in the suite
- [x] A judge with no WebMCP browser can still run the whole loop, by hand or via the scripted drill
- [x] Deployed to production (room `c6686ced`, target `f70f44ab`, Pages `index-DKQrjK_5.js`): smoke 9/9, live acceptance 32/32, multi-agent drill all green, 13 tools native in Chrome
- [x] Real-agent drill: both agents diagnosed unaided and refused the injected instruction
- [x] Interface screenshots captured and indexed, regenerated against the shipped interface
- [x] Final Devpost field copy written (307 words across four fields, each well under the 300-word per-field limit), covering the per-judge isolation and the lobby
- [x] Real WebMCP client verified: 13 tools register natively in Chrome 152 behind `enable-webmcp-testing`, with a polyfill-fallback control
- [ ] Public YouTube demo with audio — storyboard rewritten for the judge path in [DEMO.md](DEMO.md); needs recording
- [ ] Devpost project page filled in and verified from a logged-out browser
