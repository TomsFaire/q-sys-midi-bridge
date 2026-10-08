/**
 * Ganged ("stereo-link") mapping tests.
 *
 * One knob on the MIDImix drives one Q-SYS control, which is right for a
 * mono mic but only ever half of a stereo pair — turning Knob A 1 trims the
 * left leg of a Dante input and leaves the right where it was.
 *
 * A mapping may therefore carry `qsys.link`, a second target that moves with
 * the primary. Either field of the link may be omitted and is then inherited
 * from the primary, so both real topologies are expressible:
 *
 *   link: { component: 'Dante.In.10.Gain' }  → other component, same control
 *   link: { control: 'gain.2' }              → same component, other control
 *
 * These tests drive MappingEngine with a recording fake QRC client and assert
 * on the JSON-RPC it emits.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MappingEngine } from './mapping-engine.js'
import type { QrcClient } from './qrc-client.js'
import type { MidiIO } from './midi-io.js'
import type { Config, Mapping } from './config.js'

interface RecordedCall { method: string; params: Record<string, unknown> }

/** Records every QRC call instead of talking to a Core. */
function fakeQrc(): { qrc: QrcClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const qrc = {
    isConnected: true,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      return {}
    },
    on: () => qrc,
    removeAllListeners: () => qrc,
  } as unknown as QrcClient
  return { qrc, calls }
}

interface LedEvent { kind: 'on' | 'off'; channel: number; note: number }

function fakeMidi(): { midi: MidiIO; leds: LedEvent[] } {
  const leds: LedEvent[] = []
  const midi = {
    sendNoteOn: (channel: number, note: number) => { leds.push({ kind: 'on', channel, note }) },
    sendNoteOff: (channel: number, note: number) => { leds.push({ kind: 'off', channel, note }) },
  } as unknown as MidiIO
  return { midi, leds }
}

function configWith(mappings: Mapping[]): Config {
  return {
    qsys: { host: '', port: 1710 },
    midi: { deviceName: '' },
    mappings,
    feedback: { enabled: false },
  }
}

/** Builds an engine over `mappings` and returns the recorders. */
function engineFor(mappings: Mapping[]) {
  const { qrc, calls } = fakeQrc()
  const { midi, leds } = fakeMidi()
  const engine = new MappingEngine(qrc, midi, configWith(mappings))
  return { engine, calls, leds }
}

