# Mute Alignment Handoff

**Date:** 2026-06-30  
**Status:** Action required before next event — the FOH UCI faders and mutes are wired to the wrong point in the signal chain.

---

## Signal Chain Architecture

Every input path follows this order:

```
Analog/Dante/Flex input
    │
    ▼
[Preamp / Trim]          ← hardware gain / digital trim
    │
    ▼
[Gain Block]             ← Mic.0N.Gain, Styb.Gain, Sptfy.Gain, etc.
    │  ← MUTE LIVES HERE (pre-effects)
    ▼
[Effects: HPF → EQ → Comp → AFC → Gate]
    │
    ▼
[Input.Mixer]            ← routing matrix only (sends to buses via crosspoints)
    │
    ▼
[Bus processing] → [Bus.Mixer] → [Output processing] → [Output gain/mute]
```

**Rule:** Gain and mute belong at the gain block, before effects. The `Input.Mixer` is a routing matrix — its controls set crosspoint levels (how much of each input goes to each bus), not the channel's primary gain or mute.

Muting at the mixer input (`input.N.mute`) would silence the channel after it's already been through all processing, and it would leave the effects chain running on a hot signal. Muting at the gain block cuts cleanly before any processing touches it.

---

## What's Wrong

| Surface | Currently controls | Should control |
|---|---|---|
| **MIDI bridge** (mutes) | `Mic.0N.Gain:mute` ✅ | (no change needed) |
| **MIDI bridge** (LEDs) | `Mic.0N.Gain:mute` ✅ | (no change needed) |
| **FOH UCI** (input faders) | `Input.Mixer:input.N.gain` ❌ | `Mic.0N.Gain:gain` |
| **FOH UCI** (input mutes) | `Input.Mixer:input.N.mute` ❌ | `Mic.0N.Gain:mute` |

The bridge is correct. The UCI needs to change.

---

## UCI Fix: Input Faders and Mutes

In `foh-uci.html`, find where input channel faders and mute buttons send their QRC commands and update the component and control names.

### Input channels 1–8 (Mics)

| Channel | Gain component | Mute control |
|---|---|---|
| Mic 1 | `Mic.01.Gain` | `mute` |
| Mic 2 | `Mic.02.Gain` | `mute` |
| Mic 3 | `Mic.03.Gain` | `mute` |
| Mic 4 | `Mic.04.Gain` | `mute` |
| Mic 5 | `Mic.05.Gain` | `mute` |
| Mic 6 | `Mic.06.Gain` | `mute` |
| Mic 7 | `Mic.07.Gain` | `mute` |
| Mic 8 | `Mic.08.Gain` | `mute` |

Fader gain control name: `gain` on each component above.  
Fader dB range: confirm against the gain block's actual range in Q-SYS Designer (likely −∞ to +18 dB or similar — the `min`/`max` may differ from the mixer's input gain range of −100 to +10).

### Stereo sources (channels 9–12)

| Channel | Gain component | Mute control |
|---|---|---|
| STYB | `Styb.Gain` | `mute` |
| Spotify | `Sptfy.Gain` | `mute` |
| Zoom RX | `ZoomRX.Gain` | `mute` |
| Slides | `Slides.Gain` | `mute` |

### What stays on `Input.Mixer`

`Input.Mixer` controls remain correct for:
- **Crosspoint sends** — how much of each input feeds each bus (the sends faders in Sends mode)
- **Bus routing** — the routing grid in the Routing tab

Do not move these. The mixer's job is routing, not gain or mute.

---

## Trim Controls

"Trim" = the gain before the gain block — the preamp or digital input gain.

| Input type | Q-SYS component | Control |
|---|---|---|
| Analog inputs (Mics 1–8) | `Analog.Inputs` | `channel.N.gain` (preamp gain) |
| Flex inputs | Flex input component — verify in Designer |  |
| Dante inputs | Dante component — verify in Designer | (digital gain) |

