/**
 * The physical surface, verified against the actual MIDImix on this rig.
 *
 * This unit runs a custom MIDI Mix Editor preset, not the factory layout, and
 * its buttons are asymmetric: a button *sends* a CC but its lamp *lights* on a
 * Note On at a different number. Captured live from the device:
 *
 *   Mute 1     press -> CC ch1 cc22      lamp -> Note 1
 *   Mute 7     press -> CC ch1 cc28      lamp -> Note 19
 *   Rec Arm 1  press -> CC ch3 cc22      lamp -> Note 3
 *
 * That asymmetry is the reason LED feedback cannot be read off the button's
 * own MIDI address, and the reason a separate list existed at all. The lamp
 * belongs on the physical control, where it is a fixed property of the button,
 * rather than in a list keyed by Q-SYS control that drifts when a button is
 * reassigned.
 *
 * docs/bugfix-mute-midi-type.md describes the FACTORY default (buttons on
 * Note On). Do not "correct" these CC addresses to match it — that breaks
 * every button on this rig. The note numbers in `led` do match that doc,
 * because the LED protocol is the same either way.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHYSICAL_CONTROLS } from './physical-surface.js'

const byId = (id: string) => {
  const pc = PHYSICAL_CONTROLS.find((p) => p.id === id)
  assert.ok(pc, `no physical control ${id}`)
  return pc
}

test('a mute button sends the CC this unit actually sends', () => {
  assert.deepEqual(byId('M1').midi, { type: 'cc', channel: 1, number: 22 })
  assert.deepEqual(byId('M7').midi, { type: 'cc', channel: 1, number: 28 })
  assert.deepEqual(byId('M8').midi, { type: 'cc', channel: 1, number: 29 })
})

test('a Rec Arm button sends the CC this unit actually sends', () => {
  assert.deepEqual(byId('RA1').midi, { type: 'cc', channel: 3, number: 22 })
  assert.deepEqual(byId('RA8').midi, { type: 'cc', channel: 3, number: 29 })
})

test('every mute button carries the note that lights its own lamp', () => {
  const notes = [1, 4, 7, 10, 13, 16, 19, 22]
  assert.deepEqual(
    notes.map((_, i) => byId(`M${i + 1}`).led),
    notes.map((note) => ({ channel: 1, note })),
  )
})

test('every Rec Arm button carries the note that lights its own lamp', () => {
  const notes = [3, 6, 9, 12, 15, 18, 21, 24]
  assert.deepEqual(
    notes.map((_, i) => byId(`RA${i + 1}`).led),
    notes.map((note) => ({ channel: 1, note })),
  )
})

test('a fader carries no lamp', () => {
  assert.equal(byId('F1').led, undefined)
  assert.equal(byId('Ka1').led, undefined)
})

test('the faders keep the CC addresses they already had', () => {
  assert.deepEqual(byId('F1').midi, { type: 'cc', channel: 7, number: 22 })
  assert.deepEqual(byId('F8').midi, { type: 'cc', channel: 7, number: 29 })
})

test('no two physical controls share an input address', () => {
  const seen = new Map<string, string>()
  const clashes: string[] = []
  for (const pc of PHYSICAL_CONTROLS) {
    const key = `${pc.midi.type}:${pc.midi.channel}:${pc.midi.number}`
    if (seen.has(key)) clashes.push(`${pc.label} collides with ${seen.get(key)} on ${key}`)
    else seen.set(key, pc.label)
  }
  assert.deepEqual(clashes, [])
})

test('no two lamps share a note', () => {
  const seen = new Map<string, string>()
  const clashes: string[] = []
  for (const pc of PHYSICAL_CONTROLS) {
    if (!pc.led) continue
    const key = `${pc.led.channel}:${pc.led.note}`
    if (seen.has(key)) clashes.push(`${pc.label} shares a lamp with ${seen.get(key)}`)
    else seen.set(key, pc.label)
  }
  assert.deepEqual(clashes, [])
})
