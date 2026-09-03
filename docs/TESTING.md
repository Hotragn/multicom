# Testing multicom

The quality gate is one command:

```bash
npm test
```

It runs in this order and stops on the first failure:

1. TypeScript across five projects — the web app, the WebMCP layer, the room
   Worker, the target Worker, and the browser harness.
2. 46 unit tests: UI formatting; WebMCP definitions, output envelopes,
   validation, budget, registration, correlation and malformed messages; room
   voting and protocol parsing; room tenancy and target-request headers; target
   scenario maths and tenant routing.
3. 25 Chromium acceptance journeys.

71 automated checks in total, plus 32 against real Workers and 34 in the
multi-agent drill.

## Browser coverage

| Behaviour | Automated proof |
| --- | --- |
| Exact WebMCP surface | 12 tools, bounded descriptions, annotations, published output schemas, no iframe |
| Real-time room | Hypothesis reaches a second browser context in under 300 ms |
| Untrusted logs | Injection trap stays literal and below 2 KB |
| Safe rendering | Hostile `<img onerror>` text creates no image and runs no script |
| Decision gate | Non-passed, unapproved, invented, expired and replayed actions fail safely |
| **Agent cannot self-approve** | An agent holding the commander seat, with no human in the room, cannot produce an approval through any of the twelve tools; only a click on Approve moves the gate |
| Recovery | `scale_pool:default` reaches <2% errors and resolved state in both tabs within 10 seconds |
| **Room isolation** | Resolving one room leaves another room at 23% and not resolved, then that room still runs its own incident to recovery |
| **Concurrent judges** | Three rooms live at once, each completing independently, none seeing another's board |
| **Self-serve commander** | A provisioned room seats its first claimer with no secret; a second claim is refused `commander_taken`; the curated room still demands the capability; no query string can make a curated room self-serve |
| **Provisioning** | The lobby mints ids matching `/^r[a-z2-7]{20}$/`, rate limiting returns 429 with a fallback, and `room_full` offers a one-click own room |
| **Manual operator path** | The whole incident driven by hand through the same messages, refused at every gate an agent hits, and locked when the room resolves |
| **Judge console** | No rubric row ticks without a triggering event; a filled rubric reaches 10/10 after a real run; the exported report contains no secret and no cross-room data |
| **Visualization** | WebGL is reached, and the room is fully workable with the 3D chunk blocked |
| **Reduced motion** | The quiet interface renders the same board |
| **Contrast** | Text on every key control is measured against its composited background and held to the WCAG AA floor |
| **Parameter documentation** | Every parameter of every tool carries prose, and `role`, `actionId`, `choice` and `mitigationId` are asserted to state the specific things two real agents needed and did not have |
| **No-commander deadlock** | A room of responders refuses approval with a message naming the remedy, and the deadlock is escapable by seating a commander |
| Demo mode | House responder joins within 3 seconds, proposes by 10 seconds, then counters weak evidence and is marked as the red herring |
| Spectating | A page that never joins gets live metrics — demo and self-serve alike — plus the house hypothesis on demo, three offered ways in, and no write access |
| Self-reset | A resolved demo room restarts for the next visitor, and the target re-arms a completed run on its own |
| Vote rationale | `explain_vote` refuses without a vote, reaches the other browser, renders hostile text literally, and replaces rather than accumulates |
| Limits | Commander capability, six-person capacity, five hypotheses, malformed and oversized messages |
| Idempotency | Replaying one mutation request ID creates one hypothesis |

## What the harness is, and what it is not

The Playwright suite drives an in-process HTTP/WebSocket shell so the suite is
deterministic. It imports the production protocol parser, the production vote
rules, the production target-request header builder, and the production target
scenario maths — and its scenario state lives in a registry keyed by the tenant
header, exactly as the target Worker keys it. That last detail is deliberate: a
scenario field per harness room would have passed the isolation test while
production stayed broken.

The harness is not the Worker. Two things it cannot prove, which is why the live
pass below exists: Cloudflare's own Durable Object routing, and the room
Worker's `POST /rooms` route with real CORS.

Bringing the judge console online exposed two places where the harness had
drifted from the room Worker, both now fixed and worth knowing about if you
extend it: it was omitting seven activity sentences the room writes, and it had
no `confirmation_pending` guard, so a duplicate approval request hung instead of
being refused.

