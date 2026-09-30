# Bug Fix: Mute Buttons Mapped as CC, Should Be Note On

**Date:** 2026-06-30  
**Severity:** High — mute button presses are not being received  
**Status:** Action required — config change only, no code change needed

---

## The Bug

The 8 channel mute mappings in `config.json` use `"type": "cc"` with MIDI channel 1 and CC numbers 22–29. The MIDImix hardware sends **Note On** messages for its mute buttons, not CC. The CC numbers 22–29 are also wrong — those are the CC numbers for the fader row.

As a result, pressing a mute button on the MIDImix does nothing — the bridge never matches the incoming Note On against the CC mappings.

---

## MIDImix Mute Button MIDI Messages

The MIDImix sends Note On (channel 1) for all its buttons. The mute button note numbers are:

| Button | MIDI Note | LED color |
|---|---|---|
| Mute 1 | 1 | Amber |
| Mute 2 | 4 | Amber |
| Mute 3 | 7 | Amber |
| Mute 4 | 10 | Amber |
| Mute 5 | 13 | Amber |
| Mute 6 | 16 | Amber |
| Mute 7 | 19 | Amber |
| Mute 8 | 22 | Amber |

All on MIDI channel 1. Button press = Note On velocity 127. Button release = Note On velocity 0 (not a Note Off — the bridge already handles this correctly in `midi-io.ts`).

---

## Current vs Correct Mapping

**Current (wrong):**
```json
{ "label": "Mic 1 Mute", "midi": {"type": "cc", "channel": 1, "number": 22}, ... }
{ "label": "Mic 2 Mute", "midi": {"type": "cc", "channel": 1, "number": 23}, ... }
...
{ "label": "Mic 8 Mute", "midi": {"type": "cc", "channel": 1, "number": 29}, ... }
```

**Correct:**
```json
{ "label": "Mic 1 Mute",     "midi": {"type": "note_on", "channel": 1, "number": 1},  ... }
{ "label": "Mic 2 Mute",     "midi": {"type": "note_on", "channel": 1, "number": 4},  ... }
{ "label": "Mic 3 Mute",     "midi": {"type": "note_on", "channel": 1, "number": 7},  ... }
{ "label": "Mic 4 Mute",     "midi": {"type": "note_on", "channel": 1, "number": 10}, ... }
{ "label": "Standby Mute",   "midi": {"type": "note_on", "channel": 1, "number": 13}, ... }
{ "label": "Spotify Mute",   "midi": {"type": "note_on", "channel": 1, "number": 16}, ... }
{ "label": "Zoom RX Mute",   "midi": {"type": "note_on", "channel": 1, "number": 19}, ... }
{ "label": "Slides Mute",    "midi": {"type": "note_on", "channel": 1, "number": 22}, ... }
```

The full corrected entries including Q-SYS targets are in `bugfix-mute-architecture.md`.

---

## How to Confirm the Hardware Messages

Run `midi-learn.mjs` and press each mute button. You should see:

```
Note On  ch:1  note:1   vel:127   ← Mute 1 press
Note On  ch:1  note:1   vel:0     ← Mute 1 release
Note On  ch:1  note:4   vel:127   ← Mute 2 press
...
```

If you see CC messages instead, the device may have a different firmware or config — verify before applying the fix.

---

## Files to Change

| File | Change |
|---|---|
| `config/config.json` | Change mute `"type"` from `"cc"` to `"note_on"` and update `"number"` to correct note values |
| `~/Library/Application Support/midi-qsys-bridge/config.json` | Same — this is the live config |
