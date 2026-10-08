/**
 * The editor's physical surface has to address the MIDImix the way the
 * hardware actually speaks, or a mapping made in the editor is written to an
 * address the controller never sends.
 *
 * The MIDImix sends Note On (channel 1) for every button — see
 * docs/bugfix-mute-midi-type.md. The mute row is notes 1, 4, 7 … 22 and the
 * Rec Arm row is notes 3, 6, 9 … 24. The surface table declared both rows as
 * CC 22–29 instead, which are the fader and knob CC numbers: assigning a mute
 * in the editor produced a mapping that could never fire, and — since LED
 * feedback is derived from note_on toggles — could never light its lamp
 * either. config.json was corrected for this long ago; the editor's table
 * was not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHYSICAL_CONTROLS } from './mapping-service.js'

const byId = (id: string) => {
  const pc = PHYSICAL_CONTROLS.find((p) => p.id === id)
  assert.ok(pc, `no physical control ${id}`)
  return pc
}

/** docs/bugfix-mute-midi-type.md — the mute row, in order. */
const MUTE_NOTES = [1, 4, 7, 10, 13, 16, 19, 22]
/** docs/mute-alignment-handoff.md — the Rec Arm row, in order. */
const REC_ARM_NOTES = [3, 6, 9, 12, 15, 18, 21, 24]

test('every mute button is addressed as the Note On the hardware sends', () => {
  const actual = MUTE_NOTES.map((_, i) => byId(`M${i + 1}`).midi)
  assert.deepEqual(
    actual,
    MUTE_NOTES.map((number) => ({ type: 'note_on', channel: 1, number })),
  )
})

test('every Rec Arm button is addressed as the Note On the hardware sends', () => {
  const actual = REC_ARM_NOTES.map((_, i) => byId(`RA${i + 1}`).midi)
  assert.deepEqual(
    actual,
    REC_ARM_NOTES.map((number) => ({ type: 'note_on', channel: 1, number })),
  )
})

test('no button is addressed as a CC', () => {
  // A toggle on a CC cannot light a lamp: the derivation needs a note.
  const onCC = PHYSICAL_CONTROLS.filter((p) => p.controlType === 'toggle' && p.midi.type === 'cc')
  assert.deepEqual(onCC.map((p) => p.label), [])
})

test('no two physical controls share a MIDI address', () => {
  // The mute row previously collided with the fader row on CC 22–29, so one
  // press drove two mappings.
  const seen = new Map<string, string>()
  const clashes: string[] = []
  for (const pc of PHYSICAL_CONTROLS) {
    const key = `${pc.midi.type}:${pc.midi.channel}:${pc.midi.number}`
    if (seen.has(key)) clashes.push(`${pc.label} collides with ${seen.get(key)} on ${key}`)
    else seen.set(key, pc.label)
  }
  assert.deepEqual(clashes, [])
})

test('the faders keep the CC addresses they already had', () => {
  // Guards against "fixing" the collision by moving the wrong row.
  assert.deepEqual(byId('F1').midi, { type: 'cc', channel: 7, number: 22 })
  assert.deepEqual(byId('F8').midi, { type: 'cc', channel: 7, number: 29 })
})
