# MIDI Q-Sys Bridge

macOS menu-bar app that maps an **Akai MIDImix** to Q-Sys controls over QRC (TCP port 1710). Runs headlessly in the system tray with no window. Bidirectional: mute button LEDs stay in sync with Q-Sys state.

> **Primary hardware:** Akai MIDImix (USB class-compliant, 8 channels × 3 knob rows + faders + mute/rec-arm buttons). See [Adapting to other controllers](#adapting-to-other-controllers) if you want to use a different device.

---

## Requirements

- macOS (Apple Silicon or Intel)
- Node.js 20+
- Q-Sys Core with **External Control** enabled (Core Properties → External Control → Enable)
- Akai MIDImix connected via USB

---

## Installation

```bash
npm install
npm run rebuild-midi   # rebuilds native MIDI addon for your Electron version
npm start              # build + launch
```

To package a distributable DMG:

```bash
npm run package
# output: release/MIDI Q-Sys Bridge-0.1.0.dmg
```

---

## Config file location

The app looks for `config.json` in these locations, in order:

1. `~/Library/Application Support/midi-qsys-bridge/config.json` — user data dir (takes priority)
2. `<app bundle>/config/config.json` — bundled default

Edit the bundled `config/config.json` to get started, or copy it to the user data dir to survive app updates.

Use **Tray → Configure Mappings** to assign Q-Sys components to physical controls interactively — click **Save & Apply** to reload the bridge live without restarting. Use **Tray → Open Config File** to edit the raw JSON directly.

---

## Q-Sys Designer setup

The bridge talks to Q-Sys using **QRC (JSON-RPC 2.0 over TCP port 1710)**. No Lua scripting or Named Actions are required — it calls `Component.Set` and `Control.Set` directly.

### What you need in the design

1. **Enable External Control** on the Core  
   Core Properties → External Control → ✓ Enable External Control

2. **Component names must match exactly**  
   Right-click a component in Designer → Properties to check the name. The config uses these by default:

   | Config name | What it should be in your design |
   |---|---|
   | `Input.Mixer` | Your main input mixer component |
   | `Matrix.Mains` | Main speaker matrix output |
   | `Matrix.ZoomTX` | Zoom transmit matrix output |

   These are just defaults — rename them in `config.json` to match whatever you have.

3. **Control names**  
   These come from Q-Sys's internal component API. For a standard Mixer component the gain/mute controls follow the pattern `input.N.gain` / `input.N.mute`. If you're using a custom schematic, open the component in Designer and hover a control to see its name.

4. **No Named Controls or Script access needed** — QRC external control handles it all.

---

## config.json reference

```jsonc
{
  "qsys": {
    "host": "10.4.84.20",    // Q-Sys Core IP
    "port": 1710             // QRC port — don't change unless you've moved it
  },
  "midi": {
    "deviceName": "MIDI Mix" // Substring match against MIDI port name
  },
  "mappings": [ ... ],       // see below
  "feedback": { ... }        // see below
}
```

### mappings

Each entry maps one MIDI event to one Q-Sys action.

```jsonc
{
  "label": "Mic 1 Fader",          // optional — shown in tray activity log
  "midi": {
    "type": "cc",                   // "cc" or "note_on"
    "channel": 1,                   // MIDI channel, 1-indexed
    "number": 19                    // CC number or note number
  },
  "qsys": { ... }                   // see action types below
}
```

### Q-Sys action types

#### `component_control` — set a value on a named component

Use this for faders, knobs, and any continuously variable control.

```jsonc
"qsys": {
  "type": "component_control",
  "component": "Input.Mixer",      // component name in Designer
  "control": "input.1.gain",       // control name within that component
  "min": -100,                     // value sent when MIDI = 0
  "max": 10                        // value sent when MIDI = 127
}
```

The MIDI value (0–127) is linearly scaled to the `min`/`max` range. For gain controls, `min`/`max` are in dB. For frequency controls, they're in Hz. For 0–1 range (e.g. send levels), use `"min": 0, "max": 1`.

**Knob center point:** The MIDImix knobs send CC 64 at center position. If you want center = 0 dB on a ±18 dB trim, set `"min": -18, "max": 18` — at CC 64 you'll get ≈ 0 dB.

#### `toggle` — flip a boolean control on/off

Use this for mute buttons. State is tracked locally and flipped on each Note On.

```jsonc
"qsys": {
  "type": "toggle",
  "component": "Input.Mixer",
  "control": "input.1.mute"
}
```

With `feedback.enabled: true`, toggle state stays in sync with Q-Sys even if the mute changes from a UCI button, another controller, or a Lua script (see Feedback section below).

#### `named_control` — set a Named Control by name

Use this when you've exposed a control as a Named Control in Designer (Script → Named Controls). Works the same as `component_control` but uses `Control.Set` instead of `Component.Set`.

```jsonc
"qsys": {
  "type": "named_control",
  "name": "MyNamedControl",
  "min": 0,
  "max": 100
}
```

#### `snapshot` — load a snapshot

Triggered by Note On. Loads by name or by bank/slot.

```jsonc
// By name:
"qsys": { "type": "snapshot", "name": "My Snapshot Name" }

// By bank and slot:
"qsys": { "type": "snapshot", "bank": 1, "slot": 3 }
```

---

## Adapting to other controllers

The bridge is wired to the MIDImix in two places. To use a different controller you need to update both.

### 1. Discover your controller's MIDI map

Run the interactive learn script with your device connected:

```bash
node midi-learn.mjs
```

It walks you through every control one by one and records the CC channel/number or Note channel/number for each. Outputs a table and a config snippet. If your device has a different layout, edit the control list at the top of `midi-learn.mjs` before running.

### 2. Update the physical control definitions

Open `src/main/configurator.ts` and edit the `PHYSICAL_CONTROLS` array. Each entry describes one physical control and its MIDI address:

```typescript
{ id: 'F1', label: 'Fader 1', group: 'Faders', controlType: 'fader',  midi: m('cc',      7, 22) },
{ id: 'M1', label: 'Mute 1',  group: 'Mutes',  controlType: 'toggle', midi: m('cc',      1, 22) },
{ id: 'BL', label: 'Bank L',  group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 25) },
```

`controlType` controls what the configurator generates when you assign a Q-Sys target:
- `fader` / `knob` → `component_control` (continuous, with min/max scaling)
- `toggle` → `toggle` (on/off, stateful)

### 3. Update config.json

Change `midi.deviceName` to a substring of your device's MIDI port name. The app does a substring match, so `"MIDI Mix"` matches `"MIDI Mix MIDI 1"`.

### 4. LED feedback

The MIDImix uses **Note On velocity 0** to turn off LEDs (not a Note Off message). Other devices vary — some use proper Note Off (0x80), some use CC, some have no LED control at all. If your device behaves differently, edit `sendNoteOff` in `src/main/midi-io.ts`.

---

## MIDImix layout and CC/note numbers

```
         CH1   CH2   CH3   CH4   CH5   CH6   CH7   CH8
Row A:   16    20    24    28    46    50    54    58    ← knobs (CC)
Row B:   17    21    25    29    47    51    55    59    ← knobs (CC)
Row C:   18    22    26    30    48    52    56    60    ← knobs (CC)
Solo:     2     5     8    11    14    17    20    23    ← buttons (note)
Mute:     1     4     7    10    13    16    19    22    ← buttons (note)
Fader:   19    23    27    31    49    53    57    61    ← faders (CC)

Master fader: CC 62
BANK L button: note 25
BANK R button: note 26
```

All MIDI channel 1.

---

## What to assign to the knobs

The three knob rows give you 24 CCs. Only Row A is wired by default (pre-fader trim). Some ideas for the other rows:

| Row | Suggested use | Q-Sys control pattern |
|---|---|---|
| Row A (16–18 series) | Pre-fader trim ±18 dB | `input.N.trim`, min -18 max 18 |
| Row B (17–21 series) | HPF cutoff frequency | `Mic.0N.HPF` component, `frequency` control, min 20 max 500 |
| Row B | Monitor/IEM send level | `input.N.send.1` or similar, min 0 max 1 |
| Row C (18–22 series) | EQ band gain | Component per-mic EQ band, min -12 max 12 |
| Row C | Compression threshold | Compressor component, `threshold`, min -40 max 0 |
| Solo buttons | Bus mute toggles | `Bus.Mixer`, `input.N.mute` |
| Solo buttons | Snapshot recall | `type: snapshot` per button |

The control names for sub-components (HPF, compressor, EQ) depend on how your Q-Sys design is structured. If they're inside a larger component rather than individual blocks, you may not be able to address them via `Component.Set` — in that case, expose them as Named Controls in Designer and use `type: named_control`.

To find the right control name for any component:
1. In Q-Sys Designer, go to **Tools → QRC API Reference** (or use the MCP inspector)
2. Send `Component.GetControls` with the component name to list all addressable controls

---

## Feedback (bidirectional mute sync)

When `feedback.enabled` is `true`, the bridge subscribes to mute control changes using Q-Sys ChangeGroup AutoPoll. Q-Sys pushes updates over the same TCP connection at 50ms intervals. This keeps the MIDImix mute button LEDs in sync with whatever changes mutes in Q-Sys — UCI panels, Lua scripts, other controllers.

```jsonc
"feedback": {
  "enabled": true,
  "mute_leds": [
    // Each entry maps a Q-Sys mute control to a MIDImix LED
    { "component": "Input.Mixer", "control": "input.1.mute", "midi": {"channel": 1, "note": 1} },
    { "component": "Input.Mixer", "control": "input.2.mute", "midi": {"channel": 1, "note": 4} }
    // ... etc
  ]
}
```

The note numbers in `mute_leds` must match the note numbers in the corresponding `toggle` mappings for the LEDs to track correctly.

When `enabled: false`, toggle state is tracked locally only — the LED will drift if anything else changes the mute outside the MIDI controller.

---

## Unresolved modifier buttons

Two physical buttons on the MIDImix are **modifiers by design** and are not currently assignable in the Configure Mappings UI.

### SEND ALL
The SEND ALL button sends **CC ch4/22** — the exact same MIDI message as Knob A 1. There is no way to distinguish the two at the MIDI level. Its design intent is: hold SEND ALL and turn any knob to broadcast that value to all 8 channels of that knob row simultaneously (a "gang" function for bulk-setting sends). Not yet implemented.

### SOLO
The SOLO button (note ch1/27) is designed as a modifier: hold SOLO and press a mute button to solo that channel (mute all others, unmute the selected one). Its LED is controlled by the device firmware — it cannot be driven externally via MIDI Note On the way the mute LEDs can. Currently the button is wired as a simple output mute toggle, but solo-while-held behavior has not been implemented.

**Future options to consider:**
- SEND ALL: implement gang-knob broadcast in the bridge (when CC ch4/22 fires, write that value to all mapped knob-row targets)
- SOLO: implement hold-to-solo logic (track SOLO held state; intercept mute presses while held; mute all channels except the selected one)

---

## Tray menu

Click the menu bar icon to see:

- **Q-Sys connection status** and Core IP
- **MIDI device status** and port name
- **Recent activity log** (last 5 actions)
- **Open Config File** — opens the active config in your default editor
- **Quit**

The icon is filled when both Q-Sys and MIDI are connected, dim when either is disconnected. The app auto-reconnects to both if they drop.
