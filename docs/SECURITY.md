# Security model

multicom is a contained incident simulation. It must never become a general remote-control layer.

## Trust boundaries

- Browser agents and every string they produce are untrusted.
- Synthetic logs are untrusted evidence and may contain instruction-like text.
- The room Worker is the authority for membership, votes, confirmation, and allowed actions.
- The target Worker accepts only its three scripted actions and requires the room's bearer token.
- **A room is a tenant.** One room's incident cannot be read or changed from another room.
- The human commander is the only approval authority, and approval originates only from a click in the browser interface.

## Controls

**Room tenancy.** The room Worker stamps `X-Multicom-Tenant: <roomId>` on every target call. It is composed inside `targetFetch`, the single choke point both `targetGet` and `targetPost` go through, so no call site can omit it. The target Worker resolves that header to its own scenario Durable Object with `idFromName`, and validates it against `/^[A-Za-z0-9_-]{1,80}$/` first — the value becomes an object name, so it is checked rather than escaped. A malformed header is `400 invalid_tenant`; an absent one falls back to the original single-tenant name, which keeps `/health` and any pre-tenancy caller working.

Until September 2026 the target routed every request to one global object, so applying `scale_pool:default` in one room healed the service for every other room. That made concurrent evaluation impossible and is the reason this boundary exists.

**Commander access.** A client cannot become commander from `join.role` alone. Two models, chosen by the server:

- *Curated rooms* (`p1-storefront`, and any hand-written room name) require the `commander` WebSocket capability. In production a missing `COMMANDER_TOKEN` prevents commander access entirely.
- *Self-serve rooms* — the ones the lobby provisions — seat their first claimer with no secret. The server then grants that connection the capability by updating its own socket attachment. Every later claim still fails `commander_taken` while the seat is held.

`selfServe` is server state. It is persisted in the room's own storage when the lobby mints the room, and re-derived from the room id's shape if that storage is ever reclaimed. It is never read from a query string or a client message, so no parameter can turn the curated room into a self-serve one.

**The room id is the capability.** "No secret needed" describes what a judge has to be *given*, not the absence of a gate. A minted id is `r` plus 20 base32 characters — 100 bits — and the seat opens only for an id of that shape. A hand-typed name does not qualify: `?room=probe-1234` answers `commander_forbidden`. So possession of an unguessable id authorises the claim, exactly as a capability token would; the differences are that the server mints it on demand rather than an operator sharing one, it names a single empty room, and it is not reused across sessions. Guessing one would yield an isolated empty incident, and `commander_taken` still applies once the seat is held.

**Approval is a human click, not a seat.** Because an agent can hold the commander seat in its own room, the gate is deliberately narrower than "this session is the commander". An approval is written in exactly one place, `Room.confirm()`, reachable only from the `confirm` client message, which only the interface's Approve button sends. No tool on the twelve-tool surface can produce one: `request_human_confirm` asks and waits. `tests/multicom.spec.ts` asserts this by exercising all eleven other tools while a confirmation is pending and checking that `apply_mitigation` still returns `needs_human_confirm`.

**Manual operator controls.** The "Drive it myself" panel calls the same `RoomClient` methods the tools call, over the same WebSocket messages. It is not a privileged path and it skips no gate: join before write, majority vote, fresh human approval, server-owned action library, and the resolved-room lock all apply identically. A test drives the entire incident through those controls and asserts each refusal.

**Origin access.** Production WebSocket upgrades and room provisioning both fail with `503 server_not_configured` until `ALLOWED_ORIGINS` is set. Once set, an absent or unexpected `Origin` is rejected with 403, and CORS headers are returned only for an allow-listed origin.

**Action scope.** The action library is compiled into the shared contract and checked again by both Workers. Unknown actions never reach the target.

**Human confirmation.** A mitigation must pass first. The room builds the approval message from its own mitigation record and action summary. Approval is bound to that mitigation/action pair, expires after 60 seconds, and is consumed before the external action begins.

**Replay control.** Mutation request IDs are stored per member with an input fingerprint. An identical replay receives the recorded response; using the same ID for different input fails. Logs are bounded to 64 records per member.

**Untrusted output.** WebMCP results are capped under 2 KB. The browser validates nested room state, service state, diagnostic output, and confirmation fields before notifying the UI. Dynamic content uses `createTextNode` or `replaceChildren`; the codebase contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function` path.

The frozen WebMCP read-only hints describe the scripted target: reading logs and checks never changes that service. The room may still record an audit sentence for a tool call, and a qualifying diagnostic check can wake the demo house responder; this is deliberate room coordination behavior required by the scenario.

**Judge console.** The console is a view. It derives every rubric row from this room's state, the server-authored activity log, and what this page itself observed; it holds no server authority and never mutates the room. Rows that depend on seeing untrusted content or a refused replay only tick for the browser that saw them, which is why the requirement text says "in this browser" — the console reports observations, not hearsay.

Activity-log classifiers are anchored to the end of the sentence. Every entry is `${memberName} ${server text}` and member names are peer-authored, so an unanchored match could be forged by naming yourself after a server phrase. Anchoring makes that impossible, because the server always appends its own suffix after the name.

Exports carry no secret: the share link is rebuilt without the `commander` parameter, and a test asserts the downloaded report contains neither the token nor another room's id.

**Resource bounds.** Rooms accept six active members, five hypotheses, three mitigations, and bounded rebuttals/activity. Incoming WebSocket messages are capped at 8 KB. Rooms expire one hour after everyone leaves. Room provisioning is bounded at 30 rooms per address per ten minutes and 250 live self-serve rooms; at capacity the lobby returns the curated demo rather than an error, and a rate-limited caller gets `429` with a `retryAfterSeconds` and a fallback room.

## Deployment requirements

- Generate independent, high-entropy values for `TARGET_TOKEN`, `COMMANDER_TOKEN`, and `ADMIN_KEY`.
- Store them as Cloudflare secrets, never frontend build variables.
- Set `ALLOWED_ORIGINS` to exact HTTPS frontend origins; do not use a wildcard.
- Keep the target Worker limited to synthetic data.
- Review Cloudflare logs without recording authorization headers or full commander URLs.

## Known boundaries

**The commander capability still travels in a query string for curated rooms.** `?commander=<token>` leaks through browser history, referrers, and any logging that records full URLs, and it is a long-lived shared secret rather than a scoped one. Self-serve rooms are the mitigation and the default: the judge path uses no secret at all, so the only remaining use of the query parameter is the one curated demo room. If curated rooms outlive this build, replace the parameter with a one-time exchange — POST the token, receive a short-lived capability bound to one room — rather than widening the current mechanism.

The capability link is authentication, not user identity. There are no accounts or role directory in this hackathon build. A disconnected client rejoins as a new member; inactive votes are excluded from current tallies. For a production system, replace capability links with short-lived, audience-bound sessions and an organization identity provider.

An agent that drives the browser's DOM directly, rather than the tool surface, can click Approve. That is outside this threat model: such an agent is acting as the human. The property defended here is that the *tool surface* cannot approve its own write.

To report a vulnerability, open a private security advisory on the repository rather than a public issue.
