import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PickupGate, THRESHOLD, valueToCc } from './pickup.js'

const scale = (cc: number, min: number, max: number) => min + (cc / 127) * (max - min)

test('valueToCc inverts scale() for every CC, including -100..20', () => {
  for (const [min, max] of [[0, 1], [-100, 20]]) {
    for (let cc = 0; cc <= 127; cc++) assert.equal(valueToCc(scale(cc, min, max), min, max), cc)
  }
})

test('valueToCc clamps out-of-range values and handles a degenerate range', () => {
  assert.equal(valueToCc(-100, -100, 20), 0)
  assert.equal(valueToCc(20, -100, 20), 127)
  assert.equal(valueToCc(50, -100, 20), 127)
  assert.equal(valueToCc(-500, -100, 20), 0)
  assert.equal(valueToCc(3, 5, 5), 0)
})

test('a key that was never disarmed is armed', () => {
  const g = new PickupGate()
  assert.equal(g.isArmed('a'), true)
  assert.equal(g.accept('a', 77), true)
  assert.equal(g.pendingTarget('a'), null)
})

test('a far-away knob stays ignored', () => {
  const g = new PickupGate()
  g.disarm('a', 100)
  assert.equal(g.isArmed('a'), false)
  assert.equal(g.pendingTarget('a'), 100)
  for (const cc of [0, 10, 20, 30, 40]) assert.equal(g.accept('a', cc), false)
  assert.equal(g.isArmed('a'), false)
})

test('arriving within the threshold arms, and that CC is applied', () => {
  const g = new PickupGate()
  g.disarm('a', 100)
  assert.equal(g.accept('a', 50), false)
  assert.equal(g.accept('a', 100 - THRESHOLD - 1), false)
  assert.equal(g.accept('a', 100 - THRESHOLD), true)
  assert.equal(g.isArmed('a'), true)
  assert.equal(g.pendingTarget('a'), null)
})

test('a big upward jump across the target arms', () => {
  const g = new PickupGate()
  g.disarm('a', 60)
  assert.equal(g.accept('a', 10), false)
  assert.equal(g.accept('a', 120), true)
  assert.equal(g.isArmed('a'), true)
})

test('a big downward jump across the target arms', () => {
  const g = new PickupGate()
  g.disarm('a', 60)
  assert.equal(g.accept('a', 120), false)
  assert.equal(g.accept('a', 5), true)
  assert.equal(g.isArmed('a'), true)
})

test('hitting the target exactly arms', () => {
  const g = new PickupGate()
  g.disarm('a', 60)
  assert.equal(g.accept('a', 10), false)
  assert.equal(g.accept('a', 60), true)
})

test('once armed it stays armed, wherever the knob goes', () => {
  const g = new PickupGate()
  g.disarm('a', 60)
  assert.equal(g.accept('a', 61), true)
  for (const cc of [0, 127, 3, 90]) assert.equal(g.accept('a', cc), true)
})

test('re-disarming blocks again and forgets the previous sweep position', () => {
  const g = new PickupGate()
  g.disarm('a', 60)
  g.accept('a', 60)
  g.disarm('a', 20)
  assert.equal(g.isArmed('a'), false)
  assert.equal(g.pendingTarget('a'), 20)
  // 100 is on the same side as the first CC after re-disarm; no stale crossing from before.
  assert.equal(g.accept('a', 100), false)
  assert.equal(g.accept('a', 90), false)
})

test('a null target blocks until setTarget, then behaves normally', () => {
  const g = new PickupGate()
  g.disarm('a', null)
  assert.equal(g.isArmed('a'), false)
  assert.equal(g.pendingTarget('a'), null)
  assert.equal(g.accept('a', 64), false)
  assert.equal(g.accept('a', 30), false)
  g.setTarget('a', 80)
  assert.equal(g.pendingTarget('a'), 80)
  assert.equal(g.accept('a', 40), false)
  assert.equal(g.accept('a', 79), true)
  assert.equal(g.isArmed('a'), true)
})

test('setTarget keeps sweep tracking, so a cross against the new target counts', () => {
  const g = new PickupGate()
  g.disarm('a', null)
  g.accept('a', 10)
  g.setTarget('a', 50)
  assert.equal(g.accept('a', 120), true)
})

test('setTarget on an armed or unknown key does nothing', () => {
  const g = new PickupGate()
  g.setTarget('a', 50)
  assert.equal(g.isArmed('a'), true)
})

test('keys are independent', () => {
  const g = new PickupGate()
  g.disarm('a', 100)
  g.disarm('b', 10)
  assert.equal(g.accept('a', 12), false)
  assert.equal(g.accept('b', 12), true)
  assert.equal(g.isArmed('a'), false)
  assert.equal(g.isArmed('b'), true)
  assert.equal(g.accept('c', 0), true)
})
