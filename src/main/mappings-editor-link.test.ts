/**
 * Mappings editor — stereo-link round-trip tests.
 *
 * The editor is the only way most of these mappings get written, so the
 * `qsys.link` it emits has to survive validateMappings and come back as the
 * same gang on reload. These tests run the page's own <script> in a vm with a
 * stub DOM, poke its `assignments` map the way the Link checkbox would, and
 * inspect what buildMappings() produces.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { validateMappings } from './mapping-service.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const PAGE = path.join(__dirname, '..', '..', 'assets', 'mappings', 'mappings.html')

function makeElement(tag = 'div'): Any {
  const el: Any = {
    tagName: tag.toUpperCase(),
    textContent: '', innerHTML: '', value: '', id: '', className: '',
    type: '', checked: false, disabled: false, title: '', placeholder: '',
    colSpan: 1, style: {}, dataset: {},
    classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => false },
    appendChild: (c: Any) => c, removeChild: (c: Any) => c,
    setAttribute: () => {}, getAttribute: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
    rows: [] as Any[], cells: [] as Any[],
    insertRow() { const r = makeElement('tr'); el.rows.push(r); return r },
    insertCell() { const c = makeElement('td'); el.cells.push(c); return c },
    closest: () => null, querySelector: () => makeElement(), querySelectorAll: () => [],
  }
  return el
}

function makeDocument(): Any {
  const byKey = new Map<string, Any>()
  const lookup = (key: string) => {
    let el = byKey.get(key)
    if (!el) { el = makeElement(); byKey.set(key, el) }
    return el
  }
  return {
    getElementById: (id: string) => lookup('#' + id),
    querySelector: (sel: string) => lookup(sel),
    querySelectorAll: () => [],
    createElement: (tag: string) => makeElement(tag),
    createTextNode: () => makeElement('#text'),
    addEventListener: () => {},
    body: makeElement('body'),
  }
}

/**
 * Runs the editor's script block and hands back a handle to its internals.
 * The page declares `assignments` and `physicalControls` with const/let, which
 * never become properties of the vm global, so the shim closes over them.
 */
