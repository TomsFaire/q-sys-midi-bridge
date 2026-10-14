/**
 * Bridge follow-router behaviour: coalesced + serialized remaps, the reconcile
 * after a (re)connect / follow-on / save, and the awaited reload.
 *
 * Runs the real Bridge and MappingEngine against a fake QRC client and fake
 * MIDI, with `electron` stubbed so config.json lives in a temp directory.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { EventEmitter } from 'node:events'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const route = (out: number, inp: number, value = 1) =>
  ({ Component: 'Input.Router', Name: `output.${out}.input.${inp}.select`, Value: value })

class FakeQrc extends EventEmitter {
  static last: FakeQrc
  isConnected = true
  lastError: string | null = null
  // What the Core's router currently says; a poll reports all of it, like the real thing.
  routes = new Map<number, number>()
  calls: Array<{ method: string; params: Any }> = []
  constructor() { super(); FakeQrc.last = this }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async call(method: string, params: Any): Promise<unknown> {
    this.calls.push({ method, params })
    if (method !== 'ChangeGroup.Poll') return {}
    return { Changes: [...this.routes].map(([o, i]) => route(o, i)) }
  }
  /** The Core changes some routes and pushes the news. */
  push(changes: Array<[number, number]>): void {
    for (const [o, i] of changes) this.routes.set(o, i)
    this.emit('notification', 'mutes', { Changes: changes.map(([o, i]) => route(o, i)) })
  }
}

class FakeMidi extends EventEmitter {
  isConnected = false
  connectedDeviceName = ''
  start() {}
  stop() {}
  sendNoteOn() {}
  sendNoteOff() {}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-remap-'))
const CONFIG = path.join(dir, 'config.json')

function loadBridge(): Any {
  const M = Module as Any
  const realLoad = M._load
  M._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return { app: { getPath: () => dir, getAppPath: () => dir } }
    if (request === './qrc-client.js') return { QrcClient: FakeQrc }
    if (request === './midi-io.js') return { MidiIO: FakeMidi }
    return realLoad.call(this, request, ...rest)
  }
  try {
    return require('./bridge.js')
  } finally {
    M._load = realLoad
  }
}
const { Bridge } = loadBridge()

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }

// Knob A N lives at channel 4, CC 21 + N.
const knobRow = (n: number, input: number) => {
  const group = Math.floor((input - 1) / 8)
  const idx = ((input - 1) % 8) + 1
  const comp = ['Analog.Inputs', 'Flex.Input', 'Dante.Input'][group]
  const ctl = group === 2 ? `channel.${idx}.input.gain` : `channel.${idx}.preamp.gain`
  return {
    label: `Knob A ${n}`,
    midi: { type: 'cc', channel: 4, number: 21 + n },
    qsys: { type: 'component_control', component: comp, control: ctl, min: -100, max: 20 },
  }
}

function writeConfig(follow: boolean, knobs: Array<[number, number]>) {
  fs.writeFileSync(CONFIG, JSON.stringify({
    qsys: { host: '127.0.0.1', port: 1710 },
    midi: { deviceName: '' },
    mappings: knobs.map(([n, input]) => knobRow(n, input)),
    feedback: { enabled: false },
    follow_router: { enabled: follow },
  }, null, 2))
}
const readKnobs = (): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).mappings) out[m.label] = m.qsys.control
  return out
}
/** A Bridge whose engine.reload calls are counted, connected and baselined on `routes`. */
async function build(routes: Array<[number, number]>, knobs: Array<[number, number]>) {
  writeConfig(true, knobs)
  const bridge: Any = new Bridge(JSON.parse(fs.readFileSync(CONFIG, 'utf-8')))
  const qrc = FakeQrc.last
  qrc.routes = new Map(routes)
  const stats = { reloads: 0 }
  const realReload = bridge.engine.reload.bind(bridge.engine)
  bridge.engine.reload = (cfg: Any) => { stats.reloads++; realReload(cfg) }
  qrc.emit('connect')
  await settle()
  return { bridge, qrc, stats }
}

test('three route changes in one push become one remap covering all three strips', async () => {
  const { qrc, stats } = await build([[1, 1], [2, 2], [3, 3]], [[1, 1], [2, 2], [3, 3]])
  const before = stats.reloads
  qrc.push([[1, 9], [2, 10], [3, 11]])
  await settle()
  assert.equal(stats.reloads - before, 1)
  assert.deepEqual(readKnobs(), {
    'Knob A 1': 'channel.1.preamp.gain',
    'Knob A 2': 'channel.2.preamp.gain',
    'Knob A 3': 'channel.3.preamp.gain',
  })
  const m = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).mappings
  assert.deepEqual(m.map((x: Any) => x.qsys.component), ['Flex.Input', 'Flex.Input', 'Flex.Input'])
})

