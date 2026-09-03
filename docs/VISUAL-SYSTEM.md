# Visual system

The interface is operational, not decorative: an on-call engineer should be able
to read the state of the incident from across a desk, and a judge should be able
to feel where it is without reading a label. Everything moves in service of one
question — is the service still broken, and what is the room doing about it?

## Layout

One page, four regions, in reading order.

| Region | Role |
| --- | --- |
| Topbar | Brand, room code, share, judge console toggle, connection state |
| Presence rail | Who is here, their role, and a pulse when they act |
| Hero | What this is, what phase the incident is in, and which tier you are driving |
| Dashboard | Service health: error-rate gauge, p99 timeline, pool, deploy, MTTR |
| Investigation | The reasoning chain, as a chain |
| Activity drawer | The transcript, collapsed by default |
| Manual controls | Real operator controls, revealed on request |
| Judge console | Rubric, run summary, exports; collapsed by default |

Desktop is a two-column grid: the dashboard and activity drawer on the left, the
investigation column on the right. Below 1080 px it becomes one column. Below
768 px it becomes three tabs — Status, Investigation, Actions — because stacking
five regions on a phone buries the thing you opened the page to see.

The investigation column is the product. A hypothesis is not a card in a list;
it is a thread that carries its cited evidence, each rebuttal, its vote tally,
the stated reasons behind those votes, and any mitigation proposed against it,
nested beneath it and connected by a rule. A flow strip above the column names
the eight stages — evidence, hypothesis, rebuttal, mitigation, vote, human
approval, applied, verified — and highlights where the room has actually reached.

## Phase temperature

Colour temperature and motion pace shift with the phase, so relief is something
you feel before you read it.

| Phase | Accent | Motion pace |
| --- | --- | --- |
| Triage | Critical red | Fastest |
| Diagnosing | Warning amber | Slower |
| Mitigating | Accent blue | Slower still |
| Resolved | Resolved green | Calmest |

Both are driven by two custom properties on the root element,
`--mc-phase-accent` and `--mc-phase-pace`, set from `data-room-phase`. Every
transition duration is a multiple of the pace, so the whole interface settles as
the incident does.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| Background | `#08090d` | Page canvas |
| Deep | `#05060a` | Inset evidence and log surfaces |
| Surface | `#12151c` | Panels |
| Raised surface | `#191e28` | Controls and the approval overlay |
| Subtle surface | `#0d1015` | Cards inside panels |
| Primary text | `#f4f6fa` | Values and labels |
| Muted text | `#a3adbb` | Supporting prose |
| Faint text | `#74808f` | Metadata and units |
| Accent | `#8fb3e8` | Neutral emphasis, mitigating phase |
| Critical | `#ff7a7a` | Live incident, refusal |
| Warning | `#ecb45f` | Awaiting a decision, untrusted content |
| Resolved | `#5fd39b` | Verified recovery |
| Focus | `#b8d6ff` | Keyboard focus ring |
| Person 1–6 | see `styles.css` | Six stable participant hues |

Participant colours are assigned by join order, so a person keeps their colour
for the whole incident. Colour never carries meaning alone: every state also
carries a text label — "Challenged", "Rejected", "Awaiting commander",
"Applied and verified", "Untrusted data".

## Type and shape

- Interface: IBM Plex Sans with system sans-serif fallbacks.
- Operational values: IBM Plex Mono — error rate, latency, timers, room codes,
  action ids. Anything you would read out loud to a colleague is monospaced.
- Corners: 10 px for cards, 16 px for panels and the overlay.
- Surfaces: borders and tonal separation, with one shadow in the whole system,
  under the approval overlay.

## The visualization layer

The hero carries a live graph of the room: the failing service at the centre,
one node per participant, spokes between them, pulsing when somebody joins,
votes, or applies a fix. It is tinted by the phase accent and agitated in
proportion to the error rate.

It renders twice over. A Canvas 2D field paints immediately, then a Three.js
scene lazily replaces it — `import("three")` keeps the 3D layer in its own
chunk, about 185 KB gzipped against 41 KB for the whole rest of the app, so the
page is interactive long before it arrives. Each renderer owns its own canvas,
because a canvas that has handed out a 2D context can never hand out a WebGL
one. If the chunk fails to load, if there is no WebGL, or if a renderer throws
mid-frame, the layer degrades to the 2D field or switches itself off, and the
room is unaffected. A test asserts both halves: that WebGL is reached, and that
the incident is fully workable with the chunk blocked.

Nothing in the visualization is load-bearing. It is hidden entirely under
`forced-colors: active`.

## Motion

- Short state transitions only, all scaled by `--mc-phase-pace`.
- One keyframe animation: the ring that flashes an avatar when its owner acts.
- The approval overlay's expiry ring drains in real time and turns critical at
  fifteen seconds.
- `prefers-reduced-motion: reduce` collapses every animation and transition to
  effectively zero, and the visualization stops animating entirely — it draws
  single frames on state change instead of running a frame loop.

## Icons

The project uses the regular-weight Phosphor set through one local WOFF2 asset.
`web/ui/phosphor.css` declares only the glyphs `web/ui/icons.ts` maps, so the
subset stays auditable, and product code uses semantic names such as
`hypothesis`, `approval`, `trap`, `judge`, and `connectionOff`. Decorative icons
are hidden from assistive technology; adjacent text supplies the label.

No emoji, hand-drawn SVG duplicates, or mixed icon families appear in the
interface.

## Accessibility

- A skip link jumps straight to the investigation column.
- The approval overlay is a real `<dialog>` with `showModal`, focus moved to
  Approve on open, focus trapped by the element itself, and Escape intercepted —
  cancelling a keypress must not read as a decision on a production write.
- Live regions: a polite announcer for room activity, `role="status"` on the
  connection banner and the manual-controls output, `role="alert"` on errors.
- Every control has an accessible name; counts and tallies carry `aria-label`
  with the full phrase rather than a bare number.
- Charts are `role="img"` with a `<title>` that states the current reading in
  words, so the gauge and the latency timeline are not silent to a screen reader.
- `forced-colors: active` maps every surface to system colours, drops the
  visualization, and uses `Highlight` for the current flow stage and primary
  actions.

## Rendering rules

All dynamic text is inserted as text nodes, through the helpers in
`web/ui/dom.ts`. There is no `innerHTML` anywhere in the interface, and a test
greps the source to keep it that way. This is a security property, not a style
preference: log lines, hypothesis titles, evidence, rebuttals, vote rationales,
and member names are all peer-authored, and the planted prompt-injection line
has to render as the plain text it is.
