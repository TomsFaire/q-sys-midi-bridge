import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MappingEngine } from './mapping-engine.js'
import type { Config, Mapping } from './config.js'
import { valueToCc } from './pickup.js'

class FakeQrc extends EventEmitter {
  isConnected = true
  calls: Array<{ method: string; params: any }> = []
  pollResult: unknown = { Changes: [] }
  // Hold ChangeGroup.Poll open to look at the engine mid-rebuild.
  pollHold: Promise<void> | null = null
  // Component.Get answers, keyed "component:control"; failGet makes it reject.
  values: Record<string, number> = {}
  failGet = false
  async call(method: string, params: any): Promise<unknown> {
    this.calls.push({ method, params })
    if (method === 'ChangeGroup.Poll') {
      if (this.pollHold) await this.pollHold
      return this.pollResult
    }
    if (method === 'Component.Get') {
      if (this.failGet) throw new Error('get failed')
      const name = params.Controls[0].Name
      const v = this.values[`${params.Name}:${name}`]
      return v === undefined ? {} : { Name: params.Name, Controls: [{ Name: name, Value: v }] }
    }
    return {}
  }
}

const fakeMidi = { sendNoteOn() {}, sendNoteOff() {} }

const config = (enabled: boolean, extra: Mapping[] = []): Config => ({
  qsys: { host: 'x', port: 1710 },
  midi: { deviceName: '' },
  // Mute 1's lamp is derived from this mapping (feedback.mute_leds is ignored).
  mappings: [{ midi: { type: 'cc', channel: 1, number: 22 }, qsys: { type: 'toggle', component: 'Mic.01.Gain', control: 'mute' } }, ...extra],
  feedback: { enabled: true },
  follow_router: { enabled },
})

const route = (out: number, inp: number, value = 1) =>
  ({ Component: 'Input.Router', Name: `output.${out}.input.${inp}.select`, Value: value })

function setup(enabled: boolean, extra: Mapping[] = []) {
  const qrc = new FakeQrc()
  const engine = new MappingEngine(qrc as never, fakeMidi as never, config(enabled, extra))
  const fired: Array<[number, number]> = []
  engine.onRouteChange = (strip, input) => fired.push([strip, input])
  return { qrc, engine, fired }
}

test('when enabled, router crosspoints join the existing change group and no new group is made', async () => {
  const { qrc, engine } = setup(true)
  await engine.setupChangeGroup()
  const ids = new Set(qrc.calls.map((c) => c.params.Id))
  assert.deepEqual([...ids], ['mutes'])
  const router = qrc.calls.find((c) => c.params.Component?.Name === 'Input.Router')
  assert.equal(router?.params.Component.Controls.length, 192)
})

test('when disabled, no router controls are subscribed and route changes are ignored', async () => {
  const { qrc, engine, fired } = setup(false)
  await engine.setupChangeGroup()
  assert.equal(qrc.calls.some((c) => c.params.Component?.Name === 'Input.Router'), false)
  qrc.emit('notification', 'mutes', { Changes: [route(1, 20)] })
  assert.deepEqual(fired, [])
})

test('the first poll is a baseline: it records routes but does not fire', async () => {
  const { qrc, engine, fired } = setup(true)
  qrc.pollResult = { Changes: [route(1, 3), route(2, 20)] }
  await engine.setupChangeGroup()
  assert.deepEqual(fired, [])
  assert.deepEqual([...engine.getRoutes()], [[1, 3], [2, 20]])
})

test('a later route change fires once for that strip only; the old crosspoint going off is ignored', async () => {
  const { qrc, engine, fired } = setup(true)
  qrc.pollResult = { Changes: [route(1, 3), route(2, 20)] }
  await engine.setupChangeGroup()
  qrc.emit('notification', 'mutes', { Changes: [route(1, 3, 0), route(1, 17, 1)] })
  assert.deepEqual(fired, [[1, 17]])
  // Re-reporting the same route does not fire again.
  qrc.emit('notification', 'mutes', { Changes: [route(1, 17, 1)] })
  assert.deepEqual(fired, [[1, 17]])
})

test('router changes still work when mute-LED feedback is disabled', async () => {
  const qrc = new FakeQrc()
  const cfg = config(true)
  cfg.feedback = { enabled: false }
  const engine = new MappingEngine(qrc as never, fakeMidi as never, cfg)
  const fired: Array<[number, number]> = []
  engine.onRouteChange = (s, i) => fired.push([s, i])
  await engine.setupChangeGroup()
  qrc.emit('notification', 'mutes', { Changes: [route(4, 9)] })
  assert.deepEqual(fired, [[4, 9]])
})