function loadEditor(routes: Record<string, Any> = {}): Any {
  const html = fs.readFileSync(PAGE, 'utf-8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(blocks.length, 1, `expected one script block, found ${blocks.length}`)

  const shim = `
    globalThis.__editor = {
      assignments,
      buildMappings,
      loadApp,
      repoint: repointPrimary,
      setControls(v) { physicalControls = v },
    }
  `

  const sandbox: Any = {
    document: makeDocument(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async (url: string) => ({
      ok: true,
      status: 200,
      // Mirror the real server's shapes: /controls always answers with a
      // controls array, never a bare object.
      json: async () => routes[url] ?? (url.endsWith('/controls') ? { controls: [] } : {}),
    }),
    setTimeout: () => 0, clearTimeout: () => {},
    Map, Set, JSON, Promise, Array, Object, String, Number, parseFloat, isNaN,
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(blocks[0] + shim, sandbox)
  return sandbox.__editor
}

const KNOB_A1 = { id: 'Ka1', label: 'Knob A 1', group: 'Knobs A', controlType: 'knob', midi: { type: 'cc', channel: 4, number: 22 } }
const MUTE_1 = { id: 'M1', label: 'Mute 1', group: 'Mutes', controlType: 'toggle', midi: { type: 'cc', channel: 1, number: 22 } }

/**
 * Builds mappings for one physical control carrying `assignment`.
 * Round-tripped through JSON both to escape the vm's realm (its object
 * literals fail deepStrictEqual's prototype check) and because that is
 * precisely what the page POSTs to /api/mappings.
 */
function buildFor(pc: Any, assignment: Any): Any[] {
  const editor = loadEditor()
  editor.setControls([pc])
  editor.assignments.set(pc.id, assignment)
  return JSON.parse(JSON.stringify(editor.buildMappings()))
}

test('a link on a different component is emitted as qsys.link', () => {
  const [mapping] = buildFor(KNOB_A1, {
    component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
    link: { component: 'Dante.In.10.Gain', control: 'gain' },
  })

  assert.deepEqual(mapping.qsys.link, { component: 'Dante.In.10.Gain' })
})

test('a link differing only by control name is emitted as a control-only link', () => {
  const [mapping] = buildFor(KNOB_A1, {
    component: 'Dante.Pair.Gain', controlName: 'gain.1', min: -100, max: 20,
    link: { component: 'Dante.Pair.Gain', control: 'gain.2' },
  })

  assert.deepEqual(mapping.qsys.link, { control: 'gain.2' })
})

test('a link naming a different component and control keeps both', () => {
  const [mapping] = buildFor(KNOB_A1, {
    component: 'A.Gain', controlName: 'gain.1', min: -100, max: 20,
    link: { component: 'B.Gain', control: 'gain.2' },
  })

  assert.deepEqual(mapping.qsys.link, { component: 'B.Gain', control: 'gain.2' })
})

test('a link ticked but not yet filled in is omitted rather than saved broken', () => {
  // The checkbox seeds { component: '', control: <primary> }. Emitting that
  // would fail server validation and lose the whole save, not just this row.
  const [mapping] = buildFor(KNOB_A1, {
    component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
    link: { component: '', control: 'gain' },
  })

  assert.equal(mapping.qsys.link, undefined)
  assert.equal(validateMappings([mapping]).valid, true)
})

test('an unlinked assignment emits no link field at all', () => {
  const [mapping] = buildFor(KNOB_A1, {
    component: 'Mic.02.Gain', controlName: 'gain', min: -100, max: 20, link: null,
  })

  assert.equal('link' in mapping.qsys, false)
})

test('a linked toggle emits a link alongside the toggle type', () => {
  const [mapping] = buildFor(MUTE_1, {
    component: 'Dante.In.9.Gain', controlName: 'mute',
    link: { component: 'Dante.In.10.Gain', control: 'mute' },
  })

  assert.equal(mapping.qsys.type, 'toggle')
  assert.deepEqual(mapping.qsys.link, { component: 'Dante.In.10.Gain' })
})

test('everything the editor emits for a gang passes server validation', () => {
  const mappings = buildFor(KNOB_A1, {
    component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
    link: { component: 'Dante.In.10.Gain', control: 'gain' },
  })

  assert.ok(mappings[0].qsys.link, 'expected the gang to survive into the payload')
  assert.equal(validateMappings(mappings).valid, true)
})

test('repointing the primary component clears the stale linked leg', () => {
  const editor = loadEditor()
  editor.setControls([KNOB_A1])
  editor.assignments.set('Ka1', {
    component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
    link: { component: 'Dante.In.10.Gain', control: 'gain' },
  })

  // What the component <select>'s change handler does when the user picks a
  // different primary. The old partner is no longer related to this control,
  // so carrying it over would silently gang two unrelated things.
  editor.repoint('Ka1', 'Mic.03.Gain')

  assert.equal(editor.assignments.get('Ka1').link, null)
})

// ── load → save round-trip ───────────────────────────────────────────────────

/** Loads `mappings` through the page's own loader, then re-emits them. */
async function roundTrip(pc: Any, mappings: Any[]): Promise<Any[]> {
  const editor = loadEditor({
    '/api/mappings': { physicalControls: [pc], mappings },
    '/api/qsys/components': { components: [] },
  })
  await editor.loadApp()
  return JSON.parse(JSON.stringify(editor.buildMappings()))
}

test('a component-only link survives a load and re-save unchanged', async () => {
  const saved = [{
    label: 'Knob A 1',
    midi: { type: 'cc', channel: 4, number: 22 },
    qsys: {
      type: 'component_control', component: 'Dante.In.9.Gain', control: 'gain',
      min: -100, max: 20, link: { component: 'Dante.In.10.Gain' },
    },
  }]

  assert.deepEqual(await roundTrip(KNOB_A1, saved), saved)
})

test('a control-only link survives a load and re-save unchanged', async () => {
  const saved = [{
    label: 'Knob A 1',
    midi: { type: 'cc', channel: 4, number: 22 },
    qsys: {
      type: 'component_control', component: 'Dante.Pair.Gain', control: 'gain.1',
      min: -100, max: 20, link: { control: 'gain.2' },
    },
  }]

  assert.deepEqual(await roundTrip(KNOB_A1, saved), saved)
})

test('an unlinked mapping gains no link by passing through the editor', async () => {
  const saved = [{
    label: 'Knob A 1',
    midi: { type: 'cc', channel: 4, number: 22 },
    qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -100, max: 20 },
  }]

  assert.deepEqual(await roundTrip(KNOB_A1, saved), saved)
})
