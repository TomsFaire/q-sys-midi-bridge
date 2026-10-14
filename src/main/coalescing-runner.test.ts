/**
 * The Bridge funnels every setupChangeGroup through a CoalescingRunner. These
 * pin the two guarantees that matter against a Core that answers slowly: runs
 * never overlap, and a burst collapses to one trailing run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CoalescingRunner } from './coalescing-runner.js'

/** A fake engine whose setupChangeGroup stays open until the test releases it. */
function fakeEngine() {
  const log: string[] = []
  const gates: Array<() => void> = []
  let active = 0
  let maxActive = 0
  let runs = 0
  return {
    log,
    get maxActive() { return maxActive },
    get runs() { return runs },
    release: () => gates.shift()?.(),
    async setupChangeGroup() {
      const n = ++runs
      active++; maxActive = Math.max(maxActive, active)
      log.push(`start ${n}`)
      await new Promise<void>((r) => gates.push(r))
      log.push(`end ${n}`)
      active--
    },
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r))

test('three rapid requests run sequentially and coalesce into one trailing run', async () => {
  const engine = fakeEngine()
  const runner = new CoalescingRunner(() => engine.setupChangeGroup())
  const none = () => {}

  const a = runner.request(none)
  const b = runner.request(none)
  const c = runner.request(none)
  await tick()
  assert.deepEqual(engine.log, ['start 1'], 'only the first run has started')

  engine.release()
  await tick(); await tick()
  assert.deepEqual(engine.log, ['start 1', 'end 1', 'start 2'], 'the trailing run starts after the first ends')

  engine.release()
  await Promise.all([a, b, c])
  assert.equal(engine.runs, 2, 'b and c share one trailing run')
  assert.equal(engine.maxActive, 1, 'runs never overlap')
})

test('a request after the queue drains starts a fresh run', async () => {
  const engine = fakeEngine()
  const runner = new CoalescingRunner(() => engine.setupChangeGroup())
  const first = runner.request(() => {})
  engine.release(); await first
  const second = runner.request(() => {})
  await tick()
  engine.release(); await second
  assert.equal(engine.runs, 2)
})

test('a failing run is reported and does not block the trailing run', async () => {
  const errors: string[] = []
  let n = 0
  const runner = new CoalescingRunner(async () => { if (++n === 1) throw new Error('boom') })
  const a = runner.request((e) => errors.push(e.message))
  const b = runner.request((e) => errors.push(e.message))
  await Promise.all([a, b])
  assert.deepEqual(errors, ['boom'])
  assert.equal(n, 2)
})
