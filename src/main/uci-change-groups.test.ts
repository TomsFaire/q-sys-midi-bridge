/**
 * foh-uci.html change-group budget tests.
 *
 * A Q-SYS Core has a finite number of ChangeGroups. The UCI used to ask for
 * five on a single connection — vu_inputs, vu_buses, vu_outputs, vu_all and
 * ui_state — and the Core answered the last one with "Change groups
 * exhausted", so the live-state subscription silently never happened:
 *
 *   [state] subscribed 890 controls across 32 components
 *   [QRC] ChangeGroup add failed: Input.Mixer → Change groups exhausted
 *   ... (all 32 components)
 *
 * All four meter groups subscribe controls on the same `Meter` component at
 * the same 40 ms rate, so they only ever needed to be one. Nothing destroyed
 * groups either, so every reload and every 2 s reconnect asked for five more.
 *
 * These tests drive the HTML the way the Core does — deliver an EngineStatus
 * push and inspect the JSON-RPC the page sends back.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const UCI_PATH = path.join(__dirname, '..', '..', 'assets', 'uci', 'foh-uci.html')

function makeElement(tag = 'div'): Any {
  const classes = new Set<string>()
  const el: Any = {
    tagName: tag.toUpperCase(),
    textContent: '', innerHTML: '', value: '', id: '', className: '',
    style: {}, dataset: {}, children: [],
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
    appendChild: (c: Any) => c, removeChild: (c: Any) => c,
    remove: () => {}, after: () => {}, insertBefore: (c: Any) => c,
    addEventListener: () => {}, removeEventListener: () => {},
    setAttribute: () => {}, getAttribute: () => null,
    closest: () => makeElement(), querySelector: () => makeElement(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    createTHead: () => makeElement('thead'), createTBody: () => makeElement('tbody'),
    insertRow: () => makeElement('tr'), insertCell: () => makeElement('td'),
    focus: () => {}, blur: () => {}, click: () => {},
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
  return {
    getElementById: (id: string) => lookup('#' + id),
    querySelector: (sel: string) => lookup(sel),
    querySelectorAll: () => [],
    createElement: (tag: string) => makeElement(tag),
    createElementNS: (_ns: string, tag: string) => makeElement(tag),
    createTextNode: () => makeElement('#text'),
    addEventListener: () => {}, removeEventListener: () => {},
    body: makeElement('body'), documentElement: makeElement('html'),
  }
}

interface Rpc { id?: unknown; method: string; params: Any }

interface Harness {
  /** Every JSON-RPC message the page has sent to the Core. */
  sent: Rpc[]
  /** Complete the WebSocket handshake, as the relay does. */
  open(): void
  /** Deliver a Core push to the page, exactly as the relay would. */
  push(msg: Any): void
  /** Fire a window event the page registered for (e.g. 'beforeunload'). */
  fire(event: string): void
  /** Distinct ChangeGroup ids the page has asked the Core for. */
  groupIds(): string[]
  /** ChangeGroup ids the page has asked the Core to destroy. */
  destroyed(): string[]
  reset(): void
}

