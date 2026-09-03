Read AGENTS.md and SPEC.md first. Stay in your lane. Small timestamped commits.

Read SPEC.md §§9, 14. Build `web/tools/`: register all 11 tools with a
feature-detect between `navigator.modelContext` and `document.modelContext`,
MCP-B polyfill, descriptions under 120 chars, `readOnlyHint` on 9.2–9.5,
untrusted marking on log results. Handlers speak `shared/ws-messages.ts`
only. `request_human_confirm` accepts a mitigation id and returns a Promise
resolving on the matching `confirm`. Do not touch `worker/`, `target/`, or
`web/ui/`.