/** Settles the floating promise `handleCC` / `handleNoteOn` kick off. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

const KNOB_A1 = { type: 'cc', channel: 4, number: 22 } as const

// ── component_control ────────────────────────────────────────────────────────

test('a linked knob across two components writes the same value to both', async () => {
  const { engine, calls } = engineFor([{
    label: 'Dante 9/10 Gain',
    midi: KNOB_A1,
    qsys: {
      type: 'component_control',
      component: 'Dante.In.9.Gain',
      control: 'gain',
      min: -100,
      max: 20,
      link: { component: 'Dante.In.10.Gain' },
    },
  }])

  engine.handleCC(4, 22, 127)
  await flush()

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.params.Name).sort(), ['Dante.In.10.Gain', 'Dante.In.9.Gain'])
  for (const call of calls) {
    assert.equal(call.method, 'Component.Set')
    assert.deepEqual(call.params.Controls, [{ Name: 'gain', Value: 20 }])
  }
})

test('a link that names only a control inherits the primary component', async () => {
  const { engine, calls } = engineFor([{
    label: 'Dante 9/10 Gain',
    midi: KNOB_A1,
    qsys: {
      type: 'component_control',
      component: 'Dante.Pair.Gain',
      control: 'gain.1',
      min: -100,
      max: 20,
      link: { control: 'gain.2' },
    },
  }])

  engine.handleCC(4, 22, 127)
  await flush()

  // Same component — one call carrying both legs, not two round-trips.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.Name, 'Dante.Pair.Gain')
  assert.deepEqual(calls[0].params.Controls, [
    { Name: 'gain.1', Value: 20 },
    { Name: 'gain.2', Value: 20 },
  ])
})

test('a link that names only a component inherits the primary control', async () => {
  const { engine, calls } = engineFor([{
    midi: KNOB_A1,
    qsys: {
      type: 'component_control',
      component: 'Dante.In.9.Gain',
      control: 'gain',
      min: -100,
      max: 20,
      link: { component: 'Dante.In.10.Gain' },
    },
  }])

  engine.handleCC(4, 22, 0)
  await flush()

  const linked = calls.find((c) => c.params.Name === 'Dante.In.10.Gain')
  assert.ok(linked, 'expected a write to the linked component')
  assert.deepEqual(linked.params.Controls, [{ Name: 'gain', Value: -100 }])
})

test('both legs of a link receive one identically scaled value', async () => {
  const { engine, calls } = engineFor([{
    midi: KNOB_A1,
    qsys: {
      type: 'component_control',
      component: 'A.Gain',
      control: 'gain',
      min: -100,
      max: 20,
      link: { component: 'B.Gain' },
    },
  }])

  // A midpoint value — the two legs must not drift apart by rounding.
  engine.handleCC(4, 22, 64)
  await flush()

  const values = calls.map((c) => (c.params.Controls as Array<{ Value: number }>)[0].Value)
  assert.equal(values.length, 2)
  assert.equal(values[0], values[1])
})

test('an unlinked knob still writes exactly one control', async () => {
  const { engine, calls } = engineFor([{
    midi: KNOB_A1,
    qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -100, max: 20 },
  }])

  engine.handleCC(4, 22, 127)
  await flush()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].params.Name, 'Mic.02.Gain')
  assert.deepEqual(calls[0].params.Controls, [{ Name: 'gain', Value: 20 }])
})

// ── toggle ───────────────────────────────────────────────────────────────────

test('a linked toggle mutes both legs together', async () => {
  const { engine, calls } = engineFor([{
    label: 'Dante 9/10 Mute',
    midi: { type: 'cc', channel: 1, number: 22 },
    qsys: {
      type: 'toggle',
      component: 'Dante.In.9.Gain',
      control: 'mute',
      link: { component: 'Dante.In.10.Gain' },
    },
  }])

  engine.handleCC(1, 22, 127)
  await flush()

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call.params.Controls, [{ Name: 'mute', Value: 1 }])
  }
})

test('a linked toggle unmutes both legs on the second press', async () => {
  const { engine, calls } = engineFor([{
    midi: { type: 'cc', channel: 1, number: 22 },
    qsys: {
      type: 'toggle',
      component: 'Dante.In.9.Gain',
      control: 'mute',
      link: { component: 'Dante.In.10.Gain' },
    },
  }])

  engine.handleCC(1, 22, 127)
  await flush()
  engine.handleCC(1, 22, 127)
  await flush()

  // Four writes: both legs muted, then both legs unmuted. The linked leg must
  // follow the primary's cached state rather than toggling independently —
  // otherwise the pair desyncs into "left muted, right open".
  assert.equal(calls.length, 4)
  const lastTwo = calls.slice(2)
  for (const call of lastTwo) {
    assert.deepEqual(call.params.Controls, [{ Name: 'mute', Value: 0 }])
  }
})

test('a linked toggle sharing a component batches both legs into one call', async () => {
  const { engine, calls } = engineFor([{
    midi: { type: 'cc', channel: 1, number: 22 },
    qsys: {
      type: 'toggle',
      component: 'Dante.Pair.Gain',
      control: 'mute.1',
      link: { control: 'mute.2' },
    },
  }])

  engine.handleCC(1, 22, 127)
  await flush()

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].params.Controls, [
    { Name: 'mute.1', Value: 1 },
    { Name: 'mute.2', Value: 1 },
  ])
})

test('a linked toggle drives the LED bound to its primary leg', async () => {
  // The button lights once, for the primary. The ganged leg moves with it but
  // owns no lamp of its own, so a stereo pair never lights two buttons.
  const { engine, leds } = engineFor([{
    midi: { type: 'note_on', channel: 1, number: 1 },
    qsys: {
      type: 'toggle',
      component: 'Dante.In.9.Gain',
      control: 'mute',
      link: { component: 'Dante.In.10.Gain' },
    },
  }])

  engine.handleNoteOn(1, 1)
  await flush()

  assert.deepEqual(leds, [{ kind: 'on', channel: 1, note: 1 }])
})
