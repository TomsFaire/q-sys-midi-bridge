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
  sendNoteOn(channel: number, note: number): void { this.sent.push(`on ${channel}:${note}`) }
  sendNoteOff(channel: number, note: number): void { this.sent.push(`off ${channel}:${note}`) }
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
    // No per-LED config: note 1 lights because the mapping above binds it.
    feedback: { enabled: true },
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

test('a press while the Core is disconnected is reported, not swallowed', async () => {
  // The silent early return in execute() made a dropped QRC connection look
  // identical to a broken mapping: raw MIDI scrolls past and nothing else
  // happens. The activity log has to name the reason.
  const { qrc, engine } = build()
  qrc.isConnected = false

  engine.handleNoteOn(1, 1)
  await new Promise((r) => setImmediate(r))

  assert.match(engine.getRecentActivity()[0] ?? '', /not connected/i)
  assert.deepEqual(qrc.calls, [])
})

test('a press on an unmapped button is reported, not swallowed', async () => {
  // The other half of "nothing happens": the note arrived but matched no
  // mapping, which is a config problem rather than a connection one.
  const { engine } = build()

  engine.handleNoteOn(1, 99)
  await new Promise((r) => setImmediate(r))

  assert.match(engine.getRecentActivity()[0] ?? '', /no mapping/i)
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
