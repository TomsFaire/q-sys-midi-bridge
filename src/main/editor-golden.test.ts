/**
 * Golden fixtures for both mapping editors.
 *
 * Freezes what the web page (assets/mappings/mappings.html) and the desktop
 * Configurator (src/renderer/configurator.html) emit today from buildMappings(),
 * so the shared-editor refactor can prove it changed nothing. The fixtures live
 * in helpers/golden-fixtures.ts (not here) so other tests can import them
 * without re-registering this file's tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { GOLDEN_FIXTURES, KNOB_A1, BANKL } from './helpers/golden-fixtures.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const WEB_PAGE = path.join(__dirname, '..', '..', 'assets', 'mappings', 'mappings.html')
const DESKTOP_PAGE = path.join(__dirname, '..', '..', 'src', 'renderer', 'configurator.html')

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

function singleScript(file: string): string {
  const html = fs.readFileSync(file, 'utf-8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(blocks.length, 1, `expected one script block in ${file}, found ${blocks.length}`)
  return blocks[0]
}

/**
 * The pages declare `assignments` and `physicalControls` with const/let, which
 * never become vm globals, so the appended shim closes over them.
 */
function loadWeb(routes: Record<string, Any> = {}): Any {
  const shim = `
    globalThis.__editor = {
      assignments, buildMappings, loadApp,
      setControls(v) { physicalControls = v },
    }
  `
  const sandbox: Any = {
    document: makeDocument(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    fetch: async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => routes[url] ?? (url.endsWith('/controls') ? { controls: [] } : {}),
    }),
    setTimeout: () => 0, clearTimeout: () => {},
    Map, Set, JSON, Promise, Array, Object, String, Number, parseFloat, isNaN,
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(singleScript(WEB_PAGE) + shim, sandbox)
  return sandbox.__editor
}

function loadDesktop(ipc: Record<string, Any> = {}): Any {
  const shim = `
    globalThis.__cfg = {
      assignments, buildMappings,
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
  vm.runInContext(singleScript(DESKTOP_PAGE) + shim, sandbox)
  return sandbox.__cfg
}

/**
 * JSON round-trip: escapes the vm realm (its object literals fail
 * deepStrictEqual's prototype check) and matches what the page POSTs.
 */
function plain(v: Any): Any[] {
  return JSON.parse(JSON.stringify(v))
}

function buildViaWeb(pc: Any, assignment: Any): Any[] {
  const editor = loadWeb()
  editor.setControls([pc])
  editor.assignments.set(pc.id, assignment)
  return plain(editor.buildMappings())
}

function buildViaDesktop(pc: Any, assignment: Any): Any[] {
  const cfg = loadDesktop()
  cfg.setControls([pc])
  cfg.assignments.set(pc.id, assignment)
  return plain(cfg.buildMappings())
}

/** Loads `mappings` through the web page's own loader, then re-emits them. */
async function roundTripWeb(pc: Any, mappings: Any[]): Promise<Any[]> {
  const editor = loadWeb({
    '/api/mappings': { physicalControls: [pc], mappings },
    '/api/qsys/components': { components: [] },
  })
  await editor.loadApp()
  return plain(editor.buildMappings())
}

test('web and desktop editors agree on every golden fixture', () => {
  for (const f of GOLDEN_FIXTURES) {
    const web = buildViaWeb(f.pc, f.assignment)
    const desktop = buildViaDesktop(f.pc, f.assignment)
    assert.deepEqual(web, desktop, `hosts disagree on: ${f.name}`)
  }
})

test('each fixture matches its frozen expected output (web)', () => {
  for (const f of GOLDEN_FIXTURES) {
    if (!f.expected) { assert.deepEqual(buildViaWeb(f.pc, f.assignment), [], f.name); continue }
    assert.deepEqual(buildViaWeb(f.pc, f.assignment), [f.expected], f.name)
  }
})

test('each fixture matches its frozen expected output (desktop)', () => {
  for (const f of GOLDEN_FIXTURES) {
    if (!f.expected) { assert.deepEqual(buildViaDesktop(f.pc, f.assignment), [], f.name); continue }
    assert.deepEqual(buildViaDesktop(f.pc, f.assignment), [f.expected], f.name)
  }
})

test('TODAY: a mapping with no matching physical control is dropped on save', async () => {
  const saved = [{ label: 'Ghost', midi: { type: 'cc', channel: 9, number: 99 },
                   qsys: { type: 'component_control', component: 'X.Gain', control: 'gain' } }]
  const out = await roundTripWeb(KNOB_A1, saved)
  assert.deepEqual(out, [], 'documents the data-loss a later task fixes')
})

test('TODAY: a snapshot mapping is dropped on save', async () => {
  const saved = [{ label: 'Snap', midi: { type: 'note_on', channel: 1, number: 25 },
                   qsys: { type: 'snapshot', bank: 1, slot: 3 } }]
  const out = await roundTripWeb(BANKL, saved)
  assert.deepEqual(out, [], 'documents the data-loss a later task fixes')
})

test('TODAY: two mappings on one MIDI address collapse to the last', async () => {
  const a = { label: 'First', midi: { type: 'cc', channel: 4, number: 22 },
              qsys: { type: 'component_control', component: 'A.Gain', control: 'gain', min: -100, max: 10 } }
  const b = { ...a, label: 'Second', qsys: { ...a.qsys, component: 'B.Gain' } }
  const out = await roundTripWeb(KNOB_A1, [a, b])
  assert.equal(out.length, 1, 'documents the data-loss a later task fixes')
  assert.equal(out[0].qsys.component, 'B.Gain')
})
