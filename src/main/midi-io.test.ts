import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MidiIO, parseMidiMessage, encodePitchBend } from './midi-io.js'

/** Reaches the private message handler the port callback calls. */
type Feedable = { handleMessage(msg: number[]): void }

test('parseMidiMessage decodes a 14-bit pitch bend into one value', () => {
  // 8192 = centre: LSB 0, MSB 64. The X-Touch sends LSB first.
  assert.deepEqual(parseMidiMessage([0xE0, 0, 64]), {
    type: 'pitchbend', channel: 1, value: 8192,
  })
})

test('parseMidiMessage reads the pitch bend channel from the status nibble', () => {
  // Fader 3 is pitch bend channel 3, and 16383 is the top of travel.
  assert.deepEqual(parseMidiMessage([0xE2, 127, 127]), {
    type: 'pitchbend', channel: 3, value: 16383,
  })
})

test('parseMidiMessage reports a real Note Off as a release', () => {
  // The X-Touch sends 0x80 when a hand leaves a fader.
  assert.deepEqual(parseMidiMessage([0x80, 104, 0]), {
    type: 'note_off', channel: 1, note: 104,
  })
})

test('parseMidiMessage reports Note On velocity 0 as a release too', () => {
  // The MIDImix never sends 0x80; a button release is Note On vel 0.
  assert.deepEqual(parseMidiMessage([0x90, 1, 0]), {
    type: 'note_off', channel: 1, note: 1,
  })
})

test('parseMidiMessage still reports a real press as a press', () => {
  assert.deepEqual(parseMidiMessage([0x90, 1, 127]), {
    type: 'note_on', channel: 1, note: 1,
  })
})

test('encodePitchBend splits a 14-bit value into LSB and MSB', () => {
  assert.deepEqual(encodePitchBend(1, 8192), [0xE0, 0, 64])
  assert.deepEqual(encodePitchBend(9, 16383), [0xE8, 127, 127])
  assert.deepEqual(encodePitchBend(1, 0), [0xE0, 0, 0])
})

test('encodePitchBend clamps a value outside the 14-bit range', () => {
  // A dB value past the configured range must not wrap the fader to the bottom.
  assert.deepEqual(encodePitchBend(1, 20000), [0xE0, 127, 127])
  assert.deepEqual(encodePitchBend(1, -5), [0xE0, 0, 0])
})

test('MidiIO emits a pitchbend event when a fader moves', () => {
  const io = new MidiIO('nothing-is-open')
  const seen: Array<[number, number]> = []
  io.on('pitchbend', (channel: number, value: number) => seen.push([channel, value]))
  ;(io as unknown as Feedable).handleMessage([0xE1, 0, 64])
  assert.deepEqual(seen, [[2, 8192]])
})

test('MidiIO emits note_off when a fader is released', () => {
  const io = new MidiIO('nothing-is-open')
  const seen: Array<[number, number]> = []
  io.on('note_off', (channel: number, note: number) => seen.push([channel, note]))
  ;(io as unknown as Feedable).handleMessage([0x80, 104, 0])
  assert.deepEqual(seen, [[1, 104]])
})

test('MidiIO still emits note_on for a button press', () => {
  const io = new MidiIO('nothing-is-open')
  const seen: Array<[number, number]> = []
  io.on('note_on', (channel: number, note: number) => seen.push([channel, note]))
  ;(io as unknown as Feedable).handleMessage([0x90, 22, 127])
  assert.deepEqual(seen, [[1, 22]])
})

test('MidiIO does not emit note_on for a release', () => {
  // A toggle fires on press only; emitting on release would double-fire it.
  const io = new MidiIO('nothing-is-open')
  let count = 0
  io.on('note_on', () => { count += 1 })
  ;(io as unknown as Feedable).handleMessage([0x90, 22, 0])
  ;(io as unknown as Feedable).handleMessage([0x80, 22, 0])
  assert.equal(count, 0)
})
