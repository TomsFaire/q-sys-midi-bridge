import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  getMappingsRevision,
  loadMappings,
  patchConfig,
  saveMappingsIfFresh,
  saveAndApplyMappingsIfFresh,
  StaleMappingsError,
} from './mapping-service.js'
import type { Mapping } from './config.js'

const row = (number: number): Mapping => ({
  midi: { type: 'cc', channel: 1, number },
  qsys: { type: 'toggle', component: 'Mixer', control: `mute.${number}` },
}) as Mapping

function setup(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-rev-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ qsys: { host: '', port: 1710 }, mappings: [row(1)] }))
  return configPath
}

test('a matching revision saves and returns the new revision', () => {
  const configPath = setup()
  const rev = getMappingsRevision(configPath)
  const next = saveMappingsIfFresh(configPath, [row(2)], rev)
  assert.deepEqual(loadMappings(configPath), [row(2)])
  assert.equal(next, getMappingsRevision(configPath))
  assert.notEqual(next, rev)
  // The returned revision lets the window save again without reloading.
  saveMappingsIfFresh(configPath, [row(3)], next)
  assert.deepEqual(loadMappings(configPath), [row(3)])
})

test('a stale or missing revision is rejected and nothing is written', () => {
  const configPath = setup()
  const before = fs.readFileSync(configPath, 'utf-8')
  patchConfig(configPath, { mappings: [row(9)] })
  const afterChange = fs.readFileSync(configPath, 'utf-8')
  assert.notEqual(before, afterChange)
  const stale = getMappingsRevision(configPath) + 'x'
  assert.throws(() => saveMappingsIfFresh(configPath, [row(2)], stale), StaleMappingsError)
  assert.throws(() => saveMappingsIfFresh(configPath, [row(2)], undefined), StaleMappingsError)
  assert.equal(fs.readFileSync(configPath, 'utf-8'), afterChange)
})

test('show recall then save from a stale window does not revert the show or reload', async () => {
  const configPath = setup()
  // Window opens and remembers the revision it loaded with.
  const windowRevision = getMappingsRevision(configPath)
  // Operator recalls a show from the tray: mappings and activeShow change together.
  patchConfig(configPath, { mappings: [row(40), row(41)], activeShow: { id: 's1', name: 'Show 1' } })
  const recalled = fs.readFileSync(configPath, 'utf-8')

  assert.throws(() => saveMappingsIfFresh(configPath, [row(1)], windowRevision), StaleMappingsError)
  let reloads = 0
  await assert.rejects(
    saveAndApplyMappingsIfFresh(configPath, [row(1)], windowRevision, async () => { reloads++ }),
    StaleMappingsError,
  )
  assert.equal(reloads, 0)
  assert.equal(fs.readFileSync(configPath, 'utf-8'), recalled)
})

test('a fresh save-and-apply writes, reloads, and returns the post-write revision', async () => {
  const configPath = setup()
  let reloads = 0
  const next = await saveAndApplyMappingsIfFresh(
    configPath, [row(5)], getMappingsRevision(configPath), async () => { reloads++ })
  assert.equal(reloads, 1)
  assert.deepEqual(loadMappings(configPath), [row(5)])
  assert.equal(next, getMappingsRevision(configPath))
})