test('remaps never overlap: a second push waits for the first remap to finish', async () => {
  const { bridge, qrc } = await build([[1, 1], [2, 2]], [[1, 1], [2, 2]])
  const realApply = bridge.applyAutoMap.bind(bridge)
  let active = 0
  let peak = 0
  const calls: number[][] = []
  bridge.applyAutoMap = async (routes: Map<number, number>, only?: number[]) => {
    active++
    peak = Math.max(peak, active)
    calls.push(only ?? [])
    await new Promise((r) => setTimeout(r, 15))
    try { return await realApply(routes, only) } finally { active-- }
  }
  qrc.push([[1, 17]])
  await new Promise((r) => setTimeout(r, 2))
  qrc.push([[2, 18]])
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(peak, 1)
  assert.deepEqual(calls, [[1], [2]])
  assert.equal(readKnobs()['Knob A 1'], 'channel.1.input.gain')
  assert.equal(readKnobs()['Knob A 2'], 'channel.2.input.gain')
})

test('a remap failure is logged and does not break later remaps', async () => {
  const { bridge, qrc } = await build([[1, 1]], [[1, 1]])
  const realApply = bridge.applyAutoMap.bind(bridge)
  let first = true
  bridge.applyAutoMap = async (...args: Any[]) => {
    if (first) { first = false; throw new Error('disk full') }
    return realApply(...args)
  }
  const realErr = console.error
  console.error = () => {}
  try {
    qrc.push([[1, 2]])
    await settle()
    qrc.push([[1, 3]])
    await settle()
  } finally { console.error = realErr }
  assert.equal(readKnobs()['Knob A 1'], 'channel.3.preamp.gain')
})

test('a reconnect re-baselines and reconciles a Knob A that went stale while the Core link was down', async () => {
  const { qrc } = await build([[1, 3]], [[1, 1]])
  assert.equal(readKnobs()['Knob A 1'], 'channel.3.preamp.gain', 'initial baseline reconciles')
  // Routing changes while disconnected: nothing was watching.
  qrc.routes.set(1, 5)
  qrc.emit('disconnect', 'gone')
  qrc.emit('connect')
  await settle()
  assert.equal(readKnobs()['Knob A 1'], 'channel.5.preamp.gain')
})

test('reconcile is idempotent: an aligned config is neither written nor reloaded, and nothing loops', async () => {
  const { bridge, qrc, stats } = await build([[1, 3], [2, 4]], [[1, 3], [2, 4]])
  const reloads = stats.reloads
  const mtime = fs.statSync(CONFIG).mtimeMs
  const text = fs.readFileSync(CONFIG, 'utf-8')
  qrc.emit('connect')
  await settle()
  assert.equal(stats.reloads, reloads)
  assert.equal(fs.readFileSync(CONFIG, 'utf-8'), text)
  assert.equal(fs.statSync(CONFIG).mtimeMs, mtime)
  // A plain reload costs exactly its own reload, no reconcile-driven second one.
  await bridge.reloadConfig()
  await settle()
  assert.equal(stats.reloads, reloads + 1)
  assert.equal(fs.readFileSync(CONFIG, 'utf-8'), text)
})

test('reloadConfig after a save with a stale Knob A row rewrites it, and the awaited result is final', async () => {
  const { bridge, stats } = await build([[1, 3]], [[1, 3]])
  // A mapping editor left open posts its old row back.
  writeConfig(true, [[1, 1]])
  const before = stats.reloads
  await bridge.reloadConfig()
  // No settle: the file is already right the moment the await resolves.
  assert.equal(readKnobs()['Knob A 1'], 'channel.3.preamp.gain')
  const settled = fs.readFileSync(CONFIG, 'utf-8')
  await settle()
  assert.equal(fs.readFileSync(CONFIG, 'utf-8'), settled)
  assert.equal(stats.reloads - before, 2, 'the save reload plus the one rewrite')
})

test('reloadConfig does not reconcile before the routes are known', async () => {
  writeConfig(true, [[1, 1]])
  const bridge: Any = new Bridge(JSON.parse(fs.readFileSync(CONFIG, 'utf-8')))
  const text = fs.readFileSync(CONFIG, 'utf-8')
  await bridge.reloadConfig()
  assert.equal(fs.readFileSync(CONFIG, 'utf-8'), text)
})

test('turning follow on baselines the routes and reconciles Knob A', async () => {
  writeConfig(false, [[1, 1], [2, 2]])
  const bridge: Any = new Bridge(JSON.parse(fs.readFileSync(CONFIG, 'utf-8')))
  const qrc = FakeQrc.last
  qrc.routes = new Map([[1, 9], [2, 2]])
  await bridge.setFollowRouter(true)
  await settle()
  assert.deepEqual(readKnobs(), { 'Knob A 1': 'channel.1.preamp.gain', 'Knob A 2': 'channel.2.preamp.gain' })
  const m = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).mappings
  assert.equal(m[0].qsys.component, 'Flex.Input')
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).follow_router.enabled, true)
})
