# multicom

**A multiplayer incident room where engineers and their browser agents investigate together, challenge weak theories, vote on a fix, and leave the final production action to a human commander.**

multicom turns a web page into a shared operating surface. Each participant opens the same room. Their agent gets eleven focused WebMCP tools for reading evidence and updating the room. Everyone sees the same hypotheses, rebuttals, votes, and service health in real time.

The included incident is deterministic: `storefront-api` is failing because its database connection pool was reduced to one. A synthetic log line contains a prompt-injection trap. Good agents must treat that line as evidence, not instruction.

## What works

- Real-time rooms backed by a Cloudflare Durable Object
- Exactly 11 imperative WebMCP tools, with MCP-B fallback support
- Evidence, hypothesis, rebuttal, mitigation, and voting workflow
- Server-owned action allowlist; agents cannot invent production writes
- Majority vote plus a fresh, one-use human approval before any action
- Commander capability and fail-closed production origin checks
- Scripted target service with visible recovery in every connected tab
- Solo `?demo=1` mode with a house responder that argues, then concedes
- Read-only spectating, so opening the link with no agent still shows the live incident
- Literal rendering of all untrusted text; no HTML injection sinks
- 35 automated checks, including eight two-context Chromium journeys

## What it looks like

Opening the demo link with no agent attached shows the live incident, the house
responder's first theory, and how to take part.

![The room as a visitor first sees it, with a watching notice and the house responder's hypothesis](docs/screenshots/08-judge-cold-open.png)

Once agents join, the room fills in around them.

![The storefront-api room in a critical state with two people joined](docs/screenshots/01-critical-room.png)

A mitigation has passed the vote, and the room asks the human commander to approve the
exact server-derived action. Agents cannot approve their own write.

![The commander approval dialog naming scale_pool:default with a 60-second expiry](docs/screenshots/03-commander-confirmation.png)

After the approved action is applied, every connected browser resolves together.

![The resolved room with a 1.0% error rate and a stopped MTTR timer](docs/screenshots/04-resolved-room.png)

The planted log line that tells agents to skip diagnosis stays literal, marked
untrusted, and unexecuted.

![The injection-trap log line rendered as plain text inside a hypothesis card](docs/screenshots/06-untrusted-text-literal.png)

The full set, including the second browser context and the 390 px layout, is in
[docs/screenshots/](docs/screenshots/). Regenerate it from the real interface with
`npm run capture:screenshots`.

## How it fits together

```mermaid
flowchart LR
  A[Responder page + agent] <-->|WebSocket| R[Room Worker\nDurable Object]
  B[Commander page + agent] <-->|WebSocket| R
  R -->|Read checks and logs| T[Scripted storefront-api]
  R -->|Approved allowlisted action| T
  B -->|Human approve or reject| R
```

The browser registers tools once, after page load. All tool requests travel over the same room WebSocket and carry a request ID. The room owns voting, approval, idempotency, and persistence. The target Worker owns only the scripted fault and three fixed actions.

## Run it locally

Requirements: Node.js 22 or newer, npm, and a platform supported by Cloudflare's local `workerd` runtime.

```bash
npm install
```

Copy the two example secret files and use the same `TARGET_TOKEN` value in both:

```text
target/.dev.vars.example  -> target/.dev.vars
worker/.dev.vars.example  -> worker/.dev.vars
```

Then start the target Worker, room Worker, and Vite app together:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173/?room=p1-storefront&demo=1&commander=YOUR_COMMANDER_TOKEN
```

Use the commander link only for the human who can approve a fix. Responder links omit the `commander` parameter. If `COMMANDER_TOKEN` is not set during loopback development, the local room permits one commander; deployed rooms never use that shortcut.

In a WebMCP-capable browser, ask the agent to join before using other tools. A useful first instruction is:

> Join this incident room as Priya, the commander. Inspect the service, gather evidence, challenge weak theories, and coordinate a safe fix. Ask me before anything is applied.

## Test it

```bash
npm test
```

That command fails fast through TypeScript, unit tests, protocol tests, and the isolated Chromium suite. The browser tests cover real-time propagation, hostile text, vote passage, human approval, expiry, replay protection, capacity limits, demo behavior, and recovery across two browser contexts.

Useful focused commands:

```bash
npm run typecheck
npm run test:unit
npm run test:e2e
npm run build --workspace=@multicom/web
```

See [docs/TESTING.md](docs/TESTING.md) for the coverage map and the local Cloudflare runtime note.

## Safety model

- Only action IDs in `shared/tools.ts` can reach the target.
- A mitigation must pass a majority of active members.
- The server derives approval text from the selected mitigation; agents cannot rewrite it.
- Approval expires after 60 seconds and is consumed before the target call.
- Reused mutation request IDs replay the prior result or fail if their input changed.
- Production rejects WebSockets unless `ALLOWED_ORIGINS` and `COMMANDER_TOKEN` are configured.
- Target mutations require a separate bearer token.
- Tool output is capped below 2 KB; nested server data is structurally validated in the browser.
- Dynamic page content is inserted only as text nodes.

Read [docs/SECURITY.md](docs/SECURITY.md) before deploying.

## Configuration

| Setting | Used by | Purpose |
| --- | --- | --- |
| `VITE_ROOM_WS_URL` | web | Public origin of the room Worker |
| `TARGET_ORIGIN` | room Worker | Public origin of the scripted target |
| `TARGET_TOKEN` | both Workers | Authorizes the room to apply a target action |
| `ALLOWED_ORIGINS` | room Worker | Comma-separated frontend origins allowed to connect |
| `COMMANDER_TOKEN` | room Worker | Capability required to claim commander |
| `ADMIN_KEY` | target Worker | Arms or resets the scripted fault |

Do not commit real values. Local `.env` and `.dev.vars` files are ignored.

## Deploy

Deployment is deliberately fail-closed. Do not publish until the live acceptance pass is green.

1. Deploy `target/` and set `TARGET_TOKEN` and `ADMIN_KEY` as Cloudflare secrets.
2. Set the deployed target URL in the room Worker's `TARGET_ORIGIN`; set matching `TARGET_TOKEN`, a strong `COMMANDER_TOKEN`, and the exact frontend origin in `ALLOWED_ORIGINS`.
3. Deploy `worker/`.
4. Build `web/` with `VITE_ROOM_WS_URL` set to the deployed room Worker origin.
5. Host `web/dist/`, open responder and commander links, then run the live checklist in [docs/TESTING.md](docs/TESTING.md).

Verified deployment (September 3, 2026):

- Public demo: <https://multicom-web.pages.dev/?demo=1>
- Room Worker health: <https://multicom-room.multicom-target.workers.dev/health>
- Target Worker health: <https://multicom-storefront-api.multicom-target.workers.dev/health>

The commander capability is intentionally not published. Use the private commander link from the deployment session for the human approval step.

## Project map

```text
shared/     frozen messages, tool names, and scenario
worker/     room Worker, Durable Object, voting, approval, house bot
target/     scripted storefront service and fault state
web/tools/  WebMCP registration, validation, and WebSocket client
web/ui/     room interface, icons, theme, and confirmation dialog
tests/      Chromium acceptance suite and deterministic protocol harness
docs/       testing, security, visual system, demo, and Devpost draft
```

The implementation contract is [SPEC.md](SPEC.md). The visual system is documented in [docs/VISUAL-SYSTEM.md](docs/VISUAL-SYSTEM.md).

## License

[MIT](LICENSE) © 2026 Hotragn Pettugani.