test('reload picks up a toggled follow_router setting', async () => {
  const { qrc, engine, fired } = setup(false)
  engine.reload(config(true))
  await engine.setupChangeGroup()
  qrc.emit('notification', 'mutes', { Changes: [route(1, 5)] })
  assert.deepEqual(fired, [[1, 5]])
})

test('router crosspoints are route state: they stay out of toggleState, lamps still land there', async () => {
  const { qrc, engine } = setup(true)
  await engine.setupChangeGroup()
  qrc.emit('notification', 'mutes', { Changes: [route(1, 3), { Component: 'Mic.01.Gain', Name: 'mute', Value: 1 }] })
  const state = (engine as any).toggleState as Map<string, number>
  assert.equal(state.has('Input.Router:output.1.input.3.select'), false)
  assert.equal(state.get('Mic.01.Gain:mute'), 1)
})

test('a change-group rebuild does not reset the baseline: a push arriving mid-rebuild still fires', async () => {
  const { qrc, engine, fired } = setup(true)
  qrc.pollResult = { Changes: [route(1, 3)] }
  await engine.setupChangeGroup()
  assert.equal(engine.routesKnown, true)
  let release!: () => void
  qrc.pollHold = new Promise<void>((r) => { release = r })
  const rebuild = engine.setupChangeGroup()
  await settle()
  assert.equal(engine.routesKnown, true)
  qrc.emit('notification', 'mutes', { Changes: [route(1, 3, 0), route(1, 9), route(2, 4), route(3, 5)] })
  assert.deepEqual(fired, [[1, 9], [2, 4], [3, 5]])
  release()
  await rebuild
  assert.equal(engine.routesKnown, true)
})

test('a rebuild neither re-fires onBaselined nor disarms a picked-up knob; a fresh baseline does', async () => {
  const { qrc, engine } = setup(true, [knob()])
  qrc.values[KNOB_REF] = -52
  let baselined = 0
  engine.onBaselined = () => { baselined++ }
  await engine.setupChangeGroup()
  assert.equal(baselined, 1)
  await settle()
  engine.handleCC(4, 24, 51)
  await settle()
  await engine.setupChangeGroup()
  assert.equal(baselined, 1)
  engine.handleCC(4, 24, 120)
  await settle()
  assert.equal(sets(qrc).length, 2, 'knob stayed armed through the rebuild')
  engine.resetRouteBaseline()
  assert.equal(engine.routesKnown, false)
  assert.deepEqual([...engine.getRoutes()], [])
  await engine.setupChangeGroup()
  assert.equal(baselined, 2)
})

test('turning follow on resets the baseline; turning it off clears routes', async () => {
  const { qrc, engine, fired } = setup(false)
  qrc.pollResult = { Changes: [route(1, 3)] }
  engine.reload(config(true))
  assert.equal(engine.routesKnown, false)
  await engine.setupChangeGroup()
  assert.equal(engine.routesKnown, true)
  assert.deepEqual(fired, [])
  engine.reload(config(false))
  assert.equal(engine.routesKnown, false)
  assert.deepEqual([...engine.getRoutes()], [])
})

// ── Soft takeover ────────────────────────────────────────────────────────────

const settle = () => new Promise<void>((r) => setImmediate(r))
const KNOB_REF = 'Analog.Inputs:channel.3.preamp.gain'
const knob = (control = 'channel.3.preamp.gain'): Mapping => ({
  label: 'Knob A 3',
  midi: { type: 'cc', channel: 4, number: 24 },
  qsys: { type: 'component_control', component: 'Analog.Inputs', control, min: -100, max: 20 },
})
const sets = (qrc: FakeQrc) => qrc.calls.filter((c) => c.method === 'Component.Set')
const gets = (qrc: FakeQrc) => qrc.calls.filter((c) => c.method === 'Component.Get')

async function armed(extra: Mapping[] = [knob()]) {
  const s = setup(true, extra)
  s.qrc.values[KNOB_REF] = -52
  await s.engine.setupChangeGroup()
  await settle()
  return s
}
const TARGET = valueToCc(-52, -100, 20)

test('soft takeover: a far CC is dropped with no Component.Set; arriving near the target applies it', async () => {
  const { qrc, engine } = await armed()
  engine.handleCC(4, 24, 120)
  engine.handleCC(4, 24, 110)
  await settle()
  assert.equal(sets(qrc).length, 0)
  engine.handleCC(4, 24, TARGET + 1)
  await settle()
  assert.equal(sets(qrc).length, 1)
  assert.equal(sets(qrc)[0].params.Name, 'Analog.Inputs')
  // Picked up: later CCs flow without further gating.
  engine.handleCC(4, 24, 5)
  await settle()
  assert.equal(sets(qrc).length, 2)
})