## Against the real Workers

`npm test` drives the harness. To exercise the actual room Worker, both Durable
Object classes, and the target Worker, start the stack and run the scripted
end-to-end pass:

```bash
npm run dev
```

```bash
node tools/live-acceptance.mjs --app http://127.0.0.1:5173 --target http://127.0.0.1:8788
```

32 checks. It takes the judge's path by default: it opens the app, clicks
**Start my own incident**, and claims the commander seat with no secret at all,
so the approval and apply are no longer skippable. It ends in a real click on
the real overlay, an apply against the real target, recovery in three browsers,
a judge console whose rubric matches exactly the rows that run earned, and a
check that a bystander room still reads 23.0% while the worked room reads 1.0%.

The last five are fail-closed checks made straight against the Workers, because
a browser can only ever send an allowed origin: provisioning refuses a missing
and an unknown `Origin` and answers an allow-listed one with the exact CORS
header; the room refuses an unknown origin before it even looks at the upgrade;
and the target refuses a tenant header that is not a room id.

For a deployed build, pass `--app` and `--target`. From the repo root:

```bash
npm run verify:prod
```

`--room <id>` switches to a curated room, which needs the capability. In that
mode the token comes from `--commander`, then `.commander-token`, then
`COMMANDER_TOKEN`, and the tenant-isolation check is skipped because a curated
room shares one scenario by design. Without `--room` no token is read at all —
a `.commander-token` on disk must not silently change what is being tested.

### Verified against production, 2026-09-03 (afternoon)

Room Worker `29f046b8`, target `f70f44ab`, Pages serving `index-SQf37RBN.js`.
This is the multi-judge build plus spectator health, seat-derived agent copy, the
lobby session guide and the room invite strip. Everything below ran against
`https://multicom-web.pages.dev` and the deployed Workers, with no secret
supplied anywhere.

Record the **bundle hash**, not just the date. Three UI commits shipped after the
first afternoon deploy while these lines still named `index--7Sdm-Wg.js`, so the
recorded pass numbers were attached to a build that was no longer live. Read the
live hash before believing a row here:

```bash
curl -s https://multicom-web.pages.dev/ | grep -o 'index-[A-Za-z0-9_-]*\.js'
```

| Pass | Result |
| --- | --- |
| `npm run smoke:prod` | 9/9 — twelve tools, live `wss`, real fault metrics at 23%, `data-viz=webgl`, onboarding tiers, lobby at the bare URL, no console errors |
| `npm run verify:prod` | **32/32, no skips** — including the commander seat claimed with no capability, a real click on the real overlay, recovery in 7.2s, and a bystander room still at 23.0% |

The morning pass against room `77a76fa0` / target `01495519` is superseded by
this deploy. The drill (`34/34`) and Chrome WebMCP A/B still stand as surface
evidence; they were not re-run here so as not to spend the lobby budget twice.

The tenancy fix is what these establish that no harness could. In the
live-acceptance run the worked room recovered to **1.0%** while a bystander room
provisioned moments earlier still read **23.0%**; the drill repeated it with a
third room. Before this rework both rooms would have read 1.0%, because one
global scenario object served every room.

Two operational notes from the deploy, in [DEPLOY.md](DEPLOY.md): run the Pages
step from the repo root, and do not exercise the provisioning rate limit before
verifying — 30 test mints lock out `verify:prod` and `drill` for the rest of the
ten-minute window, because both provision through the lobby.

## The multi-agent drill

```bash
npm run drill
```

34 checks across six acts: a room provisioned through the lobby, three personas
joining, parallel investigation, a red herring proposed and rebutted, a vote
with a stated reason, a human approval, an apply, recovery in every browser, and
safety checks.

**The personas are scripted, not agents.** Each is a real browser context with
the real twelve tools registered, and every call goes through the real client and
the real room — but the script chooses what to call and writes the hypothesis
text. No language model reasons about anything. What this proves is that the
protocol, the gates and the interface hold up with several participants acting
concurrently. What it does not prove is that a model can work the incident from
the tool surface alone; that is what `AGENT-DRILL.md` is for, and it needs
re-running after any change to the twelve tool descriptions. Every result is asserted strictly against the envelope in
SPEC.md §10.1 — the first version of this script papered over the payload keys
with `??` chains and would have passed against a completely different shape.

