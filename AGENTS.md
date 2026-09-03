# AGENTS.md — how to work on multicom

This file is read by every coding agent that opens this repository.
Follow it exactly. When this file and SPEC.md disagree, SPEC.md wins.

## What this project is

multicom is a multiplayer incident war room. Several engineers open the same
room in their own browsers; each engineer's AI agent joins through WebMCP
tools the page exposes. Agents gather evidence, argue about root cause, and
vote on a fix. A human commander approves the fix. Nothing is applied to the
target service without human approval.

Read SPEC.md at the repo root before writing any code.

## How we work — quality gates, not clocks

There are no time-boxes on tasks. Work is done when it passes its gate:

- Gate 1 — contracts exist: `shared/` is committed before any module work.
- Gate 2 — module works alone: the module's own checks pass in isolation.
- Gate 3 — module works together: the Playwright suite in `tests/` passes.
- Gate 4 — reviewed: a review pass (gstack review skill or a human) finds no
  correctness or security problems.
- Gate 5 — demo-able: the acceptance criteria in SPEC.md §17 pass live.

Do not mark work complete by description. Mark it complete by gate.

## Non-negotiables

1. `shared/` is frozen. It contains the WebSocket message types, the tool
   definitions, and the incident scenario. If you believe a contract must
   change, stop and flag it — do not edit.

   Amended once, with human review, on 2026-09-03, after a drill in which two
   real agents worked the incident from the tool surface alone (see
   `docs/AGENT-DRILL.md`). Three things the drill exposed: `error_timeline` sat
   on a different clock from the logs, `run_check` announced that the incident
   was scripted, and a bare `approved: false` could not distinguish a
   commander's refusal from nobody answering. The freeze still stands for
   everything else.

   Amended a second time, with written human authorization, on 2026-09-03, for
   the multi-judge rework recorded in `SPEC.md` §19:

   - `shared/tenancy.ts` is **new**. Room identity crosses three trust
     boundaries — the browser picks a room, the room Worker scopes its target
     calls to it, the target Worker keys its scenario by it — so the header
     name, the room-id pattern, and the minted-id shape need one source of
     truth. Purely additive; nothing existing changed.
   - `shared/tools.ts`: the twelve **description strings** changed, to state
     each tool's exact result envelope (`SPEC.md` §10.1). The payload key
     differs per result variant, and an agent that guessed wrong got
     `undefined` with no error. No tool name, input schema, action-library
     entry, or message type changed; there are still exactly 12 tools.

   Still frozen: `shared/ws-messages.ts` and `shared/scenario.ts`. The result
   union's shapes were deliberately left alone — renaming payload keys would
   have rippled through five workspaces and two scripts for a cosmetic gain.
2. Stay in your lane. Each task owns specific directories (see Repo map).
   Never edit another module's directory.
3. WebMCP imperative API only. Feature-detect `navigator.modelContext` and
   `document.modelContext`; use whichever exists; never throw when absent
   (load the MCP-B polyfill first).
4. Register tools once, after page load, on the room page. No iframes.
5. All dynamic text renders as text nodes. Never innerHTML. Log output is
   untrusted data — it is never executed, never rendered as markup.
6. The action library in `shared/scenario.ts` is the entire write surface.
   Tools must not invent writes to the target service.
7. Tool descriptions stay under 120 characters.
8. Commits are small, timestamped, and described plainly. The commit history
   is evidence this project was built during the challenge period.

## Repo map and ownership

```
shared/     frozen contracts (no agent edits)
worker/     Agent A — room Worker + Durable Object + house bot
target/     Agent A — storefront-api Worker + fault library
web/tools/  Agent B — WebMCP registration + handlers
web/ui/     Agent C — room page UI
tests/      Agent D — Playwright suite
docs/       Agent E — README, SUBMISSION.md
```

## Run and test

- Room server: `cd worker && npx wrangler dev`
- Target service: `cd target && npx wrangler dev --port 8788`
- Frontend: `cd web && npm run dev` (Vite)
- Full check: `npm run test` (Playwright, two browser contexts, one room)

## Deploy

Two parts, in this order:

1. Room server + target service → Cloudflare: `npx wrangler deploy` in each
   of `worker/` and `target/`. Record the worker URLs.
2. Frontend → ChatGPT Sites: Sites is managed hosting inside ChatGPT. It
   saves a build candidate tied to the Git commit, then deploys it and
   returns the production URL. The frontend must point at the deployed
   worker URL (set via `web/.env.production`). Sites cannot run the room
   server — it hosts the static client only; the client talks to Cloudflare
   over WebSocket.

Never deploy a version that has not passed Gate 5.

## gstack skills

This repo uses gstack (Garry Tan's skill pack) installed locally. Use:

- plan-review before starting a module (catches spec misreads early)
- code review on every diff before merge
- security review on `web/tools/` and `worker/` (OWASP pass — our threat
  model is untrusted tool output and prompt injection via logs)
- QA / browser skill to run Gate 5 acceptance checks in a real browser

If a skill and SPEC.md disagree, SPEC.md wins.
