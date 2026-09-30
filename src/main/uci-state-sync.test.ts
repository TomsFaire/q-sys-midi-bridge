/**
 * foh-uci.html live-state subscription tests.
 *
 * The UCI is a single self-contained HTML file with no build step and no
 * browser test runner in this project, so these tests load its <script> blocks
 * into a `vm` context backed by a minimal DOM stub. That is enough to exercise
 * the parts under test — ChangeGroup registration and change dispatch — which
 * are plain data plumbing rather than rendering.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const UCI_PATH = path.join(__dirname, '..', '..', 'assets', 'uci', 'foh-uci.html')

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
// Elements are memoised per selector so a handler that looks an element up can
// be observed by the test looking up the same selector.
function makeElement(tag = 'div'): Any {
  const children: Any[] = []
  const classes = new Set<string>()
  const el: Any = {
    tagName: tag.toUpperCase(),
    textContent: '',
    innerHTML: '',
    value: '',
    id: '',
    className: '',
    style: {},
    dataset: {},
    children,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
      toggle: (c: string, on?: boolean) => {
        const want = on === undefined ? !classes.has(c) : on
        if (want) classes.add(c); else classes.delete(c)
        return want
      },
    },
    appendChild: (c: Any) => { children.push(c); return c },
    removeChild: (c: Any) => c,
    remove: () => {},
    after: () => {},
    insertBefore: (c: Any) => c,
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    getAttribute: () => null,
    closest: () => makeElement(),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    createTHead: () => makeElement('thead'),
    createTBody: () => makeElement('tbody'),
    insertRow: () => makeElement('tr'),
    insertCell: () => makeElement('td'),
    focus: () => {},
    blur: () => {},
    click: () => {},
  }
  return el
}

function makeDocument(): Any {
  const bySelector = new Map<string, Any>()
  const lookup = (key: string) => {
    let el = bySelector.get(key)
    if (!el) { el = makeElement(); bySelector.set(key, el) }
    return el
  }
  const doc: Any = {
    __bySelector: bySelector,
    getElementById: (id: string) => lookup('#' + id),
    querySelector: (sel: string) => lookup(sel),
    querySelectorAll: () => [],
    createElement: (tag: string) => makeElement(tag),
    createElementNS: (_ns: string, tag: string) => makeElement(tag),
    createTextNode: () => makeElement('#text'),
    addEventListener: () => {},
    removeEventListener: () => {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
  }
  return doc
}

function loadUci(): Any {
  const html = fs.readFileSync(UCI_PATH, 'utf-8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.ok(blocks.length >= 8, `expected the UCI script blocks, found ${blocks.length}`)

  const sent: Any[] = []
  class FakeWebSocket {
    static OPEN = 1
    readyState = 0
    onopen: Any = null; onclose: Any = null; onerror: Any = null; onmessage: Any = null
    send(data: string) { sent.push(JSON.parse(data)) }
    close() {}
  }

  const doc = makeDocument()
  const sandbox: Any = {
    document: doc,
    WebSocket: FakeWebSocket,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    navigator: { userAgent: 'test' },
    location: { host: 'localhost:3001' },
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  const ctx = vm.createContext(sandbox)
  blocks.forEach((code, i) => {
    try { vm.runInContext(code, ctx, { filename: `foh-uci.block${i}.js` }) }
    catch (e) { throw new Error(`script block ${i} threw: ${(e as Error).message}`) }
  })

  // Top-level `const`/`let` live in the global *lexical* environment, so they
  // are not properties of the sandbox object. Pull the ones under test out via
  // an expression evaluated in the same context.
  const api: Any = vm.runInContext(
    '({ QRC, chState, busState, outState, ibGain, boGain, stateHandlers,' +
    '   subscribeState, dispatchStateChange })',
    ctx,
  )
  return { ...api, doc, sent }
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('subscribeState registers every component the UI reads back', () => {
  const t = loadUci()
  t.subscribeState()
  const comps: string[] = [...t.stateHandlers.keys()]

  for (const expected of [
    'Input.Mixer', 'Bus.Mixer', 'Labels', 'Analog.Inputs',
    'Input.Router', 'Output.Router', 'Bus.Router',
    'Mic.01.Gain', 'Slides.Gain',              // input strip gains
    'MicRoom.Gain', 'ZoomRtn.Gain',            // bus strip gains
    'Mains.Gain', 'ZoomTX.Gain', 'Rec.Gain',   // output strip gains
    'Mains.Delay', 'ZoomTX.Delay', 'Rec.Delay',
  ]) {
    assert.ok(comps.includes(expected), `missing component subscription: ${expected}`)
  }
})

test('subscribeState registers the individual controls the UI displays', () => {
  const t = loadUci()
  t.subscribeState()
  const has = (comp: string, ctrl: string) => !!t.stateHandlers.get(comp)?.has(ctrl)

  assert.ok(has('Input.Mixer', 'input.1.mute'), 'input strip mute')
  assert.ok(has('Input.Mixer', 'input.12.mute'), 'last input strip mute')
  assert.ok(has('Input.Mixer', 'input.1.output.1.gain'), 'input→bus crosspoint')
  assert.ok(has('Input.Mixer', 'input.12.output.7.gain'), 'last routing crosspoint')
  assert.ok(has('Input.Mixer', 'input.1.output.11.gain'), 'sends-mode crosspoint (ZoomRtn)')
  assert.ok(has('Bus.Mixer', 'input.1.mute'), 'bus strip mute')
  assert.ok(has('Bus.Mixer', 'input.17.output.5.gain'), 'bus→output crosspoint (AUX 3 → Rec)')
  assert.ok(has('Mains.Gain', 'gain') && has('Mains.Gain', 'mute'), 'output gain + mute')
  assert.ok(has('Mains.Delay', 'delay'), 'output delay')
  assert.ok(has('Analog.Inputs', 'channel.8.phantom.power'), 'phantom power')
  assert.ok(has('Input.Router', 'output.18.input.24.select'), 'input router crosspoint')
  assert.ok(has('Output.Router', 'output.16.input.8.select'), 'output router crosspoint')
  assert.ok(has('Bus.Router', 'output.8.input.14.select'), 'bus router crosspoint')
  assert.ok(has('Labels', 'Mic.01') && has('Labels', 'MicRoom'), 'strip labels')
})

test('a mute change from the Core updates channel state', () => {
  const t = loadUci()
  t.subscribeState()
  assert.equal(t.chState.mic1.mute, false)

  t.dispatchStateChange({ Component: 'Input.Mixer', Name: 'input.1.mute', Value: 1 })
  assert.equal(t.chState.mic1.mute, true)

  t.dispatchStateChange({ Component: 'Input.Mixer', Name: 'input.1.mute', Value: 0 })
  assert.equal(t.chState.mic1.mute, false)
})

test('a gain change from the Core updates channel and bus and output state', () => {
  const t = loadUci()
  t.subscribeState()

  t.dispatchStateChange({ Component: 'Mic.01.Gain', Name: 'gain', Value: -7.5 })
  assert.equal(t.chState.mic1.gain, -7.5)

  t.dispatchStateChange({ Component: 'MicRoom.Gain', Name: 'gain', Value: -3 })
  assert.equal(t.busState.microom.gain, -3)

  t.dispatchStateChange({ Component: 'Rec.Gain', Name: 'gain', Value: -12 })
  t.dispatchStateChange({ Component: 'Rec.Gain', Name: 'mute', Value: 1 })
  assert.equal(t.outState.rec.gain, -12)
  assert.equal(t.outState.rec.mute, true)
})

test('a crosspoint change updates both the routing matrix and the sends fader state', () => {
  const t = loadUci()
  t.subscribeState()

  // input 1 → output 1 is bus m=1 in the routing matrix and sends bus index 0.
  t.dispatchStateChange({ Component: 'Input.Mixer', Name: 'input.1.output.1.gain', Value: -6 })
  assert.equal(t.ibGain[1][1], -6)
  assert.equal(t.chState.mic1.sendsGain[0], -6)

  // Bus.Mixer slot 1 → output 1 is the Mic Room → Mains cell and bus send 0.
  t.dispatchStateChange({ Component: 'Bus.Mixer', Name: 'input.1.output.1.gain', Value: -2 })
  assert.equal(t.boGain.microom[1], -2)
  assert.equal(t.busState.microom.sendsGain[0], -2)
})

test('a route change from the Core moves the matching select', () => {
  const t = loadUci()
  const doc = t.doc
  t.subscribeState()

  t.dispatchStateChange({ Component: 'Input.Router', Name: 'output.3.input.17.select', Value: true })
  assert.equal(doc.querySelector('#router-tbody [data-output="3"]').value, '17')

  t.dispatchStateChange({ Component: 'Bus.Router', Name: 'output.7.input.13.select', Value: true })
  assert.equal(doc.querySelector('#bus-router-tbody [data-output="7"]').value, '13')

  // The crosspoint that just went false must not claim the select.
  t.dispatchStateChange({ Component: 'Bus.Router', Name: 'output.7.input.1.select', Value: false })
  assert.equal(doc.querySelector('#bus-router-tbody [data-output="7"]').value, '13')
})

test('our own writes are not re-applied, but a different value always is', () => {
  const t = loadUci()
  t.subscribeState()

  // Local mute: the echo carrying the same value is ignored…
  t.QRC.component.set('Input.Mixer', [{ Name: 'input.2.mute', Value: 1 }])
  t.chState.mic2.mute = false   // pretend the UI has since been reset
  t.dispatchStateChange({ Component: 'Input.Mixer', Name: 'input.2.mute', Value: 1 })
  assert.equal(t.chState.mic2.mute, false, 'echo of our own write should be ignored')

  // …but a value we did not write is somebody else's change and must land.
  t.QRC.component.set('Mic.03.Gain', [{ Name: 'gain', Value: -5 }])
  t.dispatchStateChange({ Component: 'Mic.03.Gain', Name: 'gain', Value: -20 })
  assert.equal(t.chState.mic3.gain, -20, 'a different value is an external change')
})

test('unknown components and controls are ignored without throwing', () => {
  const t = loadUci()
  t.subscribeState()
  t.dispatchStateChange({ Component: 'Nope.Gain', Name: 'gain', Value: 1 })
  t.dispatchStateChange({ Component: 'Input.Mixer', Name: 'input.99.mute', Value: 1 })
  t.dispatchStateChange({ Name: 'gain', Value: 1 })   // no Component, ambiguous
})