```bash
npm run drill:local                              # against npm run dev
node tools/agent-drill.mjs --personas 5 --headed # watch it happen
node tools/agent-drill.mjs --room p1-storefront  # curated room, needs the token
```

For real language-model agents in the room rather than scripted personas, see
[AGENT-DRILL.md](AGENT-DRILL.md).

## Against a real WebMCP browser

Chrome exposes the API behind a flag. This drives the flags UI in a throwaway
profile, then checks what the deployed page actually registered into:

```bash
npm run webmcp:chrome
```

It runs an A/B, because "not the polyfill" only means something next to a
control: with `enable-webmcp-testing` on, the page registers 12 tools into the
browser's own surface; with a clean profile and the flag off, the same page
falls back to the MCP-B polyfill.

Two reports, because they attest to different builds. Each records its own
`target`, so neither can be mistaken for the other:

| File | Build | Result |
| --- | --- | --- |
| `docs/webmcp-chrome-report.json` | **deployed**, 2026-09-03 | 12 tools native; 20 of 20 documented parameters delivered; longest description 104 chars; polyfill fallback confirmed with the flag off |
| `docs/webmcp-chrome-report.deployed.json` | the deployed build *before* this rework | 12 tools native |

The report also records which optional fields a native client actually gets,
because two of them decide where documentation can live. `inputSchema` arrives
for all twelve — as a JSON *string*, which is worth knowing: reading it as an
object reports zero documented parameters and is how this probe first talked
itself into believing the descriptions were stripped. They are not; all 20
arrive intact. `outputSchema` arrives for none, because it is an MCP-B
extension the standard dictionary does not carry.

Re-run it after any deploy:

```bash
node tools/chrome-webmcp-check.mjs --url "https://multicom-web.pages.dev/?demo=1"
```

Worth knowing: Chrome's native surface is `document.modelContext`, and
`navigator.modelContext` stays `undefined`. The registration in
`web/tools/register.ts` checks `document` first for exactly this reason, so a
`navigator`-only feature detect would silently miss native support. The page
also records *which* surface it found, before the polyfill installs its own, and
reports that honestly in the onboarding panel and the judge console — after the
polyfill runs the two are indistinguishable.

## Cloudflare runtime note

Earlier builds of this project could not run Wrangler's local Worker runtime on
Windows ARM64. That is no longer true: with wrangler 4.128 and workerd
2026-08-31, `wrangler dev` serves both Workers on that host and
`wrangler deploy --dry-run` bundles them.

Two hazards when running the stack locally:

- `wrangler dev` can leave an orphan `workerd` child if its shell is killed. It
  keeps the port and serves requests with no `.dev.vars` loaded, so every auth
  check 403s and the room reports it as "the target did not respond".
- The room Worker's `wrangler.toml` pins `TARGET_ORIGIN` to localhost and now
  declares a second Durable Object class. Deploy only with
  `npm run deploy:production` from `worker/`, which carries `TARGET_ORIGIN` and
  `ALLOWED_ORIGINS`; a bare `wrangler deploy` drops both and every WebSocket
  then 503s.

## Screenshot capture

```bash
npm run capture:screenshots
```

A separate Playwright config against the same room protocol and web app the
acceptance suite uses, writing to `docs/screenshots/`. It is deliberately
outside `npm test` so the quality gate stays a pass/fail check. Each shot drives
the real interface: the lobby waits for the WebGL layer, the war-room shot waits
for the status cadence so the gauge has a real reading, and the judge-console
shot is taken after a complete run so the rubric is filled by events rather than
staged.

`evidence-live-production.png` and `evidence-real-chrome.png` sit outside the
numbered sequence: they evidence the deployed build and native Chrome
registration rather than being product shots. Each has a command, because a
screenshot captioned "the deployed build" goes on claiming that after the next
deploy:

```bash
node tools/capture-production.mjs
```

That one refuses to write a file unless the live page actually shows a fault, so
it cannot quietly capture a page that never connected.

## Manual browser checks

Check at 1440 px, 1024 px, and 390 px widths. Confirm keyboard focus, the skip
link, approval-overlay focus and Escape handling, reduced-motion behaviour,
forced-colors rendering, offline banner copy, long evidence wrapping, the phone
tab bar, and resolved-state contrast.