function loadUci(): Harness {
  const html = fs.readFileSync(UCI_PATH, 'utf-8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.ok(blocks.length >= 8, `expected the UCI script blocks, found ${blocks.length}`)

  const sent: Rpc[] = []
  let socket: Any = null
  // Spec-accurate: send() on a CONNECTING socket raises InvalidStateError, and
  // rpc() calls it inside a Promise executor, so the rejection is swallowed by
  // the wrapper's .catch() — a subscription registered before the socket opens
  // would silently never reach the Core. The page subscribes from EngineStatus
  // and so does not do that today; this keeps it that way.
  class FakeWebSocket {
    static OPEN = 1
    readyState = 0
    onopen: Any = null; onclose: Any = null; onerror: Any = null; onmessage: Any = null
    constructor() { socket = this }
    send(data: string) {
      if (this.readyState !== FakeWebSocket.OPEN) {
        throw new Error("InvalidStateError: still in CONNECTING state")
      }
      sent.push(JSON.parse(data))
    }
    close() {}
  }

  const winListeners = new Map<string, Any[]>()
  const sandbox: Any = {
    document: makeDocument(),
    WebSocket: FakeWebSocket,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    navigator: { userAgent: 'test' },
    location: { host: 'localhost:3001' },
    addEventListener: (ev: string, fn: Any) => {
      const fns = winListeners.get(ev) ?? []
      fns.push(fn); winListeners.set(ev, fns)
    },
    removeEventListener: () => {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox

  const ctx = vm.createContext(sandbox)
  blocks.forEach((code, i) => {
    try { vm.runInContext(code, ctx, { filename: `foh-uci.block${i}.js` }) }
    catch (e) { throw new Error(`script block ${i} threw: ${(e as Error).message}`) }
  })

  const CG_METHODS = new Set([
    'ChangeGroup.Add', 'ChangeGroup.AddComponentControl',
    'ChangeGroup.AutoPoll', 'ChangeGroup.Poll',
  ])

  return {
    sent,
    open: () => { socket.readyState = FakeWebSocket.OPEN; socket.onopen?.() },
    push: (msg: Any) => socket.onmessage({ data: JSON.stringify(msg) }),
    fire: (event: string) => (winListeners.get(event) ?? []).forEach(fn => fn({})),
    groupIds: () => [...new Set(
      sent.filter(m => CG_METHODS.has(m.method)).map(m => String(m.params?.Id)),
    )],
    destroyed: () => sent
      .filter(m => m.method === 'ChangeGroup.Destroy')
      .map(m => String(m.params?.Id)),
    reset: () => { sent.length = 0 },
  }
}

const ENGINE_ACTIVE = {
  jsonrpc: '2.0',
  method: 'EngineStatus',
  params: { State: 'Active', DesignName: 'FOH' },
}

/** A page whose relay socket is open and whose Core has reported Active. */
function connected(): Harness {
  const t = loadUci()
  t.open()
  t.push(ENGINE_ACTIVE)
  return t
}

/** Meter subscriptions the page sends, as [groupId, controlName] pairs. */
function meterSubscriptions(t: Harness): [string, string][] {
  const pairs: [string, string][] = []
  for (const m of t.sent) {
    if (m.method !== 'ChangeGroup.AddComponentControl') continue
    if (m.params?.Component?.Name !== 'Meter') continue
    for (const c of m.params.Component.Controls) pairs.push([String(m.params.Id), c.Name])
  }
  return pairs
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('the UCI asks the Core for no more than two change groups', () => {
  const t = connected()

  // One group for meters, one for UI state. A Core with a small ChangeGroup
  // budget rejects the last group it cannot fit, and the UCI loses live state.
  assert.deepEqual(
    t.groupIds().sort(),
    ['ui_state', 'vu'],
    `expected one meter group plus ui_state, got ${t.groupIds().join(', ')}`,
  )
})

test('every meter subscription lands in the single meter group', () => {
  const t = connected()

  const ids = [...new Set(meterSubscriptions(t).map(([id]) => id))]
  assert.deepEqual(ids, ['vu'], `meters split across groups: ${ids.join(', ')}`)
})

test('merging the meter groups keeps every meter the UI was reading', () => {
  const t = connected()

  const controls = new Set(meterSubscriptions(t).map(([, name]) => name))
  // A mic strip, a stereo strip, and the drawer's full meter sweep.
  for (const name of ['meter.1', 'meter.9', 'meter.16']) {
    assert.ok(controls.has(name), `lost meter subscription: ${name}`)
  }
})

test('merging keeps the bus and output meters, which load from their own groups', () => {
  const t = connected()

  // These come from loadBusState()/loadOutputState(), which had a group each.
  // Collapsing four groups into one must not drop the strips they fed.
  const controls = new Set(meterSubscriptions(t).map(([, name]) => name))
  assert.ok(controls.has('meter.17'), 'bus strip meter (MicRoom) never subscribed')
  assert.ok(controls.has('meter.29'), 'output strip meter (Mains) never subscribed')
})

test('leaving the page destroys the change groups it created', () => {
  const t = connected()
  const created = t.groupIds()
  t.reset()

  t.fire('beforeunload')

  // Groups the page never gives back are groups the next page load cannot have.
  for (const id of created) {
    assert.ok(t.destroyed().includes(id), `never destroyed change group: ${id}`)
  }
})

test('re-subscribing after a reconnect destroys the stale group first', () => {
  const t = connected()
  t.reset()

  // The relay opens a fresh TCP socket per connection, so EngineStatus arrives
  // again and the page re-subscribes. Without a Destroy the Core keeps the old
  // groups and runs out after a few reconnects.
  t.push(ENGINE_ACTIVE)

  assert.ok(
    t.destroyed().includes('ui_state'),
    'reconnect re-subscribed without destroying the stale ui_state group',
  )

  const destroyIdx = t.sent.findIndex(
    m => m.method === 'ChangeGroup.Destroy' && m.params?.Id === 'ui_state',
  )
  const addIdx = t.sent.findIndex(
    m => m.method === 'ChangeGroup.AddComponentControl' && m.params?.Id === 'ui_state',
  )
  assert.ok(destroyIdx < addIdx, 'destroyed ui_state after re-adding its controls')
})
