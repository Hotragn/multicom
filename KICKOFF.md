# KICKOFF.md — master prompt (run: codex "$(cat KICKOFF.md)")

You are the build manager for this repository. You own this project end to
end. Run every phase below, in order, without waiting for instructions
between phases. Work autonomously; when you hit something you cannot do,
record it in `BLOCKED.md` with what you tried, continue with all work that
does not depend on it, and surface every blocker in the final report.

First, read these files at the repo root and treat them as law:

1. `SPEC.md` — the product. If anything is ambiguous, the spec is right.
2. `AGENTS.md` — how work is done here: frozen contracts, directory lanes,
   quality gates, security rules.

If either file is missing or empty, stop and say so. Do not improvise a
product.

---

## Phase 1 — contracts

1. From SPEC.md sections 3, 9, 10, 11, generate:
   - `shared/ws-messages.ts` — every WebSocket message type
   - `shared/tools.ts` — all 10 tool names, params, and the action library
   - `shared/scenario.ts` — the fault library, the synthetic log set
     including the injection-trap line from SPEC.md section 4, and the
     action library identifiers
2. Types and constants only. No logic. No invented fields.
3. Commit as `contracts: freeze shared/`. These files are frozen from this
   moment. If a later phase believes a contract is wrong, do not edit it —
   note it in `BLOCKED.md` and continue with independent work.

## Phase 2 — task files

Create `tasks/01-worker-and-target.md`, `tasks/02-tool-layer.md`,
`tasks/03-ui.md`, `tasks/04-tests.md`, `tasks/05-docs.md` by copying the
five prompts from SPEC.md Appendix A verbatim, each prefixed with:
"Read AGENTS.md and SPEC.md first. Stay in your lane. Small timestamped
commits."

## Phase 3 — parallel build

Run three isolated sessions at once, using git worktrees so nothing
collides:

```bash
git worktree add .wt/worker -b build/worker
git worktree add .wt/tools  -b build/tools
git worktree add .wt/ui     -b build/ui
```

Launch one background session per worktree:

```bash
cd .wt/worker && codex exec --full-auto "$(cat ../../tasks/01-worker-and-target.md)"
cd .wt/tools  && codex exec --full-auto "$(cat ../../tasks/02-tool-layer.md)"
cd .wt/ui     && codex exec --full-auto "$(cat ../../tasks/03-ui.md)"
```

Rules for every session: obey AGENTS.md, never edit `shared/`, never edit
another module's directory, commit in small timestamped steps. When a
session finishes, run that module's isolated checks (`wrangler dev` smoke
test for worker/target, `vite build` for web) and push its branch.

Do not start Phase 4 until all three branches exist with passing isolated
checks.

## Phase 4 — integration

1. Merge in this order: `build/worker`, then `build/tools`, then `build/ui`.
   After each merge, run whatever exists of the test suite; fix integration
   breaks on a `fix/integration` branch before merging the next.
2. Run the tests task (`tasks/04-tests.md`) against merged main. It must
   produce a Playwright suite driving two browser contexts through one room
   — join, logs, hypothesis, counter, mitigation, vote, confirm, apply.
3. Iterate until `npm run test` is fully green. Never weaken a test to make
   it pass; fix the code.

## Phase 5 — review

1. Install gstack if absent:
   `git clone https://github.com/garrytan/gstack .gstack` — follow its
   README for Codex CLI.
2. Run its code review and security review over the tree, focused on
   `web/tools/` and `worker/`. Threat model: untrusted tool output, and the
   log-injection trap line must never be rendered as markup or executed.
3. Fix all findings on a `review-fixes` branch. Re-run the suite. Merge when
   green and clean.

## Phase 6 — acceptance

Automate every acceptance criterion in SPEC.md section 17 that can be
automated (criteria 1–7, 9). Run it. Record results in `VERIFY.md` —
criterion, pass/fail, evidence (command output or test name).

## Phase 7 — deploy

1. `wrangler deploy` for `worker/` and `target/`.
2. Write the production room-server URL into `web/.env.production` as
   `VITE_ROOM_WS_URL`. Commit.
3. Deploy `web/` to ChatGPT Sites: save a version tied to this commit,
   review the build, deploy, and confirm the production URL loads and
   registers exactly 10 tools. Leave the Sites audience open so the URL
   works without login.

## Phase 8 — docs and submission assets

Produce, committing each:

1. `README.md` — one-sentence pitch, run instructions, ChatGPT desktop test
   steps, the SPEC.md section 6 architecture diagram. Plain words.
2. `SUBMISSION.md` — Devpost text under 300 words answering the four
   required prompts from the challenge rules: why this fits WebMCP, how it
   improves UX, what people and agents can do together now that was hard
   before, how WebMCP was implemented. Lead with: "Every WebMCP demo is one
   agent on one page. multicom is many agents from many engineers on one
   page, fixing a live incident."
3. `LICENSE` — MIT.
4. `docs/demo-script.md` — narration script following SPEC.md section 18,
   including the injection-trap beat.
5. `docs/record-demo.mjs` — a Playwright script that drives two browser
   contexts through the full demo scenario against the deployed URL and
   records video.

## Phase 9 — final report

Write `REPORT.md`: what was built per module, test results, VERIFY.md
summary, deployed URLs, everything in BLOCKED.md, and anything you are
unsure about. Be honest. A known rough edge beats a hidden one.

Never fake a passing check, a deployed URL, or a green test. Finish every
phase you can.
