# Testing multicom

The quality gate is one command:

```bash
npm test
```

It runs in this order and stops on the first failure:

1. TypeScript checks for the web app, WebMCP layer, room Worker, target Worker, and browser harness.
2. UI formatting tests.
3. WebMCP definition, validation, output-budget, registration, correlation, and malformed-message tests.
4. Room voting/protocol and target scenario tests.
5. Ten Chromium acceptance journeys.

## Browser coverage

| Behavior | Automated proof |
| --- | --- |
| Exact WebMCP surface | 12 tools, bounded descriptions, annotations, no iframe |
| Real-time room | Hypothesis reaches a second browser context in under 300 ms |
| Untrusted logs | Injection trap stays literal and below 2 KB |
| Safe rendering | Hostile `<img onerror>` text creates no image and runs no script |
| Decision gate | Non-passed, unapproved, invented, expired, and replayed actions fail safely |
| Recovery | `scale_pool:default` reaches <2% errors and resolved state in both tabs within 10 seconds |
| Demo mode | House responder joins within 3 seconds, proposes by 10 seconds, then counters weak evidence |
| Spectating | A page that never joins still gets live metrics, the house hypothesis, a watching notice, and no write access |
| Self-reset | A resolved demo room restarts for the next visitor, and the target re-arms a completed run on its own |
| Vote rationale | `explain_vote` refuses without a vote, reaches the other browser, renders hostile text literally, and replaces rather than accumulates |
| Limits | Commander capability, six-person capacity, five hypotheses, malformed/oversized messages |
| Idempotency | Replaying one mutation request ID creates one hypothesis |

The Playwright harness imports the production protocol parser, vote rules, and target scenario calculations. It supplies an in-process HTTP/WebSocket shell so the suite remains deterministic.

## Cloudflare runtime note

Earlier builds of this project could not run Wrangler's local Worker runtime on
Windows ARM64. That is no longer true: with wrangler 4.128 and workerd
2026-08-31, `wrangler dev` serves the target Worker and `wrangler deploy
--dry-run` bundles both Workers on that host. Local Worker integration no longer
has to move to another machine.

The automated suite still drives the deterministic in-process harness rather than
`wrangler dev`, so a release is ready only after these live checks pass against
the actual deployed Workers:

- [ ] Target `/health` and room `/health` return 200.
- [ ] Opening the demo link with no agent shows live metrics and the house responder.
- [ ] A responder cannot claim commander without the capability.
- [ ] Two separate browser sessions join the same room.
- [x] All 12 tools register into Chrome's native WebMCP surface (see `docs/webmcp-chrome-report.json`).
- [ ] An agent drives join, query, propose, vote and confirm through that surface with one instruction.
- [ ] A hypothesis appears in both sessions promptly.
- [ ] The injection-trap log stays literal.
- [ ] Apply fails before vote and approval.
- [ ] Commander approval names the server-derived action.
- [ ] `scale_pool:default` resolves every connected tab within 10 seconds.
- [ ] Reusing the consumed approval fails.
- [ ] Reopening the demo link after a completed run shows a live incident again.
- [ ] A rejected approval reports `reason: "rejected"`, a lapsed one `reason: "expired"`.
- [ ] The room remains usable after one browser reconnects.

## Verified live deployment

The current public build is hosted at <https://multicom-web.pages.dev/?demo=1>. The
room Worker is <https://multicom-room.multicom-target.workers.dev> and the
scripted target is <https://multicom-storefront-api.multicom-target.workers.dev>.

Verified against the deployed Workers on September 3, 2026:

- Both health endpoints return 200.
- A production `wss://` client joins and the browser reports `Room connection: Live`.
- `navigator.modelContext.getTools()` returns exactly 12 tools, longest description under 120 characters.
- Opening `?demo=1` with no agent shows live metrics, the house responder, and the watching notice.
- A stale demo room restarts on arrival: MTTR returned to 0:18 from 98:49.

Not yet verified live, and currently blocked: `apply_mitigation`. The room Worker
has no `TARGET_TOKEN`, so the target answers its action calls with 403. Set that
secret on the room Worker before running the checklist below.

## Against a real WebMCP browser

Chrome exposes the API behind a flag. This drives the flags UI in a throwaway
profile, then checks what the deployed page actually registered into:

```bash
node tools/chrome-webmcp-check.mjs
```

It runs an A/B, because "not the polyfill" only means something next to a
control: with `enable-webmcp-testing` on, the page registers 12 tools into the
browser's own surface; with a clean profile and the flag off, the same page
falls back to the MCP-B polyfill. Results land in
`docs/webmcp-chrome-report.json`.

Worth knowing: Chrome's native surface is `document.modelContext`, and
`navigator.modelContext` stays `undefined`. The registration in
`web/tools/register.ts` checks `document` first for exactly this reason, so a
`navigator`-only feature detect would silently miss native support.

## Against the real Workers

`npm test` drives a deterministic in-process harness. To exercise the actual room
Worker, Durable Object, and target Worker, start the stack and run the scripted
end-to-end pass:

```bash
node tools/live-acceptance.mjs --commander "$COMMANDER_TOKEN"
```

Eighteen checks, ending in a real click on the real approval dialog, an apply
against the real target, and recovery in all three connected browsers. It re-arms
the fault first so it is repeatable. Use `--app` and `--target` for a deployed
build.

For putting real agents in the room instead, see [AGENT-DRILL.md](AGENT-DRILL.md).

## Screenshot capture

```bash
npm run capture:screenshots
```

This runs a separate Playwright config against the same room protocol and web app the
acceptance suite uses, then writes the interface screenshots in `docs/screenshots/`. It
is deliberately outside `npm test` so the quality gate stays a pass/fail check.

## Manual browser checks

Check at 1440 px, 1024 px, and 390 px widths. Confirm keyboard focus, the skip link, confirmation dialog focus, reduced-motion behavior, offline banner copy, long evidence wrapping, and resolved-state contrast.
