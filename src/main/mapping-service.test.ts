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

test('saveFollowRouterEnabled flips only the flag and leaves the rest of the config alone', async () => {
  const { saveFollowRouterEnabled, loadFollowRouter } = await import('./mapping-service.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-test-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    qsys: { host: 'h', port: 1710 }, midi: { deviceName: '' }, mappings: [], feedback: { enabled: false, mute_leds: [] },
    follow_router: { sources: { flex: { component: 'Flex.Inputs' } } },
  }))
  assert.equal(loadFollowRouter(configPath).enabled, false)
  saveFollowRouterEnabled(configPath, true)
  const cfg = loadFollowRouter(configPath)
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.sources.flex.component, 'Flex.Inputs')
  // Saving mappings afterwards must not drop the setting.
  saveMappings(configPath, [])
  assert.equal(loadFollowRouter(configPath).enabled, true)
  fs.rmSync(dir, { recursive: true, force: true })
})