The UCI Patch tab already has phantom power for `Analog.Inputs`. Trim controls could live there or inline in the channel strip. Not currently in the UCI — add if needed.

---

## Output Mutes

Output mutes are at the output gain/mute stage, which is the correct point for post-bus processing. These do not need to change.

| Output | Component | Mute control |
|---|---|---|
| Mains | `Mains.Gain` (or equivalent — verify name in Designer) | `mute` |
| Zoom TX | `ZoomTX.Gain` | `mute` |
| Rec | `Rec.Gain` | `mute` |

> **Verify:** The output component names in the current design may be `{Name}.Delay` or a combined gain+delay block. Check in Q-SYS Designer what component sits immediately before the physical output and has a `mute` control. The bridge currently targets `Bus.Mixer:output.N.mute` for the output mutes — verify this is the right point or whether it should also move to an output gain block.

---

## MIDImix LED Reference

Once the UCI is fixed, both surfaces target the same controls and the ChangeGroup AutoPoll sync loop works automatically.

### Physical LED inventory

| Button | MIDI note (ch1) | LED color | Notes |
|---|---|---|---|
| Mute 1–8 | 1, 4, 7, 10, 13, 16, 19, 22 | **Amber** | Linked to `Mic.0N.Gain:mute` — already working |
| Rec Arm 1–8 | 3, 6, 9, 12, 15, 18, 21, 24 | **Red** | Unassigned — candidate: phantom power |
| Bank L | 25 | Amber | Linked to output mute 1 |
| Bank R | 26 | Amber | Linked to output mute 2 |
| SOLO position | note 27 | (no LED) | Output mute 3 — no visual feedback |
| SOLO button | — | No LED | Firmware only, cannot be driven externally |
| SEND ALL | — | No LED | No LED hardware |

LED protocol: Note On velocity 127 = ON, Note On velocity 0 = OFF. Note Off (0x80) messages are ignored by the MIDImix. This is correctly implemented in `midi-io.ts`.

### Rec Arm buttons — recommended mapping

The 8 red Rec Arm LEDs are a natural fit for **phantom power** status (analog inputs 1–8):

```json
{ "label": "Phantom 1", "midi": {"type": "note_on", "channel": 1, "number": 3},
  "qsys": {"type": "toggle", "component": "Analog.Inputs", "control": "channel.1.phantom.power"} }
```

Add matching `feedback.mute_leds` entries (notes 3, 6, 9, 12, 15, 18, 21, 24) to sync the red LEDs with live phantom power state. Color coding becomes clear: amber = channel muted, red = phantom on.

---

## How Bidirectional Sync Works

```
UCI mutes Mic 1  →  Q-SYS sets Mic.01.Gain:mute = 1
                     ↓
                 ChangeGroup AutoPoll (50 ms) pushes update to bridge
                     ↓
                 Bridge handleNotification() sees new value
                     ↓
                 Bridge sends Note On ch1 note 1 vel=127 → MIDImix LED lights amber

MIDImix mute press  →  Bridge toggles Mic.01.Gain:mute
                         ↓
                     Bridge sends Note On immediately (no poll wait)
                         ↓
                     UCI sees mute active on next UCI refresh cycle
```

No code changes needed — the bridge already implements this. The only requirement is that both surfaces target the same Q-SYS control.

---

## Files to Change

| File | Change |
|---|---|
| `Q-SYS/General/foh-uci.html` | Input faders: `Input.Mixer:input.N.gain` → `Mic.0N.Gain:gain` |
| `Q-SYS/General/foh-uci.html` | Input mutes: `Input.Mixer:input.N.mute` → `Mic.0N.Gain:mute` |
| `Q-SYS/General/foh-uci.html` | Stereo source faders/mutes → `Styb.Gain`, `Sptfy.Gain`, `ZoomRX.Gain`, `Slides.Gain` |
| `config/config.json` | No change needed — bridge is already correct |
| `docs/mute-alignment-handoff.md` | Mark resolved when UCI changes are deployed |

The bridge config and LED sync require no changes. All work is in the UCI.
