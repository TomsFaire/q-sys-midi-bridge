import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { MappingEngine } from './mapping-engine.js'
import type { Config } from './config.js'

class FakeQrc extends EventEmitter {
  isConnected = true
  calls: Array<{ method: string; params: any }> = []
  pollResult: unknown = { Changes: [] }
  async call(method: string, params: any): Promise<unknown> {
    this.calls.push({ method, params })
    return method === 'ChangeGroup.Poll' ? this.pollResult : {}
  }
}

const fakeMidi = { sendNoteOn() {}, sendNoteOff() {} }

const config = (enabled: boolean): Config => ({
  qsys: { host: 'x', port: 1710 },
  midi: { deviceName: '' },
  mappings: [],
  feedback: { enabled: true, mute_leds: [{ component: 'Mic.01.Gain', control: 'mute', midi: { channel: 1, note: 1 } }] },
  follow_router: { enabled },
})

const route = (out: number, inp: number, value = 1) =>
  ({ Component: 'Input.Router', Name: `output.${out}.input.${inp}.select`, Value: value })

function setup(enabled: boolean) {
  const qrc = new FakeQrc()
  const engine = new MappingEngine(qrc as never, fakeMidi as never, config(enabled))
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
  cfg.feedback = { enabled: false, mute_leds: [] }
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
