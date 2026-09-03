# Visual system

The interface is intentionally calm and operational: high contrast, few colors, compact cards, and no decorative effects that compete with incident state.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| Background | `#0d1117` | Page canvas |
| Surface | `#151b23` | Panels and cards |
| Raised surface | `#1b2330` | Dialog and active controls |
| Primary text | `#f3f6fa` | Main labels and values |
| Muted text | `#a8b2bf` | Supporting detail |
| Accent | `#8fb3e8` | Brand and neutral emphasis |
| Critical | `#ff7878` | Active incident and rejection |
| Warning | `#e6b86a` | Awaiting decision |
| Resolved | `#62c99d` | Verified recovery |
| Focus | `#b8d6ff` | Keyboard focus ring |

Color never carries meaning alone. Text labels such as “Critical,” “Awaiting commander,” “Challenged,” and “Resolved” accompany state changes.

## Type and shape

- Interface: IBM Plex Sans with system sans-serif fallbacks.
- Operational values: IBM Plex Mono with system monospace fallbacks.
- Corners: one restrained 8 px radius.
- Surfaces: borders and tonal separation instead of large shadows or gradients.
- Motion: short state transitions only; reduced-motion preferences disable them.

## Icons

The project uses the regular-weight Phosphor set through one local WOFF2 asset. Icons are mapped centrally in `web/ui/icons.ts`; product code uses semantic names such as `hypothesis`, `mitigation`, `shield`, and `connectionOff`. Decorative icons are hidden from assistive technology, while adjacent text supplies the label.

No emoji, hand-drawn SVG duplicates, or mixed icon families appear in the interface.