test('soft takeover: sweeping across the target applies the CC', async () => {
  const { qrc, engine } = await armed()
  engine.handleCC(4, 24, 5)
  engine.handleCC(4, 24, 10)
  await settle()
  assert.equal(sets(qrc).length, 0)
  engine.handleCC(4, 24, 120)
  await settle()
  assert.equal(sets(qrc).length, 1)
})

test('soft takeover: a remap (target changed in reload) disarms and re-reads; an unchanged reload does not', async () => {
  const { qrc, engine } = await armed()
  engine.handleCC(4, 24, TARGET)
  await settle()
  assert.equal(sets(qrc).length, 1)
  const reads = gets(qrc).length
  engine.reload(config(true, [knob()]))
  assert.equal(gets(qrc).length, reads)
  engine.handleCC(4, 24, 100)
  await settle()
  assert.equal(sets(qrc).length, 2)

  qrc.values['Analog.Inputs:channel.4.preamp.gain'] = 0
  engine.reload(config(true, [knob('channel.4.preamp.gain')]))
  await settle()
  assert.equal(gets(qrc).length, reads + 1)
  engine.handleCC(4, 24, TARGET)
  await settle()
  assert.equal(sets(qrc).length, 2, 'old position is nowhere near the new target')
  engine.handleCC(4, 24, valueToCc(0, -100, 20))
  await settle()
  assert.equal(sets(qrc).length, 3)
})

test('soft takeover: a (re)connect disarms every follow-managed knob', async () => {
  const { qrc, engine } = await armed()
  engine.handleCC(4, 24, TARGET)
  await settle()
  assert.equal(sets(qrc).length, 1)
  engine.resetRouteBaseline()
  engine.handleCC(4, 24, 100)
  await settle()
  assert.equal(sets(qrc).length, 1)
})

test('soft takeover is bypassed while follow is off, and re-enabling starts disarmed', async () => {
  const { qrc, engine } = await armed()
  engine.reload(config(false, [knob()]))
  engine.handleCC(4, 24, 120)
  await settle()
  assert.equal(sets(qrc).length, 1)
  engine.reload(config(true, [knob()]))
  engine.handleCC(4, 24, 120)
  await settle()
  assert.equal(sets(qrc).length, 1, 'disarmed again after off -> on')
})

test('soft takeover never gates anything but Knob A, nor a stereo-linked Knob A', async () => {
  const fader: Mapping = {
    midi: { type: 'cc', channel: 1, number: 19 },
    qsys: { type: 'component_control', component: 'Mic.01.Gain', control: 'gain', min: 0, max: 1 },
  }
  const linked = knob()
  linked.qsys.link = { control: 'channel.4.preamp.gain' }
  const { qrc, engine } = await armed([fader, linked])
  engine.handleCC(1, 19, 127)
  engine.handleCC(4, 24, 127)
  await settle()
  assert.equal(sets(qrc).length, 2)
})

test('soft takeover: a failed read keeps dropping CCs and retries at most every 500 ms', async () => {
  const qrc = new FakeQrc()
  qrc.failGet = true
  qrc.values[KNOB_REF] = -52
  const engine = new MappingEngine(qrc as never, fakeMidi as never, config(true, [knob()]))
  let t = 10_000
  ;(engine as any).now = () => t
  await engine.setupChangeGroup()
  await settle()
  const base = gets(qrc).length
  assert.equal(base, 1)
  t += 100
  engine.handleCC(4, 24, 120)
  await settle()
  assert.equal(gets(qrc).length, base)
  t += 500
  engine.handleCC(4, 24, 121)
  engine.handleCC(4, 24, 122)
  await settle()
  assert.equal(gets(qrc).length, base + 1)
  assert.equal(sets(qrc).length, 0)
  // The Core answers again: the retry learns the target, but this CC is still dropped.
  qrc.failGet = false
  t += 600
  engine.handleCC(4, 24, 123)
  await settle()
  assert.equal(gets(qrc).length, base + 2)
  assert.equal(sets(qrc).length, 0)
  engine.handleCC(4, 24, TARGET)
  await settle()
  assert.equal(sets(qrc).length, 1)
})

test('soft takeover logs the move-to hint once per disarm, not once per CC', async () => {
  const { engine } = await armed()
  const hint = () => engine.getRecentActivity().filter((l) => l.startsWith('Knob A 3 — move to about'))
  for (const v of [120, 110, 100, 90]) engine.handleCC(4, 24, v)
  assert.deepEqual(hint(), [`Knob A 3 — move to about ${TARGET}/127 to take over`])
  engine.handleCC(4, 24, TARGET)
  await settle()
  engine.reload(config(true, [knob('channel.4.preamp.gain')]))
  engine.handleCC(4, 24, 120)
  await settle()
  engine.handleCC(4, 24, 121)
  assert.equal(hint().length, 1, 'new target not read yet, so nothing to announce')
})
