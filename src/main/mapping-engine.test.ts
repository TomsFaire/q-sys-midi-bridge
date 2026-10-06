import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MappingEngine } from './mapping-engine.js'
import type { QrcClient } from './qrc-client.js'
import type { MidiIO } from './midi-io.js'
import type { Config } from './config.js'

/** Records the LED traffic the engine emits, in order. */
class FakeMidi {
  sent: string[] = []
  pitchBends: Array<[number, number]> = []
  sendNoteOn(channel: number, note: number): void { this.sent.push(`on ${channel}:${note}`) }
  sendNoteOff(channel: number, note: number): void { this.sent.push(`off ${channel}:${note}`) }
  sendPitchBend(channel: number, value14: number): void { this.pitchBends.push([channel, value14]) }
}

class FakeQrc extends EventEmitter {
  isConnected = true
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params })
    return {}
  }
}

function config(): Config {
  return {
    qsys: { host: '127.0.0.1', port: 1710 },
    midi: { deviceName: 'MIDI Mix' },
    mappings: [
      {
        label: 'Mic 1 Mute',
        midi: { type: 'note_on', channel: 1, number: 1 },
        qsys: { type: 'toggle', component: 'Mic.01.Gain', control: 'mute' },
      },
    ],
    feedback: {
      enabled: true,
      mute_leds: [{ component: 'Mic.01.Gain', control: 'mute', midi: { channel: 1, note: 1 } }],
    },
  }
}

function build(cfg = config()) {
  const qrc = new FakeQrc()
  const midi = new FakeMidi()
  const engine = new MappingEngine(
    qrc as unknown as QrcClient,
    midi as unknown as MidiIO,
    cfg,
  )
  return { qrc, midi, engine }
}

const push = (qrc: FakeQrc, value: number) =>
  qrc.emit('notification', 'mutes', {
    Id: 'mutes',
    Changes: [{ Component: 'Mic.01.Gain', Name: 'mute', Value: value, String: value ? 'muted' : 'unmuted' }],
  })

test('a mute set on the Core lights the mapped LED', () => {
  // The mute the bridge did not initiate: pressed in the UCI or on the Core.
  const { qrc, midi } = build()
  push(qrc, 1)
  assert.deepEqual(midi.sent, ['on 1:1'])
})

test('a mute cleared on the Core clears the LED', () => {
  const { qrc, midi } = build()
  push(qrc, 1)
  push(qrc, 0)
  assert.deepEqual(midi.sent, ['on 1:1', 'off 1:1'])
})

test('a button press after an out-of-band mute toggles from the Core state, not a stale guess', async () => {
  // Without the Core's pushes the local state said "unmuted", so the first
  // press re-sent mute=1 and the LED stuck on. Tracking the push means the
  // press unmutes, which is what the operator sees on the strip.
  const { qrc, midi, engine } = build()
  push(qrc, 1)
  engine.handleNoteOn(1, 1)
  await new Promise((r) => setImmediate(r))

  const set = qrc.calls.filter((c) => c.method === 'Component.Set')
  assert.equal(set.length, 1)
  assert.deepEqual(set[0].params, {
    Name: 'Mic.01.Gain',
    Controls: [{ Name: 'mute', Value: 0 }],
  })
  assert.deepEqual(midi.sent, ['on 1:1', 'off 1:1'])
})

test('a change for a control with no LED entry leaves the LEDs alone', () => {
  const { qrc, midi } = build()
  qrc.emit('notification', 'mutes', {
    Id: 'mutes',
    Changes: [{ Component: 'Bus.Mixer', Name: 'output.9.mute', Value: 1 }],
  })
  assert.deepEqual(midi.sent, [])
})

test('syncLEDs replays the tracked state when the control surface reconnects', () => {
  const { qrc, midi, engine } = build()
  push(qrc, 1)
  midi.sent.length = 0
  engine.syncLEDs()
  assert.deepEqual(midi.sent, ['on 1:1'])
})

// ── X-Touch: motorised faders and touch ──────────────────────────────────────

