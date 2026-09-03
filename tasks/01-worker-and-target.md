Read AGENTS.md and SPEC.md first. Stay in your lane. Small timestamped commits.

Read SPEC.md §§3, 6, 8, 10, 11. Build `worker/` (room Worker + Durable
Object, WebSocket protocol §10 exactly, rules §8 exactly, house bot §13 as
a server-side client using the same messages) and `target/` (storefront-api
Worker with the §3 fault library, admin arm switch, synthetic logs
including the §4 trap line, and the three action-library handlers).
Use types from `shared/`. Include wrangler.toml files. Prove two WS clients
see each other's events and that scale_pool flips target health within 10s.
