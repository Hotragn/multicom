# Security model

multicom is a contained incident simulation. It must never become a general remote-control layer.

## Trust boundaries

- Browser agents and every string they produce are untrusted.
- Synthetic logs are untrusted evidence and may contain instruction-like text.
- The room Worker is the authority for membership, votes, confirmation, and allowed actions.
- The target Worker accepts only its three scripted actions and requires the room's bearer token.
- The human commander is the only approval authority.

## Controls

**Commander access.** A client cannot become commander from `join.role` alone. The Worker validates the `commander` WebSocket capability. In production, a missing commander secret prevents commander access.

**Origin access.** Production WebSocket upgrades fail with `503 server_not_configured` until `ALLOWED_ORIGINS` is set. Once set, an absent or unexpected `Origin` is rejected.

**Action scope.** The action library is compiled into the frozen shared contract and checked again by both Workers. Unknown actions never reach the target.

**Human confirmation.** A mitigation must pass first. The room builds the approval message from its own mitigation record and action summary. Approval is bound to that mitigation/action pair, expires after 60 seconds, and is consumed before the external action begins.

**Replay control.** Mutation request IDs are stored per member with an input fingerprint. An identical replay receives the recorded response; using the same ID for different input fails. Logs are bounded to 64 records per member.

**Untrusted output.** WebMCP results are capped under 2 KB. The browser validates nested room state, service state, diagnostic output, and confirmation fields before notifying the UI. Dynamic content uses `createTextNode` or `replaceChildren`; the codebase contains no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function` path.

The frozen WebMCP read-only hints describe the scripted target: reading logs and checks never changes that service. The room may still record an audit sentence for a tool call, and a qualifying diagnostic check can wake the demo house responder; this is deliberate room coordination behavior required by the scenario.

**Resource bounds.** Rooms accept six active members, five hypotheses, three mitigations, and bounded rebuttals/activity. Incoming WebSocket messages are capped at 8 KB. Rooms expire one hour after everyone leaves.

## Deployment requirements

- Generate independent, high-entropy values for `TARGET_TOKEN`, `COMMANDER_TOKEN`, and `ADMIN_KEY`.
- Store them as Cloudflare secrets, never frontend build variables.
- Put only the commander capability in the private commander link.
- Set `ALLOWED_ORIGINS` to exact HTTPS frontend origins; do not use a wildcard.
- Rotate the commander capability if its link is shared with the wrong person.
- Keep the target Worker limited to synthetic data.
- Review Cloudflare logs without recording authorization headers or full commander URLs.

## Known boundaries

The capability link is authentication, not user identity. There are no accounts or role directory in this hackathon build. A disconnected client rejoins as a new member; inactive votes are excluded from current tallies. For a production system, replace capability links with short-lived, audience-bound sessions and an organization identity provider.

To report a vulnerability, open a private security advisory on the repository rather than a public issue.
