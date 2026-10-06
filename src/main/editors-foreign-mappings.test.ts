/**
 * Both mapping editors rebuild the whole mappings array on save from their own
 * model of the MIDImix's physical controls. Anything they don't model — an
 * X-Touch fader on pitch bend, a V-Pot sending relative ticks — has to survive
 * that round trip, or opening either editor on an X-Touch rig and pressing Save
 * quietly deletes the surface.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { PHYSICAL_CONTROLS } from './mapping-service.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const BROWSER_PAGE = path.join(__dirname, '..', '..', 'assets', 'mappings', 'mappings.html')
const CONFIGURATOR_PAGE = path.join(__dirname, '..', '..', 'src', 'renderer', 'configurator.html')

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

function scriptOf(page: string): string {
  const html = fs.readFileSync(page, 'utf-8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(blocks.length, 1, `expected one script block in ${page}`)
  return blocks[0]
}

/** The MIDImix strip the editors do model, so one mapping is theirs to rewrite. */
const MUTE_1 = {
  id: 'M1', label: 'Mute 1', group: 'Mutes', controlType: 'toggle',
  midi: { type: 'note_on', channel: 1, number: 1 },
}

const MIDIMIX_MAPPING = {
  label: 'Mic 1 Mute',
  midi: { type: 'note_on', channel: 1, number: 1 },
  qsys: { type: 'toggle', component: 'Mic.01.Gain', control: 'mute' },
}

/** The two shapes neither editor models. */
const FADER_MAPPING = {
  label: 'Mic 2 Fader',
  midi: { type: 'pitchbend', channel: 2 },
  qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -100, max: 20 },
}

const ENCODER_MAPPING = {
  label: 'Trim 1',
  midi: { type: 'cc', channel: 1, number: 16 },
  qsys: {
    type: 'component_control_relative', component: 'Mic.01.Gain', control: 'gain',
    step: 0.5, min: -18, max: 18, encoding: 'mcu',
  },
}

/**
 * The MCU address space overlaps the MIDImix table: V-Pots are CC 16-23 on
 * channel 1 and MIDImix mutes are CC 22-29 on channel 1, so V-Pot 7 and Mute 1
 * are the same address. Select buttons are notes 24-31, and the MIDImix bottom
 * row is notes 25-27. A mapping at a colliding address is still not a MIDImix
 * control, and rewriting it as one corrupts it.
 */
const COLLIDING_ENCODER = {
  label: 'V-Pot 7',
  midi: { type: 'cc', channel: 1, number: 22 },   // also MIDImix "Mute 1"
  qsys: {
    type: 'component_control_relative', component: 'Mic.07.Gain', control: 'gain',
    step: 0.5, min: -18, max: 18, encoding: 'mcu',
  },
}

const COLLIDING_SELECT = {
  label: 'Select 2',
  midi: { type: 'note_on', channel: 1, number: 25 },  // also MIDImix "Bank Left"
  qsys: { type: 'snapshot', bank: 1, slot: 2 },
}

const STORED = [MIDIMIX_MAPPING, FADER_MAPPING, ENCODER_MAPPING]

/** Loads the browser editor, runs its loadApp(), returns what a Save emits. */
async function browserRoundTrip(
  controls: Any[] = [MUTE_1], stored: Any[] = STORED,
): Promise<Any[]> {
  const sandbox: Any = {
    document: makeDocument(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => {
        if (url.endsWith('/api/mappings')) {
          return { physicalControls: controls, mappings: stored }
        }
        // loadApp() renders the table, which needs the component list.
        if (url.endsWith('/api/qsys/components')) return { components: [] }
        return url.endsWith('/controls') ? { controls: [] } : {}
      },
    }),
    setTimeout: () => 0, clearTimeout: () => {},
    Map, Set, JSON, Promise, Array, Object, String, Number, parseFloat, isNaN,
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(scriptOf(BROWSER_PAGE) + `
    globalThis.__editor = { loadApp, buildMappings }
  `, sandbox)
  await sandbox.__editor.loadApp()
  return JSON.parse(JSON.stringify(sandbox.__editor.buildMappings()))
}

