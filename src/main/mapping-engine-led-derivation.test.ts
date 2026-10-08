/**
 * LED feedback is derived from the button mappings themselves.
 *
 * It used to come from `feedback.mute_leds`, a second array keyed the other
 * way round (component → note). Nothing in either mapping editor wrote to it,
 * so reassigning a button moved what the button *did* while leaving what its
 * LED *showed* pointing at the old component: assign Mute 7 to Mic 6 and the
 * LED stays dark, while muting Zoom — the button's previous target — still
 * lights it.
 *
 * A note button bound to a toggle already carries both halves of the answer:
 * the note to light and the control to watch. These tests pin that derivation,
 * so a mapping change during a show moves the LED with it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MappingEngine } from './mapping-engine.js'
import type { QrcClient } from './qrc-client.js'
import type { MidiIO } from './midi-io.js'
import type { Config, Mapping } from './config.js'

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

/** A config carrying `mappings` and an empty LED array — derivation is the only source. */
function configWith(mappings: Mapping[]): Config {
  return {
    qsys: { host: '127.0.0.1', port: 1710 },
    midi: { deviceName: 'MIDI Mix' },
    mappings,
    feedback: { enabled: true, mute_leds: [] },
  }
}

function build(mappings: Mapping[]) {
  const qrc = new FakeQrc()
  const midi = new FakeMidi()
  const config = configWith(mappings)
  const engine = new MappingEngine(qrc as unknown as QrcClient, midi as unknown as MidiIO, config)
  return { qrc, midi, engine, config }
}

/** A change pushed from the Core, as ChangeGroup AutoPoll delivers it. */
const push = (qrc: FakeQrc, component: string, control: string, value: number) =>
  qrc.emit('notification', 'mutes', {
    Id: 'mutes',
    Changes: [{ Component: component, Name: control, Value: value }],
  })

/**
 * Mute 7 as the hardware addresses it: the press arrives as CC ch1 cc28, and
 * the lamp lights on note 19. The two are different, so the lamp comes from
 * the physical control, not from the mapping's own MIDI address.
 */
const MUTE_7 = { type: 'cc', channel: 1, number: 28 } as const
const MUTE_7_LAMP = 19
/** Rec Arm 1: press arrives as CC ch3 cc22, lamp is note 3. */
const REC_ARM_1 = { type: 'cc', channel: 3, number: 22 } as const
const REC_ARM_1_LAMP = 3

const toggle = (midi: Mapping['midi'], component: string, link?: Mapping['qsys']['link']): Mapping => ({
  midi,
  qsys: { type: 'toggle', component, control: 'mute', ...(link ? { link } : {}) },
})

// ── derivation ───────────────────────────────────────────────────────────────

test('the LED lights for the component its own button is mapped to', () => {
  // Mute 7 reassigned to Mic 6 mid-production. Muting Mic 6 on the Core must
  // light Mute 7, with no feedback.mute_leds entry anywhere.
  const { qrc, midi } = build([toggle(MUTE_7, 'Mic.06.Gain')])
  push(qrc, 'Mic.06.Gain', 'mute', 1)
  assert.deepEqual(midi.sent, [`on 1:${MUTE_7_LAMP}`])
})

test('a component no button is mapped to drives no LED', () => {
  // Zoom moved off Mute 7, so muting Zoom must no longer light note 19.
  const { qrc, midi } = build([toggle(MUTE_7, 'Mic.06.Gain')])
  push(qrc, 'ZoomRX.Gain', 'mute', 1)
  assert.deepEqual(midi.sent, [])
})

test('a reassigned component lights its new button', () => {
  // Zoom mute moved down to Rec Arm 1: it lights note 3, never note 19.
  const { qrc, midi } = build([
    toggle(MUTE_7, 'Mic.06.Gain'),
    toggle(REC_ARM_1, 'ZoomRX.Gain'),
  ])
  push(qrc, 'ZoomRX.Gain', 'mute', 1)
  assert.deepEqual(midi.sent, [`on 1:${REC_ARM_1_LAMP}`])
})

test('clearing a mute on the Core clears the derived LED', () => {
  const { qrc, midi } = build([toggle(MUTE_7, 'Mic.06.Gain')])
  push(qrc, 'Mic.06.Gain', 'mute', 1)
  push(qrc, 'Mic.06.Gain', 'mute', 0)
  assert.deepEqual(midi.sent, [`on 1:${MUTE_7_LAMP}`, `off 1:${MUTE_7_LAMP}`])
})

