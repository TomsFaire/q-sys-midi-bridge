/**
 * Desktop Configurator — stereo-link preservation tests.
 *
 * The Configurator window has its own copy of load/buildMappings, parallel to
 * the browser /mappings page. It rewrites the whole mappings array on save, so
 * any field it doesn't know about is dropped: open the Configurator, nudge one
 * fader, hit Save, and every ganged stereo pair silently becomes mono again.
 *
 * Gangs are created and removed on the /mappings page. All the Configurator
 * has to do is carry them through untouched — which is what these pin down.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

// Tests run from dist/main, so reach back to the source tree.
const PAGE = path.join(__dirname, '..', '..', 'src', 'renderer', 'configurator.html')

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

/** Runs the Configurator's script with stubbed Electron IPC. */
function loadConfigurator(ipc: Record<string, Any> = {}): Any {
  const html = fs.readFileSync(PAGE, 'utf-8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(blocks.length, 1, `expected one script block, found ${blocks.length}`)

  const shim = `
    globalThis.__cfg = {
      assignments,
      buildMappings,
      setControls(v) { physicalControls = v },
    }
  `

  const sandbox: Any = {
    document: makeDocument(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    require: (mod: string) => {
      if (mod !== 'electron') throw new Error(`unexpected require("${mod}")`)
      return {
        ipcRenderer: { invoke: async (ch: string) => ipc[ch] ?? {}, on: () => {}, send: () => {} },
        clipboard: { writeText: () => {} },
      }
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(blocks[0] + shim, sandbox)
  return sandbox.__cfg
}

const KNOB_A1 = { id: 'Ka1', label: 'Knob A 1', group: 'Knobs A', controlType: 'knob', midi: { type: 'cc', channel: 4, number: 22 } }

test('the Configurator re-emits a ganged mapping with its link intact', () => {
  const cfg = loadConfigurator()
  cfg.setControls([KNOB_A1])
  cfg.assignments.set('Ka1', {
    component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
    link: { component: 'Dante.In.10.Gain', control: 'gain' },
  })

  const [mapping] = JSON.parse(JSON.stringify(cfg.buildMappings()))
  assert.deepEqual(mapping.qsys.link, { component: 'Dante.In.10.Gain' })
})

test('the Configurator adds no link to an unganged mapping', () => {
  const cfg = loadConfigurator()
  cfg.setControls([KNOB_A1])
  cfg.assignments.set('Ka1', {
    component: 'Mic.02.Gain', controlName: 'gain', min: -100, max: 20,
  })

  const [mapping] = JSON.parse(JSON.stringify(cfg.buildMappings()))
  assert.equal('link' in mapping.qsys, false)
})