/** Loads the Configurator, runs its init(), returns what a Save emits. */
async function configuratorRoundTrip(
  controls: Any[] = [MUTE_1], stored: Any[] = STORED,
): Promise<Any[]> {
  const sandbox: Any = {
    document: makeDocument(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    require: (mod: string) => {
      if (mod !== 'electron') throw new Error(`unexpected require("${mod}")`)
      return {
        ipcRenderer: {
          invoke: async (ch: string) => {
            if (ch === 'cfg:get-physical-controls') return controls
            if (ch === 'cfg:load-config') return { mappings: stored }
            // Everything init() fans out to afterwards, answered in the
            // shapes it expects so no stray rejection outlives the test.
            // Both of these answer with a bare array, not a wrapper object.
            if (ch === 'cfg:discover-components') return []
            if (ch === 'cfg:get-component-controls') return []
            if (ch === 'cfg:get-qsys-status') return { connected: false }
            if (ch === 'cfg:get-host') return { host: '', port: 1710 }
            if (ch === 'cfg:get-network-info') return { addresses: [] }
            if (ch === 'cfg:has-mappings-password') return { set: false }
            return {}
          },
          on: () => {}, send: () => {},
        },
        clipboard: { writeText: () => {} },
      }
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(scriptOf(CONFIGURATOR_PAGE) + `
    globalThis.__cfg = { init, buildMappings }
  `, sandbox)
  await sandbox.__cfg.init()
  return JSON.parse(JSON.stringify(sandbox.__cfg.buildMappings()))
}

const find = (mappings: Any[], label: string) => mappings.find((m) => m.label === label)

test('the browser editor keeps an X-Touch fader it cannot show', async () => {
  const saved = await browserRoundTrip()
  assert.deepEqual(find(saved, 'Mic 2 Fader'), FADER_MAPPING)
})

test('the browser editor keeps a relative encoder it cannot show', async () => {
  const saved = await browserRoundTrip()
  assert.deepEqual(find(saved, 'Trim 1'), ENCODER_MAPPING)
})

test('the browser editor still rewrites the mappings it does model', async () => {
  const saved = await browserRoundTrip()
  const mute = find(saved, 'Mic 1 Mute')
  assert.equal(mute.qsys.component, 'Mic.01.Gain')
  assert.equal(saved.length, 3)
})

test('the Configurator keeps an X-Touch fader it cannot show', async () => {
  const saved = await configuratorRoundTrip()
  assert.deepEqual(find(saved, 'Mic 2 Fader'), FADER_MAPPING)
})

test('the Configurator keeps a relative encoder it cannot show', async () => {
  const saved = await configuratorRoundTrip()
  assert.deepEqual(find(saved, 'Trim 1'), ENCODER_MAPPING)
})

test('the Configurator still rewrites the mappings it does model', async () => {
  const saved = await configuratorRoundTrip()
  const mute = find(saved, 'Mic 1 Mute')
  assert.equal(mute.qsys.component, 'Mic.01.Gain')
  assert.equal(saved.length, 3)
})


// ── Addresses that collide with a real MIDImix control ───────────────────────

const REAL = JSON.parse(JSON.stringify(PHYSICAL_CONTROLS))
const COLLIDING = [MIDIMIX_MAPPING, COLLIDING_ENCODER, COLLIDING_SELECT]

test('the browser editor does not rewrite a V-Pot sharing an address with a mute', async () => {
  const saved = await browserRoundTrip(REAL, COLLIDING)
  assert.deepEqual(find(saved, 'V-Pot 7'), COLLIDING_ENCODER)
})

test('the browser editor does not rewrite a Select sharing an address with Bank Left', async () => {
  const saved = await browserRoundTrip(REAL, COLLIDING)
  assert.deepEqual(find(saved, 'Select 2'), COLLIDING_SELECT)
})

test('the Configurator does not rewrite a V-Pot sharing an address with a mute', async () => {
  const saved = await configuratorRoundTrip(REAL, COLLIDING)
  assert.deepEqual(find(saved, 'V-Pot 7'), COLLIDING_ENCODER)
})

test('the Configurator does not rewrite a Select sharing an address with Bank Left', async () => {
  const saved = await configuratorRoundTrip(REAL, COLLIDING)
  assert.deepEqual(find(saved, 'Select 2'), COLLIDING_SELECT)
})
