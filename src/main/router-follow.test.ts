import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveFollowConfig,
  gainRefForInput,
  routesFromControls,
  autoMapKnobA,
  parseCrosspoint,
  watchedCrosspoints,
} from './router-follow.js'
import type { Mapping } from './config.js'

const cfg = resolveFollowConfig({ enabled: true })

const knobA = (strip: number, control = 'channel.1.input.gain'): Mapping => ({
  label: `Knob A ${strip}`,
  midi: { type: 'cc', channel: 4, number: 21 + strip },
  qsys: { type: 'component_control', component: 'Analog.Inputs', control, min: -100, max: 20 },
})

test('analog input 3 maps to the analog preamp gain', () => {
  assert.deepEqual(gainRefForInput(3, cfg), {
    type: 'component_control', component: 'Analog.Inputs', control: 'channel.3.preamp.gain', min: -100, max: 20,
  })
})

test('flex input 9 maps to flex channel 1 preamp gain', () => {
  const ref = gainRefForInput(9, cfg)
  assert.equal(ref?.component, 'Flex.Input')
  assert.equal(ref?.control, 'channel.1.preamp.gain')
})

test('dante input 20 maps to dante channel 4 input gain', () => {
  const ref = gainRefForInput(20, cfg)
  assert.equal(ref?.component, 'Dante.Input')
  assert.equal(ref?.control, 'channel.4.input.gain')
})

test('a source with its component blanked out resolves to null', () => {
  const blank = resolveFollowConfig({ enabled: true, sources: { dante: { component: '' } } as never })
  assert.equal(gainRefForInput(20, blank), null)
  assert.equal(gainRefForInput(0, cfg), null)
  assert.equal(gainRefForInput(25, cfg), null)
})

test('routesFromControls keeps the true crosspoint per output and ignores outputs past 8', () => {
  const routes = routesFromControls([
    { Name: 'output.1.input.3.select', Value: true },
    { Name: 'output.1.input.4.select', Value: false },
    { Name: 'output.2.input.20.select', Value: 1 },
    { Name: 'output.9.input.1.select', Value: true },
    { Name: 'something.else', Value: true },
  ])
  assert.deepEqual([...routes], [[1, 3], [2, 20]])
})

test('parseCrosspoint', () => {
  assert.deepEqual(parseCrosspoint('output.4.input.17.select'), { output: 4, input: 17 })
  assert.equal(parseCrosspoint('output.4.input.17.mute'), null)
})

test('watchedCrosspoints covers 8 outputs x 24 inputs', () => {
  assert.equal(watchedCrosspoints().length, 192)
})

test('autoMapKnobA rewrites every routed strip and reports which changed', () => {
  const mappings = [knobA(1), knobA(2)]
  const res = autoMapKnobA(mappings, new Map([[1, 3], [2, 20]]), cfg)
  assert.deepEqual(res.changed, [1, 2])
  assert.equal(res.mappings[0].qsys.control, 'channel.3.preamp.gain')
  assert.equal(res.mappings[1].qsys.component, 'Dante.Input')
  assert.equal(res.mappings[1].label, 'Knob A 2')
})

test('autoMapKnobA with `only` leaves other strips alone', () => {
  const mappings = [knobA(1, 'manual.control'), knobA(2, 'manual.control')]
  const res = autoMapKnobA(mappings, new Map([[1, 3], [2, 4]]), cfg, [2])
  assert.deepEqual(res.changed, [2])
  assert.equal(res.mappings[0].qsys.control, 'manual.control')
  assert.equal(res.mappings[1].qsys.control, 'channel.4.preamp.gain')
})

test('autoMapKnobA is a no-op when the mapping already matches', () => {
  const first = autoMapKnobA([knobA(1)], new Map([[1, 3]]), cfg)
  const second = autoMapKnobA(first.mappings, new Map([[1, 3]]), cfg)
  assert.deepEqual(second.changed, [])
})

test('autoMapKnobA creates the mapping when the knob has none', () => {
  const res = autoMapKnobA([], new Map([[3, 5]]), cfg)
  assert.deepEqual(res.changed, [3])
  assert.deepEqual(res.mappings[0].midi, { type: 'cc', channel: 4, number: 24 })
})

test('autoMapKnobA skips unrouted strips and unconfigured sources, never touching them', () => {
  const mappings = [knobA(1, 'keep'), knobA(2, 'keep')]
  const res = autoMapKnobA(mappings, new Map([[2, 20]]), resolveFollowConfig({ enabled: true, sources: { dante: { component: '' } } as never }), [1, 2])
  assert.deepEqual(res.changed, [])
  assert.deepEqual(res.skipped.map((s) => s.strip), [1, 2])
  assert.match(res.skipped[1].reason, /dante component not configured/)
  assert.equal(res.mappings[1].qsys.control, 'keep')
})

test('autoMapKnobA does not mutate its input', () => {
  const mappings = [knobA(1)]
  autoMapKnobA(mappings, new Map([[1, 3]]), cfg)
  assert.equal(mappings[0].qsys.control, 'channel.1.input.gain')
})
