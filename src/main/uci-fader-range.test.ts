/**
 * UCI fader dB ↔ position maths.
 *
 * `dbToPos` feeds `setFaderPos`, which writes the result straight into
 * `style.bottom` as a percentage. The function's linear segment above 0 dB was
 * hardcoded to a +10 dB top and never clamped, so a Core reporting +20 dB — the
 * default maximum on a Q-SYS Gain block, and reachable from the MIDI bridge —
 * produced pos 1.25 and rendered the handle a quarter-track above the fader.
 *
 * The rest of the UCI already assumes +20: the AFC gain slider is
 * `min="-100" max="20"` and `VU_MAX_DB` is 20. The fader maths was the holdout.
 *
 * These tests run the real functions, lifted out of the page by source, so they
 * cannot drift from what the browser executes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const UCI_PATH = path.join(__dirname, '..', '..', 'assets', 'uci', 'foh-uci.html')

/** The top of the fader, in dB — must match the Q-SYS Gain block maximum. */
const FADER_MAX_DB = 20
/** Where 0 dB sits on the track. Unity has a detent at three-quarters travel. */
const UNITY_POS = 0.75

interface FaderMath {
  posToDb(pos: number): number
  dbToPos(db: number): number
}

/**
 * Lifts the fader-maths block out of the page and evaluates it. The functions
 * are pure — only Math and a local constant — so they need no DOM.
 */
function loadFaderMath(): FaderMath {
  const html = fs.readFileSync(UCI_PATH, 'utf-8')
  const block = html.match(/\/\/ ── fader dB math[\s\S]*?(?=\/\/ ── VU dB)/)
  assert.ok(block, 'could not find the fader dB math block in foh-uci.html')
  const src = block[0]
  // Guard against a regex that matches but captures nothing useful — without
  // this, a renamed section comment would make every test below vacuous.
  assert.match(src, /function posToDb/, 'extracted block is missing posToDb')
  assert.match(src, /function dbToPos/, 'extracted block is missing dbToPos')

  const sandbox: Record<string, unknown> = { Math }
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return sandbox as unknown as FaderMath
}

test('the top of the fader is the Q-SYS maximum of +20 dB', () => {
  const { dbToPos } = loadFaderMath()
  assert.equal(dbToPos(FADER_MAX_DB), 1)
})

test('+20 dB from the Core never pushes the handle off the track', () => {
  const { dbToPos } = loadFaderMath()
  const pos = dbToPos(20)
  assert.ok(pos <= 1, `pos ${pos} would render style.bottom: ${pos * 100}%`)
})

test('a gain above the fader maximum is clamped to the top, not rendered off-page', () => {
  const { dbToPos } = loadFaderMath()
  // A Gain block can be configured beyond +20. The UI must not break on a
  // value it did not anticipate, whatever the Core reports.
  for (const db of [24, 30, 100]) {
    const pos = dbToPos(db)
    assert.ok(pos <= 1, `${db} dB gave pos ${pos} — handle would leave the track`)
  }
})

test('unity stays at three-quarters travel', () => {
  const { dbToPos } = loadFaderMath()
  assert.equal(dbToPos(0), UNITY_POS)
})

test('the bottom of the fader is still silence', () => {
  const { dbToPos } = loadFaderMath()
  assert.equal(dbToPos(-100), 0)
  assert.equal(dbToPos(-120), 0)
})

test('dragging to the top of the track asks the Core for +20 dB', () => {
  const { posToDb } = loadFaderMath()
  assert.equal(posToDb(1), FADER_MAX_DB)
})

test('posToDb and dbToPos are inverses across the working range', () => {
  const { posToDb, dbToPos } = loadFaderMath()
  // −60 dB is the taper floor: it maps to pos 0, which reads back as silence
  // by design. Below roughly −55 dB the handle is within 0.005 of the bottom
  // and posToDb deliberately returns −100, so the invertible range stops short
  // of the floor.
  for (const db of [-50, -30, -12, 0, 5, 10, 15, 20]) {
    const round = posToDb(dbToPos(db))
    assert.ok(Math.abs(round - db) < 1e-9, `${db} dB round-tripped to ${round}`)
  }
})

test('a gain below the taper floor sits at the bottom, not part-way up', () => {
  const { dbToPos } = loadFaderMath()
  // Squaring (1 + db/60) folds negative inputs back positive, so without a
  // clamp −95 dB rendered at 26% — higher than −30 dB. The MIDI bridge maps
  // faders from −100, so this whole band is reachable from the hardware.
  for (const db of [-61, -70, -80, -95, -99]) {
    assert.equal(dbToPos(db), 0, `${db} dB must sit at the bottom of the track`)
  }
})

test('the fader position rises monotonically with gain', () => {
  const { dbToPos } = loadFaderMath()
  let previous = -1
  for (let db = -100; db <= 20; db += 0.5) {
    const pos = dbToPos(db)
    assert.ok(pos >= previous, `pos fell from ${previous} to ${pos} at ${db} dB`)
    assert.ok(pos >= 0 && pos <= 1, `pos ${pos} out of range at ${db} dB`)
    previous = pos
  }
})
