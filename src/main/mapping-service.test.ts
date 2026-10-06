import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateMappings, loadMappings, saveMappings } from './mapping-service.js'

test('validateMappings accepts a well-formed mappings array', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 22 }, qsys: { type: 'toggle', component: 'Input.Mixer', control: 'input.1.mute' } },
  ])
  assert.equal(result.valid, true)
})

test('validateMappings rejects a non-array payload', () => {
  const result = validateMappings({ not: 'an array' })
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.errors[0].reason, 'mappings must be an array')
})

test('validateMappings rejects an unknown qsys.type', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 22 }, qsys: { type: 'not_a_real_type' } },
  ])
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.errors.length, 1)
})

test('validateMappings rejects a malformed midi block', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 'one', number: 22 }, qsys: { type: 'toggle', component: 'X', control: 'y' } },
  ])
  assert.equal(result.valid, false)
})

test('saveMappings then loadMappings round-trips through a real config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-test-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    qsys: { host: '', port: 1710 },
    midi: { deviceName: '' },
    mappings: [],
    feedback: { enabled: false, mute_leds: [] },
  }))

  const mappings = [{ midi: { type: 'cc' as const, channel: 1, number: 22 }, qsys: { type: 'toggle' as const, component: 'X', control: 'y' } }]
  saveMappings(configPath, mappings)

  const loaded = loadMappings(configPath)
  assert.deepEqual(loaded, mappings)

  fs.rmSync(dir, { recursive: true, force: true })
})

// ── qsys.link (stereo gang) ──────────────────────────────────────────────────

test('validateMappings accepts a link naming only a component', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 4, number: 22 },
      qsys: { type: 'component_control', component: 'Dante.In.9.Gain', control: 'gain', link: { component: 'Dante.In.10.Gain' } } },
  ])
  assert.equal(result.valid, true)
})

test('validateMappings accepts a link naming only a control', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 4, number: 22 },
      qsys: { type: 'component_control', component: 'Dante.Pair.Gain', control: 'gain.1', link: { control: 'gain.2' } } },
  ])
  assert.equal(result.valid, true)
})

test('validateMappings rejects a link with neither component nor control', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 4, number: 22 },
      qsys: { type: 'component_control', component: 'A.Gain', control: 'gain', link: {} } },
  ])
  assert.equal(result.valid, false)
})

test('validateMappings rejects a link on a snapshot mapping', () => {
  const result = validateMappings([
    { midi: { type: 'note_on', channel: 1, number: 25 },
      qsys: { type: 'snapshot', bank: 1, slot: 1, link: { component: 'A.Gain' } } },
  ])
  assert.equal(result.valid, false)
})

test('validateMappings rejects a link on a named_control mapping', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 4, number: 22 },
      qsys: { type: 'named_control', name: 'MasterGain', link: { control: 'other' } } },
  ])
  assert.equal(result.valid, false)
})

// ── X-Touch: pitch-bend faders and relative encoders ─────────────────────────

test('validateMappings accepts a pitchbend mapping, which carries no note number', () => {
  const result = validateMappings([
    { midi: { type: 'pitchbend', channel: 1 },
      qsys: { type: 'component_control', component: 'Mic.01.Gain', control: 'gain', min: -100, max: 20 } },
  ])
  assert.equal(result.valid, true)
})

test('validateMappings rejects a pitchbend mapping with no channel', () => {
  const result = validateMappings([
    { midi: { type: 'pitchbend' },
      qsys: { type: 'component_control', component: 'Mic.01.Gain', control: 'gain' } },
  ])
  assert.equal(result.valid, false)
})

test('validateMappings accepts a relative encoder mapping with a step', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 16 },
      qsys: { type: 'component_control_relative', component: 'Mic.01.Gain', control: 'gain', step: 0.5, min: -18, max: 18 } },
  ])
  assert.equal(result.valid, true)
})

test('validateMappings rejects a relative mapping whose step is not a positive number', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 16 },
      qsys: { type: 'component_control_relative', component: 'A.Gain', control: 'gain', step: 0 } },
  ])
  assert.equal(result.valid, false)
  // Rejected for the step, not because the type is unrecognised.
  if (!result.valid) assert.match(result.errors[0].reason, /step/)
})

test('validateMappings still rejects a cc mapping with no number', () => {
  // Only pitchbend is exempt — a CC without a number is still malformed.
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1 }, qsys: { type: 'toggle', component: 'X', control: 'y' } },
  ])
  assert.equal(result.valid, false)
})

test('validateMappings rejects an encoder encoding it does not know', () => {
  // A typo here would silently fall back to a default and turn the wrong way.
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 16 },
      qsys: { type: 'component_control_relative', component: 'A.Gain', control: 'gain', encoding: 'backwards' } },
  ])
  assert.equal(result.valid, false)
  if (!result.valid) assert.match(result.errors[0].reason, /encoding/)
})

test('validateMappings accepts both encodings it knows', () => {
  for (const encoding of ['mcu', 'signed']) {
    const result = validateMappings([
      { midi: { type: 'cc', channel: 1, number: 16 },
        qsys: { type: 'component_control_relative', component: 'A.Gain', control: 'gain', encoding } },
    ])
    assert.equal(result.valid, true, `${encoding} should be valid`)
  }
})

test('validateMappings accepts a link on a relative encoder, which the engine gangs', () => {
  // The engine resolves link targets for component_control_relative, so
  // rejecting it here would fail the whole save for a config that works.
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 16 },
      qsys: { type: 'component_control_relative', component: 'Dante.In.9.Gain', control: 'gain',
              step: 0.5, link: { component: 'Dante.In.10.Gain' } } },
  ])
  assert.equal(result.valid, true)
})
