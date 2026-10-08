/**
 * Golden fixtures for both mapping editors.
 *
 * Freezes what the two mapping editors emit from buildMappings(), so the
 * shared-editor refactor can prove it changed nothing. The web side drives the
 * shared module (assets/shared/mapping-editor.js) through mount(); the desktop
 * side runs the Configurator's inline script (its IPC adapter) around that same module. The fixtures live
 * in helpers/golden-fixtures.ts (not here) so other tests can import them
 * without re-registering this file's tests.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { loadSharedEditor, makeDomElement } from './helpers/load-shared-editor.js'
import { GOLDEN_FIXTURES, KNOB_A1, BANKL } from './helpers/golden-fixtures.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

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
 * Runs the Configurator's real inline script, with the real shared module and
 * a stubbed IPC layer serving `pc` and `mappings`, and returns the mounted
 * handle the page holds.
 */
async function mountDesktop(pc: Any, mappings: Any[] = []): Promise<Any> {
  const ipc: Record<string, Any> = {
    'cfg:get-physical-controls': [pc],
    'cfg:load-config': { mappings },
    'cfg:get-qsys-status': { connected: false },
  }
  const doc = makeDocument()
  const rootEl = makeDomElement()
  const lookup = doc.getElementById
  doc.getElementById = (id: string) => (id === 'editor-root' ? rootEl : lookup(id))
  const sandbox: Any = {
    document: doc,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {},
    MappingEditor: loadSharedEditor(),
    require: (mod: string) => {
      if (mod !== 'electron') throw new Error(`unexpected require("${mod}")`)
      return {
        ipcRenderer: {
          // Unknown channels throw so a typo'd channel name cannot pass silently.
          invoke: async (ch: string) => {
            if (!(ch in ipc)) throw new Error(`unexpected IPC channel "${ch}"`)
            return ipc[ch]
          },
          on: () => {}, send: () => {},
        },
        clipboard: { writeText: () => {} },
      }
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(singleScript(DESKTOP_PAGE) + '\nglobalThis.__editor = () => editor', sandbox)
  for (let i = 0; i < 20 && !sandbox.__editor(); i++) await new Promise((r) => setImmediate(r))
  assert.ok(sandbox.__editor(), 'the Configurator should have mounted the editor')
  return sandbox.__editor()
}

/**
 * JSON round-trip: escapes the vm realm (its object literals fail
 * deepStrictEqual's prototype check) and matches what the page POSTs.
 */
function plain(v: Any): Any[] {
  return JSON.parse(JSON.stringify(v))
}

/**
 * The web page now runs the shared editor, so "web" means MappingEditor.mount
 * driven through the same adapter contract the page uses. Assignments are
 * seeded through __internals, as the Link checkbox and selects would.
 */
async function mountWeb(pc: Any, mappings: Any[] = []): Promise<Any> {
  return loadSharedEditor().mount({
    root: makeDomElement(),
    adapter: {
      loadEditorState: async () => ({ physicalControls: [pc], mappings }),
      getQsysStatus: async () => ({ connected: false }),
      discoverComponents: async () => [],
      getComponentControls: async () => [],
      save: async () => ({ count: 0 }),
      saveAndApply: async () => ({ count: 0 }),
    },
  })
}

async function buildViaWeb(pc: Any, assignment: Any): Promise<Any[]> {
  const editor = await mountWeb(pc)
  editor.__internals.assignments.set(pc.id, assignment)
  return plain(editor.getMappings())
}

async function buildViaDesktop(pc: Any, assignment: Any): Promise<Any[]> {
  const editor = await mountDesktop(pc)
  editor.__internals.assignments.set(pc.id, assignment)
  return plain(editor.getMappings())
}

/** Loads `mappings` through the shared editor's own loader, then re-emits them. */
async function roundTripWeb(pc: Any, mappings: Any[]): Promise<Any[]> {
  const editor = await mountWeb(pc, mappings)
  return plain(editor.getMappings())
}

test('desktop load path: each fixture\'s expected output loads through cfg:load-config and re-emits unchanged', async () => {
  let checked = 0
  for (const f of GOLDEN_FIXTURES) {
    if (!f.expected) continue
    const editor = await mountDesktop(f.pc, [f.expected])
    assert.deepEqual(plain(editor.getMappings()), [f.expected], f.name)
    checked++
  }
  assert.ok(checked > 0, 'at least one fixture must carry an expected output')
})

test('each fixture matches its frozen expected output (web)', async () => {
  assert.equal(GOLDEN_FIXTURES.length, 9, 'golden fixtures must not be emptied or silently shrunk')
  for (const f of GOLDEN_FIXTURES) {
    if (!f.expected) { assert.deepEqual(await buildViaWeb(f.pc, f.assignment), [], f.name); continue }
    assert.deepEqual(await buildViaWeb(f.pc, f.assignment), [f.expected], f.name)
  }
})

test('each fixture matches its frozen expected output (desktop)', async () => {
  assert.equal(GOLDEN_FIXTURES.length, 9, 'golden fixtures must not be emptied or silently shrunk')
  for (const f of GOLDEN_FIXTURES) {
    if (!f.expected) { assert.deepEqual(await buildViaDesktop(f.pc, f.assignment), [], f.name); continue }
    assert.deepEqual(await buildViaDesktop(f.pc, f.assignment), [f.expected], f.name)
  }
})

test('TODAY: a mapping with no matching physical control is dropped on save', async () => {
  const saved = [{ label: 'Ghost', midi: { type: 'cc', channel: 9, number: 99 },
                   qsys: { type: 'component_control', component: 'X.Gain', control: 'gain' } }]
  const out = await roundTripWeb(KNOB_A1, saved)
  assert.deepEqual(out, [], 'INTENTIONAL: pins current buggy behaviour; expected to change when the data-loss fix lands - flip this test, do not "fix" it.')
})

test('TODAY: a snapshot mapping is dropped on save', async () => {
  const saved = [{ label: 'Snap', midi: { type: 'note_on', channel: 1, number: 25 },
                   qsys: { type: 'snapshot', bank: 1, slot: 3 } }]
  const out = await roundTripWeb(BANKL, saved)
  assert.deepEqual(out, [], 'INTENTIONAL: pins current buggy behaviour; expected to change when the data-loss fix lands - flip this test, do not "fix" it.')
})

test('TODAY: two mappings on one MIDI address collapse to the last', async () => {
  const a = { label: 'First', midi: { type: 'cc', channel: 4, number: 22 },
              qsys: { type: 'component_control', component: 'A.Gain', control: 'gain', min: -100, max: 10 } }
  const b = { ...a, label: 'Second', qsys: { ...a.qsys, component: 'B.Gain' } }
  const out = await roundTripWeb(KNOB_A1, [a, b])
  assert.equal(out.length, 1, 'INTENTIONAL: pins current buggy behaviour; expected to change when the data-loss fix lands - flip this test, do not "fix" it.')
  assert.equal(out[0].qsys.component, 'B.Gain')
})
