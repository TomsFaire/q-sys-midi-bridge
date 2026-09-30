# Bug Fix: Mute Targets Must Use Gain Blocks, Not Input.Mixer

**Date:** 2026-06-30  
**Severity:** High — mutes are hitting the wrong point in the signal chain  
**Status:** Action required — config change only, no code change needed

---

## The Bug

The `mute-alignment-handoff.md` doc recommended moving mute targets from `Mic.0N.Gain:mute` to `Input.Mixer:input.N.mute`. **That recommendation was wrong.** The config partially applied it: the toggle targets were updated to `Input.Mixer` but the `mute_leds` were not, leaving the two halves out of sync.

More importantly, the underlying architecture is wrong. Mutes must happen at the **gain block**, not the mixer input.

---

## Why Gain Blocks Are Correct

The signal chain per channel is:

```
Preamp/Trim → [Gain Block] → Effects → Mixer Input → Bus → Output
                    ↑
              mute happens here
```

- The gain block sits **before** effects. Muting here silences the source cleanly before it hits any processing.
- `Input.Mixer` is a routing and level block — it controls which buses a channel feeds. Muting there is downstream of effects, which is wrong for a live channel mute.
- The UCI large faders should also control gain block gain (not mixer faders) for the same reason — gain and mute belong together at the same block.
- **Output mutes are the only exception** — `Bus.Mixer:output.N.mute` is correct for muting a bus output.

---

## Current State of config.json

| Section | Current value | Correct value |
|---|---|---|
| Mute toggle targets (ch 1–4) | `Input.Mixer:input.1–4.mute` | `Mic.01–04.Gain:mute` |
| Mute toggle targets (ch 5–8) | `Input.Mixer:input.5–8.mute` | `Styb.Gain:mute`, `Sptfy.Gain:mute`, `ZoomRX.Gain:mute`, `Slides.Gain:mute` |
| `feedback.mute_leds` (ch 1–4) | `Mic.01–04.Gain:mute` | ✅ already correct |
| `feedback.mute_leds` (ch 5–8) | `Styb/Sptfy/ZoomRX/Slides.Gain:mute` | ✅ already correct |
| Output mutes | `Bus.Mixer:output.N.mute` | ✅ already correct |

Only the **toggle targets** need to change. The `mute_leds` were never updated and happen to be correct.

---

## Fix: Revert Toggle Targets to Gain Blocks

**Channels 1–4 (analog mics):**

```json
{ "label": "Mic 1 Mute", "midi": {"type": "note_on", "channel": 1, "number": 1},
  "qsys": {"type": "toggle", "component": "Mic.01.Gain", "control": "mute"} }

{ "label": "Mic 2 Mute", "midi": {"type": "note_on", "channel": 1, "number": 4},
  "qsys": {"type": "toggle", "component": "Mic.02.Gain", "control": "mute"} }

{ "label": "Mic 3 Mute", "midi": {"type": "note_on", "channel": 1, "number": 7},
  "qsys": {"type": "toggle", "component": "Mic.03.Gain", "control": "mute"} }

{ "label": "Mic 4 Mute", "midi": {"type": "note_on", "channel": 1, "number": 10},
  "qsys": {"type": "toggle", "component": "Mic.04.Gain", "control": "mute"} }
```

**Channels 5–8 (stereo sources):**

```json
{ "label": "Standby Mute", "midi": {"type": "note_on", "channel": 1, "number": 13},
  "qsys": {"type": "toggle", "component": "Styb.Gain", "control": "mute"} }

{ "label": "Spotify Mute", "midi": {"type": "note_on", "channel": 1, "number": 16},
  "qsys": {"type": "toggle", "component": "Sptfy.Gain", "control": "mute"} }

{ "label": "Zoom RX Mute", "midi": {"type": "note_on", "channel": 1, "number": 19},
  "qsys": {"type": "toggle", "component": "ZoomRX.Gain", "control": "mute"} }

{ "label": "Slides Mute", "midi": {"type": "note_on", "channel": 1, "number": 22},
  "qsys": {"type": "toggle", "component": "Slides.Gain", "control": "mute"} }
```

Note: the MIDI type is also being corrected here from `cc` to `note_on` — see `bugfix-mute-midi-type.md` for that issue.

---

## Files to Change

| File | Change |
|---|---|
| `config/config.json` | Revert mute toggle targets to gain block components |
| `~/Library/Application Support/midi-qsys-bridge/config.json` | Same — this is the live config |
| `docs/mute-alignment-handoff.md` | Note that the Input.Mixer recommendation was incorrect |
