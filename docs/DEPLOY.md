# Configuration and deployment

## Configuration

| Setting | Used by | Purpose |
| --- | --- | --- |
| `VITE_ROOM_WS_URL` | web | Public origin of the room Worker. Also the origin the lobby posts to for provisioning. |
| `TARGET_ORIGIN` | room Worker | Public origin of the scripted target |
| `TARGET_TOKEN` | both Workers | Authorizes the room to apply a target action |
| `ALLOWED_ORIGINS` | room Worker | Comma-separated frontend origins allowed to connect or provision |
| `COMMANDER_TOKEN` | room Worker | Capability required to claim commander **in a curated room**. Self-serve rooms do not use it. |
| `ADMIN_KEY` | target Worker | Arms or resets the scripted fault |

Do not commit real values. Local `.env` and `.dev.vars` files are ignored.

Two independent secrets to generate, without printing them into a shell:

```bash
node tools/set-target-token.mjs
```

```bash
node tools/set-commander-token.mjs
```

The commander rotation writes the new capability to `.commander-token`
(gitignored, owner-only) and invalidates the previous one — which breaks any
private commander link already handed out. Since self-serve rooms need no
capability at all, rotation is now only relevant to the one curated demo room.

A trailing newline inside a token ends up inside the `Authorization` header the
room sends, and the resulting failure looks like an unreachable service rather
than a bad secret. Use the scripts rather than piping a value through a shell.

## Deploy

Deployment is deliberately fail-closed: without `ALLOWED_ORIGINS` the room
Worker refuses both WebSocket upgrades and room provisioning with
`503 server_not_configured`.

1. Deploy `target/` and set `TARGET_TOKEN` and `ADMIN_KEY` as Cloudflare secrets.
2. On the room Worker set the deployed target URL as `TARGET_ORIGIN`, a matching
   `TARGET_TOKEN`, a strong `COMMANDER_TOKEN`, and the exact frontend origin in
   `ALLOWED_ORIGINS`.
3. Deploy `worker/`.
4. Build `web/` with `VITE_ROOM_WS_URL` set to the deployed room Worker origin.
5. Host `web/dist/`, then run the live acceptance pass.

```bash
cd target && npx wrangler deploy
```

```bash
cd worker && npm run deploy:production
```

```bash
npm run build --workspace=@multicom/web && npx wrangler pages deploy web/dist --project-name multicom-web --branch main
```

```bash
npm run verify:prod
```

### Two hazards, both load-bearing

**Never run a bare `wrangler deploy` in `worker/`.** Its `wrangler.toml` pins
`TARGET_ORIGIN` to localhost, so a plain deploy drops the live `TARGET_ORIGIN`
and `ALLOWED_ORIGINS` vars and every WebSocket then 503s. `npm run
deploy:production` carries both.

**The room Worker now declares two Durable Object classes.** `Room` and `Lobby`,
with migrations `v1` and `v2`. Applying a migration to a live Worker is one-way,
and the `Room` class holds live room state at the moment of deploy. Deploy when
no session is in progress.

## The deploy of 2026-09-03

Both Durable Object migrations are applied on the live room Worker. `v2` is
`new_sqlite_classes = ["Lobby"]` — purely additive, no `deleted_classes` and no
`renamed_classes` — so it created the new class and left every existing `Room`
untouched. What a migration makes irreversible is the recorded tag, not any
data. Old persisted rooms load unchanged because `roomId` and `selfServe` are
both optional with server-side fallbacks.

| Worker | Version | Bindings |
| --- | --- | --- |
| `multicom-storefront-api` | `f70f44ab-2676-4489-870a-e47e76275743` | `SCENARIO` |
| `multicom-room` | `c6686ced-4c7f-40eb-bd4c-60c80c6657a4` | `ROOMS`, `LOBBY`, `TARGET_ORIGIN`, `ALLOWED_ORIGINS` |

Deploying restarts isolates, so open WebSockets drop and reconnect with a new
member id. That is a blip, not data loss — but it does mean deploying mid-run
costs a judge their seat, so deploy when no session is in progress.

Two things learned deploying it:

- Run the Pages step **from the repo root**. `web/dist` is relative to the root,
  and running it from `worker/` fails with `ENOENT ... worker\web\dist` after
  the two Workers are already live.
- Don't exercise the provisioning rate limit and then try to verify. The budget
  is per address, so 30 test mints lock out `verify:prod` and `drill` — both
  provision through the lobby — for the rest of the ten-minute window.

## Verifying a deployment

Start with the read-only pass. It provisions nothing, so it costs no room
budget and can be run as often as you like:

```bash
npm run smoke:prod
```

Nine checks: thirteen tools registered, a live `wss` connection, real fault
metrics, the visualization mounted, the onboarding tiers, the lobby at the bare
URL, and no console errors.

Then the two that provision rooms. Both were green against this deploy —
32/32 and 34/34, results in [TESTING.md](TESTING.md#verified-against-production-2026-09-03).
Between them they cost about four rooms of the thirty-per-window budget.

```bash
npm run verify:prod
```

32 checks. It takes the judge's path — provisioning a room through the lobby and
claiming commander with no secret — so nothing is skipped for want of a
capability. `--room <id>` switches to a curated room and needs the token; see
[TESTING.md](TESTING.md).

```bash
npm run drill
```

```bash
npm run webmcp:chrome
```

The Chrome check drives the flags UI in a throwaway profile and runs an A/B on
native WebMCP versus the MCP-B polyfill, writing `docs/webmcp-chrome-report.json`.
