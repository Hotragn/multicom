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
5. Seven Chromium acceptance journeys.

## Browser coverage

| Behavior | Automated proof |
| --- | --- |
| Exact WebMCP surface | 11 tools, bounded descriptions, annotations, no iframe |
| Real-time room | Hypothesis reaches a second browser context in under 300 ms |
| Untrusted logs | Injection trap stays literal and below 2 KB |
| Safe rendering | Hostile `<img onerror>` text creates no image and runs no script |
| Decision gate | Non-passed, unapproved, invented, expired, and replayed actions fail safely |
| Recovery | `scale_pool:default` reaches <2% errors and resolved state in both tabs within 10 seconds |
| Demo mode | House responder joins within 3 seconds, proposes by 10 seconds, then counters weak evidence |
| Limits | Commander capability, six-person capacity, five hypotheses, malformed/oversized messages |
| Idempotency | Replaying one mutation request ID creates one hypothesis |

The Playwright harness imports the production protocol parser, vote rules, and target scenario calculations. It supplies an in-process HTTP/WebSocket shell so the suite remains deterministic.

## Cloudflare runtime note

Cloudflare does not currently ship the `workerd` binary used by Wrangler local development for Windows on ARM64. On that host, unit and Chromium acceptance checks run, but `wrangler dev` and `wrangler deploy --dry-run` cannot start. Run the final Worker integration and live acceptance pass on a supported Linux, macOS, Windows x64, or CI host.

This is a host-tooling limitation, not an ignored product test. A release is ready only after these live checks pass against the actual Workers:

- [ ] Target `/health` and room `/health` return 200.
- [ ] A responder cannot claim commander without the capability.
- [ ] Two separate browser sessions join the same room.
- [ ] The agent can call all 11 tools through the real browser WebMCP surface.
- [ ] A hypothesis appears in both sessions promptly.
- [ ] The injection-trap log stays literal.
- [ ] Apply fails before vote and approval.
- [ ] Commander approval names the server-derived action.
- [ ] `scale_pool:default` resolves every connected tab within 10 seconds.
- [ ] Reusing the consumed approval fails.
- [ ] The room remains usable after one browser reconnects.

## Verified live deployment

The current public build is hosted at <https://multicom-web.pages.dev/?demo=1>. The
room Worker is <https://multicom-room.multicom-target.workers.dev> and the
scripted target is <https://multicom-storefront-api.multicom-target.workers.dev>.
On September 3, 2026, both health endpoints returned 200, a production `wss://`
client joined a room, and the client browser reported `Room connection: Live`.
The public demo uses `?demo=1`; the commander capability is kept private for
the human approval step.

## Manual browser checks

Check at 1440 px, 1024 px, and 390 px widths. Confirm keyboard focus, the skip link, confirmation dialog focus, reduced-motion behavior, offline banner copy, long evidence wrapping, and resolved-state contrast.
