# Devpost draft

This is working copy for the project page. Replace every `TODO` only with verified public links or recorded assets.

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

WebMCP is not an add-on to the demo; it is the product boundary. The same page engineers use is the surface their agents use. Eleven imperative tools register after page load, work through one shared WebSocket, and return compact structured results. With no extension and no copied credentials, the agent can observe and coordinate inside the current room context.

## Key features

- Live multi-person room with evidence-backed hypotheses and rebuttals
- Clear mitigation vote with active-member majority rules
- Human-only, server-derived confirmation with 60-second expiry
- Fixed server-side action library and protected target service
- Mutation replay protection and bounded request correlation
- Untrusted-output marking, 2 KB results, and text-only rendering
- Solo house responder for judges opening `?demo=1`
- Visible service recovery shared across every connected browser

## Architecture

The static TypeScript/Vite client registers the WebMCP surface and renders the room. A Cloudflare Worker routes each room to one Durable Object, which owns presence, boards, votes, approvals, idempotency, and broadcasts. A second Worker hosts the deterministic storefront fault and accepts only three known actions. Room and target mutations use a separate bearer secret.

## How Codex was used

Codex helped turn the initial specification into frozen shared contracts, then built the room, target, tool layer, UI, and tests in parallel lanes. Separate review passes challenged contract contradictions, commander authorization, origin handling, request replay, recovery timing, malformed server data, test discovery, and validation drift. The final suite was kept strict; a real ten-second recovery race was fixed in the product instead of weakening the assertion.

## Testing

Run `npm test`. The command checks TypeScript and 34 automated behaviors: two UI tests, 15 WebMCP/client tests, five room tests, five target tests, and seven Chromium journeys. The browser suite uses isolated contexts and covers real-time propagation, injection-safe rendering, vote and approval gates, expiry, single-use replay, room limits, demo mode, and recovery in every tab.

## Judging fit

**WebMCP leverage:** the page exposes the complete incident workflow through native, focused tools rather than wrapping a generic API.

**Execution:** frozen contracts, runtime validation, deterministic target behavior, replay protection, browser tests, and fail-closed deployment settings make the demo repeatable.

**Potential impact:** the same pattern can make collaborative operational work visible and human-accountable without giving agents open-ended infrastructure access.

**Creativity and ambition:** multiple agents can disagree in one shared page, while a prompt-injection trap and human approval gate make safety observable rather than a slide-deck claim.

## Links

- Public demo: <https://multicom-web.pages.dev/?demo=1> (solo demo mode)
- Room Worker health: <https://multicom-room.multicom-target.workers.dev/health>
- Target Worker health: <https://multicom-storefront-api.multicom-target.workers.dev/health>
- Public repository: <https://github.com/Hotragn/multicom>
- Demo video: **TODO — upload the verified under-three-minute cut**

## Screenshot shot list

1. Critical room with service metrics and two connected people.
2. Hypothesis plus evidence and a visible rebuttal.
3. Passed mitigation with commander confirmation dialog.
4. Resolved room with green status and stopped MTTR timer.
5. Browser WebMCP tool list showing all eleven tools.

## Known limitations

This challenge build ships one scripted incident, capability-link commander access, and no account system. A disconnected browser rejoins as a new member, while inactive votes are excluded. Windows ARM64 cannot run Wrangler's local Worker runtime; the deterministic Chromium harness remains available there, and the final live Worker pass must run on a supported host.

## Readiness

- [x] Functional project and automated test suite
- [x] MIT license and public repository remote
- [x] Professional README, security notes, and demo plan
- [x] Live Cloudflare Workers (health endpoints and production WebSocket verified)
- [x] Hosted frontend URL
- [x] Live browser acceptance pass (room connection live; 11 WebMCP tools visible)
- [ ] Screenshots
- [ ] Public YouTube demo with audio
- [ ] Final Devpost field copy and verified project page