test('a ganged toggle lights its LED from the primary target', () => {
  // The linked leg follows the primary; only the primary drives the lamp.
  const { qrc, midi } = build([
    toggle(MUTE_7, 'Styb.Gain', { component: 'Styb.Gain.R' }),
  ])
  push(qrc, 'Styb.Gain', 'mute', 1)
  push(qrc, 'Styb.Gain.R', 'mute', 1)
  assert.deepEqual(midi.sent, [`on 1:${MUTE_7_LAMP}`])
})

test('a fader mapping contributes no LED', () => {
  // A CC has no lamp to light; it must not register one.
  const { qrc, midi } = build([
    { midi: { type: 'cc', channel: 7, number: 22 }, qsys: { type: 'component_control', component: 'Mic.06.Gain', control: 'gain' } },
  ])
  push(qrc, 'Mic.06.Gain', 'gain', 1)
  assert.deepEqual(midi.sent, [])
})

// ── hot reload ───────────────────────────────────────────────────────────────

test('reassigning a button mid-show moves its LED without a restart', () => {
  const { qrc, midi, engine } = build([toggle(MUTE_7, 'ZoomRX.Gain')])
  engine.reload(configWith([toggle(MUTE_7, 'Mic.06.Gain')]))
  midi.sent.length = 0

  push(qrc, 'Mic.06.Gain', 'mute', 1)
  assert.deepEqual(midi.sent, [`on 1:${MUTE_7_LAMP}`])
})

test('reload darkens a lamp whose button no longer owns it', () => {
  // Note 19 is lit for Zoom. Reassigning Mute 7 to Mic 6 must clear it —
  // the Core will never push a Zoom change to turn it off again.
  const { qrc, midi, engine } = build([toggle(MUTE_7, 'ZoomRX.Gain')])
  push(qrc, 'ZoomRX.Gain', 'mute', 1)
  assert.deepEqual(midi.sent, [`on 1:${MUTE_7_LAMP}`])

  engine.reload(configWith([toggle(MUTE_7, 'Mic.06.Gain')]))
  assert.deepEqual(midi.sent, [`on 1:${MUTE_7_LAMP}`, `off 1:${MUTE_7_LAMP}`])
})

// ── ChangeGroup subscription ─────────────────────────────────────────────────

test('the ChangeGroup watches the components the buttons target', async () => {
  const { qrc, engine } = build([toggle(MUTE_7, 'Mic.06.Gain')])
  await engine.setupChangeGroup()

  const added = qrc.calls.filter((c) => c.method === 'ChangeGroup.AddComponentControl')
  assert.deepEqual(
    added.map((c) => (c.params as { Component: { Name: string } }).Component.Name),
    ['Mic.06.Gain'],
  )
})

test('re-subscribing destroys the previous group instead of adding to it', async () => {
  // AddComponentControl accumulates on a group id. Without a Destroy, the
  // component a button was reassigned away from stays subscribed forever.
  const { qrc, engine } = build([toggle(MUTE_7, 'ZoomRX.Gain')])
  await engine.setupChangeGroup()
  qrc.calls.length = 0

  engine.reload(configWith([toggle(MUTE_7, 'Mic.06.Gain')]))
  await engine.setupChangeGroup()

  const methods = qrc.calls.map((c) => c.method)
  assert.ok(methods.includes('ChangeGroup.Destroy'), 'expected the stale group to be destroyed')
  assert.ok(
    methods.indexOf('ChangeGroup.Destroy') < methods.indexOf('ChangeGroup.AddComponentControl'),
    'expected Destroy before re-subscribing',
  )
  const added = qrc.calls.filter((c) => c.method === 'ChangeGroup.AddComponentControl')
  assert.deepEqual(
    added.map((c) => (c.params as { Component: { Name: string } }).Component.Name),
    ['Mic.06.Gain'],
  )
})

test('feedback.enabled false still suppresses every LED', () => {
  const qrc = new FakeQrc()
  const midi = new FakeMidi()
  const config = configWith([toggle(MUTE_7, 'Mic.06.Gain')])
  config.feedback.enabled = false
  new MappingEngine(qrc as unknown as QrcClient, midi as unknown as MidiIO, config)

  push(qrc, 'Mic.06.Gain', 'mute', 1)
  assert.deepEqual(midi.sent, [])
})
