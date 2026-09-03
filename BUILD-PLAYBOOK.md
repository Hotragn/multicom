# multicom — build playbook (Codex orchestration)

How to run this build with parallel Codex sessions, gstack skills, and
ChatGPT Sites hosting. No clocks anywhere — each phase ends at its gate,
not at a timer.

You need: your repo (private until submission, then public), the files from
this folder (`SPEC.md`, `AGENTS.md`, this playbook) committed at the root,
Codex CLI, Claude Code (for gstack skills), and the ChatGPT desktop app.

---

## Phase 0 — setup (you, by hand)

Gate: repo builds empty and contracts exist.

1. Create the repo. Commit `SPEC.md`, `AGENTS.md`, this file.
2. Generate the frozen contracts from the spec (Claude Code, interactive):
   > Read SPEC.md sections 9, 10, 11, and 3. Produce `shared/ws-messages.ts`,
   > `shared/tools.ts`, and `shared/scenario.ts`. Types and constants only —
   > no logic. `scenario.ts` must include the fault library, the synthetic
   > log set with the injection trap line from section 4, and the action
   > library. Do not invent fields beyond the spec.
3. Read the three files yourself. Fix anything that drifts from the spec.
   Commit. These are now frozen.
4. Install gstack locally (skills live in the repo, available to Codex CLI
   and Claude Code):
   `git clone https://github.com/garrytan/gstack .gstack && .gstack/install`
   Verify the skills appear as slash commands.
5. Spike check (you, not an agent): open the ChatGPT desktop app, confirm a
   single `registerTool` on a test page is visible to the agent with a
   GPT-5.6 Sol/Terra model selected. If this fails, stop and solve this
   first — everything else depends on it.

## Phase 1 — parallel build (Codex, three sessions at once)

Pattern: one git worktree per module, one background `codex exec` per
worktree. Worktrees isolate the agents so parallel writes never collide.

Paste this manager prompt into a Codex session at the repo root:

> You are the build manager for this repo. Read AGENTS.md and SPEC.md first.
> Create three git worktrees: `.wt/worker`, `.wt/tools`, `.wt/ui`, each on
> its own branch from main. Then launch one background `codex exec` session
> per worktree, passing the matching task prompt from this playbook's Task
> files (worker-and-target, tool-layer, ui). Each session must obey AGENTS.md:
> stay in its lane, never edit `shared/`, small timestamped commits.
> When a session finishes, run its module checks, then open a PR from that
> worktree branch. Report per session: what was built, what passed, what you
> are unsure about. Do not merge anything yourself.

Task files to feed each session (already in SPEC.md Appendix A — copy each
into its own file so sessions can be pointed at a path):

- `tasks/01-worker-and-target.md` → worktree `.wt/worker`
- `tasks/02-tool-layer.md` → worktree `.wt/tools`
- `tasks/03-ui.md` → worktree `.wt/ui`

Gate: three PRs open, each module passes its own isolated checks.

## Phase 2 — integration and review (gates, not guesses)

1. Merge PRs one at a time, starting with `worker`. After each merge, run
   the full suite.
2. Task 4 (tests) runs as a fourth Codex session against merged main — its
   prompt is in SPEC.md Appendix A. It writes the Playwright suite that
   drives two browser contexts through one room.
3. Run gstack review skills on the merged tree:
   - code review on everything
   - security review focused on `web/tools/` and `worker/` — the threat
     model is untrusted tool output and the log-injection trap
   - fix what it finds, in place, on a `review-fixes` branch
4. Run Gate 5 by hand: every acceptance criterion in SPEC.md section 17,
   live, in ChatGPT desktop. This one is yours, not an agent's.

Gate: full suite green, security review clean, all 10 criteria pass live.

## Phase 3 — deploy

Order matters: backend first, then the Sites frontend that points at it.

1. `cd worker && npx wrangler deploy` — record the room-server URL.
2. `cd target && npx wrangler deploy --env production` — record it too.
3. Put the room-server URL in `web/.env.production` as `VITE_ROOM_WS_URL`.
4. Commit and push. ChatGPT Sites ties builds to Git commits, so the commit
   must contain everything the frontend needs.
5. In the ChatGPT desktop app, open Sites, point it at this repo, and ask it
   to check the project for deployment compatibility, then save a version.
   Do not deploy yet.
6. Review the build in the Codex review pane — source changes, build status,
   access settings. Then deploy the saved version. Confirm the production
   URL loads and registers 10 tools.
7. Set the Sites audience so judges can open the link without login. Test
   the production URL in a fresh ChatGPT conversation: join, propose, vote.

Gate: the production URL passes criteria 6–8 from SPEC.md section 17.

## Phase 4 — video and submission (you, with agents drafting)

1. Task 5 session drafts `docs/SUBMISSION.md` — Devpost text under 300 words
   answering the four required prompts (WebMCP fit, better UX, what people
   and agents can do together now, implementation summary).
2. Record the video per SPEC.md section 18. Arm the fault first. Narrate the
   injection-trap beat. Under 3 minutes, your voice, no copyrighted music,
   uploaded publicly to YouTube.
3. Repo hygiene before submission: MIT LICENSE file, license visible in the
   GitHub About section, README final, commit history intact.
4. Submit on Devpost. Save a draft first; submit when the video link,
   live URL, and repo link all check out from a logged-out browser.

Gate: submitted, and the submission reads correctly to someone who has never
seen the project.

---

## If something breaks

- A Codex session drifts from its lane → kill it, delete the worktree,
  re-run the same task file on a fresh worktree. Cheap to restart.
- Two modules disagree about a contract → the contract is right; fix the
  module. If the contract is genuinely wrong, change it in one human-reviewed
  commit, then re-run dependent module checks.
- ChatGPT desktop can't see your tools → check registration timing (after
  load), feature-detect order, model selection (Sol/Terra), and that you are
  on the room page where registration happens.
- Playwright passes but the real agent fumbles a tool → the tool description
  is vague. Rewrite the description, not the handler.