/** A one-strip X-Touch rig: fader on pitch bend channel 2, gain -100..20 dB. */
function xtouchConfig(): Config {
  return {
    qsys: { host: '127.0.0.1', port: 1710 },
    midi: { deviceName: 'X-Touch' },
    mappings: [
      {
        label: 'Mic 2 Fader',
        midi: { type: 'pitchbend', channel: 2 },
        qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -100, max: 20 },
      },
    ],
    feedback: {
      enabled: true,
      mute_leds: [],
      fader_positions: [
        { component: 'Mic.02.Gain', control: 'gain', midi: { channel: 2 }, min: -100, max: 20 },
      ],
    },
  }
}

const pushGain = (qrc: FakeQrc, value: number) =>
  qrc.emit('notification', 'mutes', {
    Id: 'mutes',
    Changes: [{ Component: 'Mic.02.Gain', Name: 'gain', Value: value, String: `${value}dB` }],
  })

test('moving a fader writes the scaled dB value to Q-SYS', async () => {
  const { qrc, engine } = build(xtouchConfig())
  engine.handlePitchBend(2, 16383)   // top of travel
  await new Promise((r) => setImmediate(r))

  const set = qrc.calls.filter((c) => c.method === 'Component.Set')
  assert.equal(set.length, 1)
  assert.deepEqual(set[0].params, {
    Name: 'Mic.02.Gain',
    Controls: [{ Name: 'gain', Value: 20 }],
  })
})

test('a fader at the bottom of its travel writes the minimum, not zero', async () => {
  const { qrc, engine } = build(xtouchConfig())
  engine.handlePitchBend(2, 0)
  await new Promise((r) => setImmediate(r))

  const set = qrc.calls.filter((c) => c.method === 'Component.Set')
  assert.deepEqual(set[0].params, {
    Name: 'Mic.02.Gain',
    Controls: [{ Name: 'gain', Value: -100 }],
  })
})

test('a pitch bend on an unmapped channel is ignored', async () => {
  const { qrc, engine } = build(xtouchConfig())
  engine.handlePitchBend(7, 8192)
  await new Promise((r) => setImmediate(r))
  assert.equal(qrc.calls.filter((c) => c.method === 'Component.Set').length, 0)
})

test('a gain change on the Core drives the motor to that position', () => {
  const { qrc, midi } = build(xtouchConfig())
  pushGain(qrc, 20)                      // top of the configured range
  assert.deepEqual(midi.pitchBends, [[2, 16383]])
})

test('the motor does not fight a hand already on the fader', () => {
  const { qrc, midi, engine } = build(xtouchConfig())
  engine.handleNoteOn(1, 105)            // touch down on fader 2
  pushGain(qrc, 20)
  assert.deepEqual(midi.pitchBends, [])
})

test('releasing a fader snaps the motor to the value the Core now holds', () => {
  const { qrc, midi, engine } = build(xtouchConfig())
  engine.handleNoteOn(1, 105)
  pushGain(qrc, 20)                      // changed under the operator's hand
  engine.handleNoteOff(1, 105)
  assert.deepEqual(midi.pitchBends, [[2, 16383]])
})

test('a button release is not treated as a fader release', () => {
  // Note 22 is a MIDImix mute, nowhere near the 104-112 touch range.
  const { qrc, midi, engine } = build(xtouchConfig())
  pushGain(qrc, 20)
  midi.pitchBends.length = 0
  engine.handleNoteOff(1, 22)
  assert.deepEqual(midi.pitchBends, [])
})

test('a rig with no fader_positions never sends pitch bend', () => {
  // The MIDImix has no motors; feedback must stay LED-only for it.
  const { qrc, midi } = build(config())
  push(qrc, 1)
  assert.deepEqual(midi.pitchBends, [])
})

test('setupChangeGroup subscribes the fader controls, not just the mutes', async () => {
  const { qrc, engine } = build(xtouchConfig())
  await engine.setupChangeGroup()
  const subs = qrc.calls.filter((c) => c.method === 'ChangeGroup.AddComponentControl')
  const asked = subs.map((c) => {
    const comp = (c.params as { Component: { Name: string; Controls: Array<{ Name: string }> } }).Component
    return `${comp.Name}:${comp.Controls.map((x) => x.Name).join(',')}`
  })
  assert.deepEqual(asked, ['Mic.02.Gain:gain'])
})
