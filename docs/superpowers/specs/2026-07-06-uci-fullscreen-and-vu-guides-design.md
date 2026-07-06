# UCI: Fullscreen Toggle + VU Meter dB Guides

## Context

The FOH UCI (`assets/uci/foh-uci.html`) is a browser-served mixer control surface, sometimes run on a touchscreen. Two gaps:
1. No way to go fullscreen for touchscreen kiosk use.
2. VU meters show live level but no dB reference — hard to judge how loud a signal actually is.

## 1. Fullscreen toggle

- Icon button added to the top nav bar (alongside INPUTS / BUSES / OUTPUTS / ROUTING / PATCH), far right, always visible regardless of active tab.
- Uses the real Fullscreen API: `document.documentElement.requestFullscreen()` to enter, `document.exitFullscreen()` to exit. Includes the `webkit`-prefixed fallback for Safari/iPad.
- Button icon/state syncs via the `fullscreenchange` event, so it reflects reality even if the user exits via Esc rather than the button.

## 2. VU meter dB guides

Reference scale is the existing `VU_MIN_DB` (-60) to `VU_MAX_DB` (+10), same as segment coloring already uses (`VU_MID_DB` -6 amber, `VU_CLIP_DB` 0 red).

Split by context, based on available width (validated with an at-scale mockup):

- **Input / Bus / Output strips** (10px-wide meters): tick lines at 0 / -6 / -20 / -40 dB. Only "0" gets a text label, colored to match the clip threshold. Ticks are static (position computed once from the dB scale), independent of the live-updating segment colors.
- **Drawer "all meters" overview** (5px-wide meters, much denser): 0dB tick line only, no label, no other ticks — full treatment would be unreadable at that density.

Implementation approach: a shared helper computes tick position as a fraction of meter height from a dB value (mirrors the math `dbToSegments` already uses), so the same logic backs all four VU-meter instantiation sites (input strips, bus strips, output strips, drawer). Ticks are appended once when each meter is built, not re-created on every level update.

## Explicitly out of scope

- No changes to VU meter update/coloring logic — only the static tick overlay is new.
- No changes to fader behavior, mute, or any Q-Sys control routing.
- Fullscreen state is not persisted across reloads (browser default behavior).

## Open question resolved

User approved proceeding with implementation directly and tweaking visually against the running app rather than further upfront mockup iteration.
