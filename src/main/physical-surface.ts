/**
 * The MIDImix physical surface: every control, its MIDI address, and — for a
 * button — the note that lights its lamp.
 *
 * This rig runs a custom MIDI Mix Editor preset, so a button is asymmetric:
 * it SENDS a CC but its lamp LIGHTS on a Note On at a different number.
 * Captured from the hardware:
 *
 *   Mute 1     press -> CC ch1 cc22   lamp -> Note 1
 *   Mute 7     press -> CC ch1 cc28   lamp -> Note 19
 *   Rec Arm 1  press -> CC ch3 cc22   lamp -> Note 3
 *
 * Because the two addresses differ, LED feedback cannot be read off a
 * mapping's own MIDI address. `led` carries it here instead, as a fixed
 * property of the button — so reassigning what a button controls moves its
 * lamp with it, while the lamp's note stays pinned to the hardware.
 *
 * docs/bugfix-mute-midi-type.md describes the FACTORY default, where buttons
 * send Note On. Do not "correct" these CC addresses to match it; that breaks
 * every button on this rig.
 */

export type ControlType = 'fader' | 'knob' | 'toggle'

export interface PhysicalControl {
  id: string
  label: string
  group: string
  controlType: ControlType
  midi: { type: 'cc' | 'note_on'; channel: number; number: number }
  /** The lamp this button drives. Absent on faders and knobs. */
  led?: { channel: number; note: number }
}

const m = (type: 'cc' | 'note_on', channel: number, number: number) =>
  ({ type, channel, number } as const)

export const PHYSICAL_CONTROLS: PhysicalControl[] = [
  // ── Faders ────────────────────────────────────────────────────────────────
  { id: 'F1', label: 'Fader 1', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 22) },
  { id: 'F2', label: 'Fader 2', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 23) },
  { id: 'F3', label: 'Fader 3', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 24) },
  { id: 'F4', label: 'Fader 4', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 25) },
  { id: 'F5', label: 'Fader 5', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 26) },
  { id: 'F6', label: 'Fader 6', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 27) },
  { id: 'F7', label: 'Fader 7', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 28) },
  { id: 'F8', label: 'Fader 8', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 29) },
  { id: 'FM', label: 'Master Fader', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 30) },
  // ── Knobs A (top row) ────────────────────────────────────────────────────
  { id: 'Ka1', label: 'Knob A 1', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 22) },
  { id: 'Ka2', label: 'Knob A 2', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 23) },
  { id: 'Ka3', label: 'Knob A 3', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 24) },
  { id: 'Ka4', label: 'Knob A 4', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 25) },
  { id: 'Ka5', label: 'Knob A 5', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 26) },
  { id: 'Ka6', label: 'Knob A 6', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 27) },
  { id: 'Ka7', label: 'Knob A 7', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 28) },
  { id: 'Ka8', label: 'Knob A 8', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 29) },
  // ── Knobs B (middle row) ─────────────────────────────────────────────────
  { id: 'Kb1', label: 'Knob B 1', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 22) },
  { id: 'Kb2', label: 'Knob B 2', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 23) },
  { id: 'Kb3', label: 'Knob B 3', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 24) },
  { id: 'Kb4', label: 'Knob B 4', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 25) },
  { id: 'Kb5', label: 'Knob B 5', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 26) },
  { id: 'Kb6', label: 'Knob B 6', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 27) },
  { id: 'Kb7', label: 'Knob B 7', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 28) },
  { id: 'Kb8', label: 'Knob B 8', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 29) },
  // ── Knobs C (bottom row) ─────────────────────────────────────────────────
  { id: 'Kc1', label: 'Knob C 1', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 22) },
  { id: 'Kc2', label: 'Knob C 2', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 23) },
  { id: 'Kc3', label: 'Knob C 3', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 24) },
  { id: 'Kc4', label: 'Knob C 4', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 25) },
  { id: 'Kc5', label: 'Knob C 5', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 26) },
  { id: 'Kc6', label: 'Knob C 6', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 27) },
  { id: 'Kc7', label: 'Knob C 7', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 28) },
  { id: 'Kc8', label: 'Knob C 8', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 29) },
  // ── Mutes ────────────────────────────────────────────────────────────────
  { id: 'M1', label: 'Mute 1', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 22), led: { channel: 1, note: 1 } },
  { id: 'M2', label: 'Mute 2', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 23), led: { channel: 1, note: 4 } },
  { id: 'M3', label: 'Mute 3', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 24), led: { channel: 1, note: 7 } },
  { id: 'M4', label: 'Mute 4', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 25), led: { channel: 1, note: 10 } },
  { id: 'M5', label: 'Mute 5', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 26), led: { channel: 1, note: 13 } },
  { id: 'M6', label: 'Mute 6', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 27), led: { channel: 1, note: 16 } },
  { id: 'M7', label: 'Mute 7', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 28), led: { channel: 1, note: 19 } },
  { id: 'M8', label: 'Mute 8', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 29), led: { channel: 1, note: 22 } },
  // ── Rec Arms ─────────────────────────────────────────────────────────────
  { id: 'RA1', label: 'Rec Arm 1', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 22), led: { channel: 1, note: 3 } },
  { id: 'RA2', label: 'Rec Arm 2', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 23), led: { channel: 1, note: 6 } },
  { id: 'RA3', label: 'Rec Arm 3', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 24), led: { channel: 1, note: 9 } },
  { id: 'RA4', label: 'Rec Arm 4', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 25), led: { channel: 1, note: 12 } },
  { id: 'RA5', label: 'Rec Arm 5', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 26), led: { channel: 1, note: 15 } },
  { id: 'RA6', label: 'Rec Arm 6', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 27), led: { channel: 1, note: 18 } },
  { id: 'RA7', label: 'Rec Arm 7', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 28), led: { channel: 1, note: 21 } },
  { id: 'RA8', label: 'Rec Arm 8', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 29), led: { channel: 1, note: 24 } },
  // ── Bottom buttons ────────────────────────────────────────────────────────
  { id: 'BANKL', label: 'Bank Left', group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 25), led: { channel: 1, note: 25 } },
  { id: 'BANKR', label: 'Bank Right', group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 26), led: { channel: 1, note: 26 } },
  { id: 'SOLO', label: 'Solo', group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 27), led: { channel: 1, note: 27 } },
]
