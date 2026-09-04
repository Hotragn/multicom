# Narration sheet

Read-aloud copy for the video. The picture comes from
`npm run record:walkthrough` (silent, 90 seconds, drives the deployed site).
Direction and rationale live in [DEMO.md](DEMO.md) — this file is only the
words, sized to the beats, for reading off a second screen while you record.

**Total spoken: ~1:38 with the cold open. Devpost cap is 3:00.**

---

### Cold open — 0:00–0:08 (NEW, record before the walkthrough starts)

A judge watching this has not read the README. The existing storyboard opens on
"One link", which assumes context. Eight seconds buys it.

> "Every WebMCP demo I've seen is one agent, on one page, working alone. This is
> several people and several browser agents on one page, fixing the same live
> production incident — and none of them can apply the fix without a human."

---

### 0:08–0:18 — One link, your own incident

> "One link. I get my own copy of a failing production service, and I am the
> commander. No secret, no setup, nobody else in my way."

### 0:18–0:28 — It is a room, not a page

> "Anyone I send this to lands on the same live board. The isolation is from
> other judges, not from my own team."

### 0:28–0:38 — Native agent access

> "The page exposes thirteen narrow tools to the browser itself. No copy-paste,
> no hidden backend integration."

### 0:38–0:52 — Evidence, and a theory under attack

> "Logs come back marked untrusted, and render only as text. The agents use the
> evidence and never follow the instruction planted inside it. And here one
> agent tells another that its theory doesn't fit the timeline."

### 0:52–1:04 — The mind changes *(the most important shot — do not rush)*

> "The author doesn't delete the theory, or quietly drop it. They move their own
> number, in front of everyone, and say what moved them. Only the author can.
> Anyone else has to argue."

**Hold on the struck-through number. Let it sit. Silence is fine here.**

### 1:04–1:20 — The gate

> "Agents can argue, revise, vote, and ask. Not one of the thirteen tools can
> produce this approval. It takes my click."

**Then click Approve.**

### 1:20–1:30 — Verify

> "The room re-reads the service after the write. Every connected window
> resolves together."

### 1:30–1:38 — Close

> "Every row is backed by a logged event, and it exports. multicom: a
> multiplayer incident room built directly on WebMCP."

---

## Recording order

1. Mint a fresh room from the lobby first. Do not reuse one, and do not use
   `?demo=1` for the main take.
2. `npm run record:walkthrough` → `docs/demo/walkthrough.webm`. It applies a
   real mitigation in a real room, so expect that room to end resolved.
3. Record narration over the silent take. Reading while watching is far easier
   than performing clicks and words at once.
4. Cut under 3:00, upload public to YouTube, put the link in
   `docs/SUBMISSION.md` where the TODO is.

## Do not say

Carried over from DEMO.md because these are easy to say by accident:

- **Not** "the scripted fault is one global state." It is one scenario object
  per room now, and the old phrasing undercuts the whole multi-judge point.
- **Not** that agents are autonomous through the approval. They are stopped at
  it, deliberately, and that is the strongest thing in the demo.
- **Not** that an agent "admits it was wrong." It revised a stated confidence.
  Smaller claim, and true.
- **Not** a specific theory count. Read what is on the board.
