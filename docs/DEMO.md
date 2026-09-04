# 90-second demo

The story is the one a judge lives: **open a link, get your own incident, and
find you cannot approve the fix by yourself.** Everything else is supporting
detail.

## Before recording

- **Provision a fresh room from the lobby.** Open
  <https://multicom-web.pages.dev/> and click **Start my own incident**. Do not
  reuse a room, and do not use `?demo=1` for the main take — the curated room is
  shared with anyone else watching and its board may already be full.
- A newly minted room is armed by construction, so there is nothing to wait for.
  If you want to check, the room's own copy of the fault reads 23%:

  ```bash
  curl -s -H "X-Multicom-Tenant: <roomId>" \
    https://multicom-storefront-api.multicom-target.workers.dev/status
  ```

  Each room has its own scenario. Nothing another person does can heal yours,
  and finishing your run cannot spoil anyone else's — which is the point of
  §19 and worth one sentence of narration.
- Have two browser windows on the **same room link**: yours as commander, one
  more as a responder, copied from the room's invite strip. A second window is
  what makes this a room rather than a page.
- Plan who posts the flag theory. `revise_hypothesis` is author-only, so the
  0:44 beat has to be driven from the window that posted it — revising from the
  other one returns `not_author`. Posting the flag theory from the responder
  window and rebutting from the commander window reads best: the concession then
  comes from the agent, not from the person holding Approve.
- Keep the console closed, zoom at 100%, and record original narration plus
  system audio only.
- Target cut is 90 seconds; keep the finished video under three minutes.

## Recording the picture

The visual track can be produced from the storyboard rather than performed:

```bash
npm run record:walkthrough
```

That drives the whole journey against the deployed site and writes
`docs/demo/walkthrough.webm` — 1440x900, ninety seconds, every beat below
landing on its mark. It is **silent by design**: the narration is yours, and
recording voice over a clean take is easier than performing the clicks and the
words at once.

One window is filmed, the commander's. The second participant is driven in an
unrecorded context, so their hypotheses, rebuttal and revision arrive on the
filmed board exactly as a viewer would see them. `--app http://127.0.0.1:5173`
records against a local stack instead.

It applies a real mitigation in a real room, so run it against a room you have
just minted, and expect that room to end resolved.

## Storyboard

**0:00–0:10 — One link, your own incident**

Open the lobby. Click **Start my own incident**. Land in the room with the fault
already live. Say: “One link. I get my own copy of a failing production service,
and I am the commander — no secret, no setup, nobody else in my way.”

**0:10–0:20 — It is a room, not a page**

Copy the invite from the strip, open it in the second window, join as a
responder. Both windows update. Say: “Anyone I send this to lands on the same
live board. The isolation is from other judges, not from my own team.”

**0:20–0:30 — Native agent access**

Reveal the browser's registered WebMCP tools. Show `join_room` and
`get_service_status` being called. Say: “The page exposes thirteen narrow tools
to the browser itself. No copy-paste, no hidden backend integration.”

**0:30–0:44 — Evidence, and a theory under attack**

Query logs, run `pool_in_use`, let both windows fill. Point at the injection
line. Then the rebuttal: the timeline shows errors starting *before* the flag was
enabled. Say: “Logs come back marked untrusted and render only as text. The
agents use the evidence and never follow the instruction planted inside it. And
here one agent tells another its theory does not fit the timeline.”

**0:44–0:56 — The mind changes**

The single most important shot in the video. Hold on the flag card while its
author revises: **35%** struck through, **10%** beside it, and the author's
reason underneath. Say: “The author does not delete the theory or quietly drop
it. They move their own number, in front of everyone, and say what moved them.
Only the author can — anyone else has to argue.”

Do not rush this. Everything before it is setup; this is the beat that separates
a shared page from a room where people actually change their minds. Let the
struck-through number sit on screen.

**0:56–1:12 — The gate**

Propose `scale_pool:default`, vote from both windows, request confirmation. Hold
on the approval overlay: the action id, the blast radius, who voted and why, the
countdown. Say: “Agents can argue, revise, vote, and ask. Not one of the thirteen
tools can produce this approval. It takes my click.” Click **Approve**.

**1:12–1:22 — Verify**

Apply. Hold on the error rate falling until both windows turn green together.
Say: “The room re-reads the service after the write. Every connected window
resolves together.”

**1:22–1:30 — Close**

Open the judge console. Show the rubric filled from real events and the run
summary. Say: “Every row is backed by a logged event, and it exports. multicom:
a multiplayer incident room built directly on WebMCP.”

## Capture list

- The lobby, with both ways in
- A minted room code in the topbar, and the invite strip
- The same hypothesis landing in two windows
- The injection-trap line rendered as literal text
- The flag theory marked challenged next to the pool theory
- **The revised confidence: 35% struck through, 10% beside it, reason underneath**
- The approval overlay: action id, blast radius, voters, countdown
- Both windows resolved together at 1%
- The judge console rubric and run summary
- The browser tool list showing exactly 13 tools

## What not to claim

- **Not** “the scripted fault is one global state.” It was until the multi-judge
  rework; it is now one scenario object per room, and the old sentence undercuts
  the whole point.
- **Not** that agents are autonomous through the approval. They are stopped at
  it, deliberately, and that is the strongest thing in the demo.
- **Not** a specific number of theories on the board. The headline is derived
  from what is actually there.
- **Not** that an agent “admits it was wrong.” It revised a stated confidence,
  which is a smaller and truer claim, and the room shows both numbers so a
  viewer can judge the size of the move themselves.
