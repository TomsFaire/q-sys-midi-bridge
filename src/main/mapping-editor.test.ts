/**
 * Shared mapping editor — pure logic.
 *
 * Runs assets/shared/mapping-editor.js in a vm and checks that it reproduces
 * the output both legacy editors were frozen to in editor-golden.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSharedEditor, makeDomElement, fireEvent } from './helpers/load-shared-editor.js'
import { GOLDEN_FIXTURES, KNOB_A1, MUTE_1 } from './helpers/golden-fixtures.js'
import { validateMappings } from './mapping-service.js'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

test('buildMappings reproduces every golden fixture', () => {
  assert.equal(GOLDEN_FIXTURES.length, 9)
  const { buildMappings } = loadSharedEditor().__internals
  for (const f of GOLDEN_FIXTURES) {
    const assignments = new Map([[f.pc.id, f.assignment]])
    const out = JSON.parse(JSON.stringify(buildMappings([f.pc], assignments)))
    assert.deepEqual(out, f.expected ? [f.expected] : [], f.name)
  }
})

test('guessRange suggests a frequency span for a frequency control', () => {
  const { guessRange } = loadSharedEditor().__internals
  assert.deepEqual(Array.from(guessRange('frequency')), [20, 20000])
})

test('guessRange falls back to a unit span for an unrecognised name', () => {
  const { guessRange } = loadSharedEditor().__internals
  assert.deepEqual(Array.from(guessRange('wibble')), [0, 1])
})

test('guessRange suggests a bipolar span for pan', () => {
  const { guessRange } = loadSharedEditor().__internals
  assert.deepEqual(Array.from(guessRange('pan')), [-100, 100])
})

test('repointPrimary clears control, range and link', () => {
  const { repointPrimary } = loadSharedEditor().__internals
  const assignments = new Map<string, any>([['Ka1', {
    component: 'A', controlName: 'gain', min: -5, max: 5, label: 'X',
    link: { component: 'B', control: 'gain' },
  }]])
  repointPrimary(assignments, 'Ka1', 'C')
  // JSON round-trip: objects from the vm realm fail strict prototype checks.
  assert.deepEqual(JSON.parse(JSON.stringify(assignments.get('Ka1'))),
    { component: 'C', controlName: '', min: -100, max: 10, label: 'X', link: null })
})

test('withLink leaves qsys untouched when there is no link', () => {
  const { withLink } = loadSharedEditor().__internals
  const q = { type: 'toggle' }
  assert.equal(withLink({ component: 'A', controlName: 'm' }, q), q)
  assert.deepEqual(q, { type: 'toggle' })
})

// ---- rendering ----------------------------------------------------------

const KNOB_A2 = { id: 'Ka2', label: 'Knob A 2', group: 'Knobs A', controlType: 'knob', midi: { type: 'cc', channel: 4, number: 23 } }

// mountForTest is the internal createEditor factory: it takes its data
// directly, with no adapter, because rendering is independent of transport.
function mountForTest(opts: { physicalControls: any[]; mappings?: any[]; components?: any[] }): any {
  return loadSharedEditor().__internals.createEditor({
    physicalControls: opts.physicalControls,
    mappings: opts.mappings ?? [],
    components: opts.components ?? [],
  })
}

const hasClass = (el: any, name: string) => el.className.split(/\s+/).includes(name)

test('a component absent from discovery is still shown as the row value', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'Renamed.Gain',
                         control: 'gain', min: -100, max: 10 } }],
    components: [{ name: 'Other.Gain', type: '' }],   // discovery lacks it
  })
  const sel = ed.root.querySelector('tr.ctrl-row[data-id="Ka1"] .comp-sel')
  assert.equal(sel.value, 'Renamed.Gain',
    'a renamed or offline component must not silently blank the row')
})

test('renderRow replaces only its own row', () => {
  const ed = mountForTest({ physicalControls: [KNOB_A1, KNOB_A2], mappings: [] })
  const before = ed.root.querySelector('tr.ctrl-row[data-id="Ka2"]')
  const own = ed.root.querySelector('tr.ctrl-row[data-id="Ka1"]')
  ed.__internals.assignments.set('Ka1', { component: 'Mic.02.Gain', controlName: 'gain', min: -100, max: 10 })
  ed.__internals.renderRow('Ka1')
  const after = ed.root.querySelector('tr.ctrl-row[data-id="Ka2"]')
  assert.equal(before, after, 'the untouched row must be the same node, so focus survives')
  const fresh = ed.root.querySelector('tr.ctrl-row[data-id="Ka1"]')
  assert.notEqual(fresh, own, 'the target row is rebuilt')
  assert.ok(hasClass(fresh, 'assigned'), 'and reflects current state')
})

test('renderRow adds and removes the linked-leg row to match state', () => {
  const ed = mountForTest({ physicalControls: [KNOB_A1], components: [{ name: 'A.Gain', type: '' }] })
  const { assignments, renderRow } = ed.__internals
  assignments.set('Ka1', { component: 'A.Gain', controlName: 'gain', min: -100, max: 10,
                           link: { component: '', control: 'gain' } })
  renderRow('Ka1')
  assert.equal(ed.root.querySelectorAll('tr.link-row').length, 1)
  assignments.set('Ka1', { component: 'A.Gain', controlName: 'gain', min: -100, max: 10, link: null })
  renderRow('Ka1')
  assert.equal(ed.root.querySelectorAll('tr.link-row').length, 0)
})

test('a ganged row renders a linked-leg row directly beneath it', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'A.Gain', control: 'gain',
                         min: -100, max: 10, link: { component: 'B.Gain' } } }],
    components: [{ name: 'A.Gain', type: '' }, { name: 'B.Gain', type: '' }],
  })
  const rows = [...ed.root.querySelectorAll('tr')]
  const primary = rows.findIndex((r: any) => hasClass(r, 'ctrl-row'))
  assert.ok(primary >= 0)
  assert.ok(hasClass(rows[primary + 1], 'link-row'))
  assert.equal(rows[primary + 1].querySelector('.lnk-comp-sel').value, 'B.Gain')
})

test('an unganged row renders no linked-leg row', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'A.Gain', control: 'gain', min: -100, max: 10 } }],
    components: [{ name: 'A.Gain', type: '' }],
  })
  assert.equal(ed.root.querySelector('tr.link-row'), null)
})

test('the linked leg also survives a component missing from discovery', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'A.Gain', control: 'gain',
                         min: -100, max: 10, link: { component: 'Gone.Gain' } } }],
    components: [{ name: 'A.Gain', type: '' }],
  })
  assert.equal(ed.root.querySelector('.lnk-comp-sel').value, 'Gone.Gain')
})

test('the table has a thead with the eight column headers in order', () => {
  const ed = mountForTest({ physicalControls: [KNOB_A1] })
  const ths = [...ed.root.querySelectorAll('thead tr th')]
  assert.deepEqual(ths.map((th: any) => th.textContent),
    ['Control', 'Type', 'Q-Sys Component', 'Control Name', 'Min', 'Max', 'Link', ''])
  assert.match(ths[6].title, /Gang a second Q-Sys target/)
  // One header cell per body cell, so the columns line up.
  assert.equal(ed.root.querySelector('tr.ctrl-row').children.length, ths.length)
})

test('renderTable emits a group row per group and a shown-count label', () => {
  const ed = mountForTest({ physicalControls: [KNOB_A1, KNOB_A2, MUTE_1] })
  const groups = [...ed.root.querySelectorAll('tr.group-row')].map((r: any) => r.textContent)
  assert.deepEqual(groups, ['Knobs A', 'Mutes'])
  assert.equal(ed.root.querySelector('.count-label').textContent, '3 of 3 controls')
})

test('toggle rows hide and disable their min/max inputs', () => {
  const ed = mountForTest({ physicalControls: [MUTE_1] })
  const min = ed.root.querySelector('tr.ctrl-row .min-inp')
  assert.equal(min.disabled, true)
  assert.equal(min.style.visibility, 'hidden')
})

test('an unassigned row has its control input and clear button disabled', () => {
  const ed = mountForTest({ physicalControls: [KNOB_A1] })
  const row = ed.root.querySelector('tr.ctrl-row')
  assert.ok(!hasClass(row, 'assigned'))
  assert.equal(row.querySelector('.ctrl-input').disabled, true)
  assert.equal(row.querySelector('.clear-btn').disabled, true)
})

test('populateDatalist escapes control names', () => {
  const { populateDatalist } = loadSharedEditor().__internals
  const dl: any = { innerHTML: '' }
  populateDatalist(dl, [{ name: 'a"b<c' }])
  assert.equal(dl.innerHTML, '<option value="a&quot;b&lt;c">')
})


// ---- mount, adapter and events -------------------------------------------

const flush = () => new Promise<void>(r => setImmediate(r))
const GAIN = { name: 'Mic.02.Gain', type: 'gain' }
const GAIN3 = { name: 'Mic.03.Gain', type: 'gain' }

function fakeAdapter(over: any = {}): any {
  return {
    loadEditorState: async () => ({ physicalControls: [KNOB_A1], mappings: [] }),
    getQsysStatus: async () => ({ connected: true }),
    discoverComponents: async () => [GAIN, GAIN3],
    getComponentControls: async () => [{ name: 'gain', isBoolean: false }],
    save: async () => ({ count: 0 }),
    saveAndApply: async () => ({ count: 0 }),
    ...over,
  }
}

async function mountWith(over: any = {}, statuses: any[] = []): Promise<any> {
  return loadSharedEditor().mount({
    root: makeDomElement(), adapter: fakeAdapter(over), onStatus: (s: any) => statuses.push(s),
  })
}

const rowOf = (ed: any, id: string) => ed.root.querySelector('tr.ctrl-row[data-id="' + id + '"]')
const idsOf = (ed: any) => [...ed.root.querySelectorAll('tr.ctrl-row')].map((r: any) => r.dataset.id)

function mapped(pc: any, component: string, extra: any = {}) {
  return { label: pc.label, midi: pc.midi,
           qsys: { type: 'component_control', component, control: 'gain', min: -100, max: 10, ...extra } }
}
const withMapping = (over: any = {}) => ({
  loadEditorState: async () => ({ physicalControls: [KNOB_A1], mappings: [mapped(KNOB_A1, GAIN.name)] }),
  ...over,
})

test('mount renders the table into the given root', async () => {
  const ed = await mountWith()
  assert.ok(rowOf(ed, 'Ka1'))
})

test('discovery failing still leaves an editable table', async () => {
  const statuses: any[] = []
  const ed = await mountWith({ discoverComponents: async () => { throw new Error('Core unreachable') } }, statuses)
  assert.ok(ed.root.querySelector('tr.ctrl-row'), 'table must still render')
  assert.ok(statuses.some(s => s.kind === 'err' && /unreachable/.test(s.text)))
})

test('a Core that reports disconnected is info, skips discovery, and still renders', async () => {
  const statuses: any[] = []
  let discovered = false
  const ed = await mountWith({
    getQsysStatus: async () => ({ connected: false }),
    discoverComponents: async () => { discovered = true; return [] },
  }, statuses)
  assert.equal(discovered, false)
  assert.ok(statuses.some(s => s.kind === 'info'))
  assert.ok(rowOf(ed, 'Ka1'))
})

test('a failing status probe is reported but does not stop the table', async () => {
  const statuses: any[] = []
  const ed = await mountWith({ getQsysStatus: async () => { throw new Error('probe down') } }, statuses)
  assert.ok(statuses.some(s => s.kind === 'err' && /probe down/.test(s.text)))
  assert.ok(rowOf(ed, 'Ka1'))
})

test('saveAndApply dispatches to the adapter, not save', async () => {
  const calls: string[] = []
  const ed = await mountWith({
    save: async () => { calls.push('save'); return { count: 0 } },
    saveAndApply: async () => { calls.push('apply'); return { count: 0 } },
  })
  await ed.saveAndApply()
  assert.deepEqual(calls, ['apply'])
})

test('a rejected save reports through onStatus and does not throw', async () => {
  const statuses: any[] = []
  const ed = await mountWith({ save: async () => { throw new Error('disk full') } }, statuses)
  await ed.save()
  assert.ok(statuses.some(s => s.kind === 'err' && /disk full/.test(s.text)))
})

test('a successful save reports ok with the count', async () => {
  const statuses: any[] = []
  const ed = await mountWith({ save: async () => ({ count: 7 }) }, statuses)
  await ed.save()
  assert.ok(statuses.some(s => s.kind === 'ok' && /7/.test(s.text)))
})

test('save sends the mappings built from the current edits', async () => {
  let sent: any
  const ed = await mountWith({ save: async (m: any) => { sent = JSON.parse(JSON.stringify(m)); return { count: m.length } } })
  const sel = rowOf(ed, 'Ka1').querySelector('.comp-sel')
  sel.value = GAIN.name
  await fireEvent(sel, 'change')
  const input = rowOf(ed, 'Ka1').querySelector('.ctrl-input')
  input.value = ' gain '
  await fireEvent(input, 'input')
  await ed.save()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].qsys.component, GAIN.name)
  assert.equal(sent[0].qsys.control, 'gain', 'the input handler trims')
})

test('a failed initial load blocks save so an empty table cannot overwrite the Core mappings', async () => {
  const statuses: any[] = []
  let saved = false
  const ed = await mountWith({
    loadEditorState: async () => { throw new Error('server down') },
    save: async () => { saved = true; return { count: 0 } },
  }, statuses)
  assert.ok(statuses.some(s => s.kind === 'err' && /server down/.test(s.text)))
  await ed.save()
  assert.equal(saved, false)
})

test('reload re-reads state and keeps the active tab', async () => {
  let n = 0
  const ed = await mountWith({
    loadEditorState: async () => ({
      physicalControls: n++ === 0 ? [KNOB_A1, MUTE_1] : [KNOB_A1, MUTE_1, KNOB_A2], mappings: [] }),
  })
  ed.__internals.view.group = 'Mutes'
  await ed.reload()
  assert.equal(ed.root.querySelectorAll('tr.ctrl-row').length, 1, 'still filtered to Mutes')
  assert.equal(ed.root.querySelector('.count-label').textContent, '1 of 3 controls')
})

test('ticking Link seeds the control name from the primary', async () => {
  const ed = await mountWith(withMapping())
  const chk = rowOf(ed, 'Ka1').querySelector('.lnk-chk')
  chk.checked = true
  await fireEvent(chk, 'change')
  const a = ed.__internals.assignments.get('Ka1')
  assert.deepEqual(JSON.parse(JSON.stringify(a.link)), { component: '', control: 'gain' },
    'the common case is the same control on the neighbouring component')
  assert.ok(ed.root.querySelector('tr.link-row'), 'the linked leg appears')
  assert.equal(ed.getMappings()[0].qsys.link, undefined, 'an unfilled link emits nothing')
})

test('repointing the primary component clears the link', async () => {
  const ed = await mountWith({
    loadEditorState: async () => ({ physicalControls: [KNOB_A1],
      mappings: [mapped(KNOB_A1, GAIN.name, { link: { component: GAIN3.name } })] }),
  })
  assert.ok(ed.root.querySelector('tr.link-row'))
  const sel = rowOf(ed, 'Ka1').querySelector('.comp-sel')
  sel.value = GAIN3.name
  await fireEvent(sel, 'change')
  assert.equal(ed.__internals.assignments.get('Ka1').link, null,
    'a stale partner must not silently gang two unrelated controls')
  assert.equal(ed.root.querySelector('tr.link-row'), null)
})

test('picking the linked leg component stores it and keeps the row', async () => {
  const ed = await mountWith({
    loadEditorState: async () => ({ physicalControls: [KNOB_A1],
      mappings: [mapped(KNOB_A1, GAIN.name, { link: { control: 'gain' } })] }),
  })
  const sel = ed.root.querySelector('.lnk-comp-sel')
  sel.value = GAIN3.name
  await fireEvent(sel, 'change')
  assert.equal(ed.__internals.assignments.get('Ka1').link.component, GAIN3.name)
  assert.equal(ed.root.querySelector('.lnk-comp-sel').value, GAIN3.name)
})

test('clearing the component removes the assignment and re-renders the row', async () => {
  const ed = await mountWith(withMapping())
  const sel = rowOf(ed, 'Ka1').querySelector('.comp-sel')
  sel.value = ''
  await fireEvent(sel, 'change')
  assert.equal(ed.__internals.assignments.has('Ka1'), false)
  assert.ok(!hasClass(rowOf(ed, 'Ka1'), 'assigned'))
})

test('the clear button removes the assignment; the row label span is not a click target', async () => {
  const ed = await mountWith(withMapping())
  await fireEvent(rowOf(ed, 'Ka1').querySelector('td.td-label span'), 'click')
  assert.ok(ed.__internals.assignments.has('Ka1'), 'a click on the label does nothing')
  await fireEvent(rowOf(ed, 'Ka1').querySelector('.clear-btn'), 'click')
  assert.equal(ed.__internals.assignments.has('Ka1'), false)
})

test('min and max inputs update the assignment without re-rendering', async () => {
  const ed = await mountWith(withMapping())
  const row = rowOf(ed, 'Ka1')
  const min = row.querySelector('.min-inp')
  min.value = '-50'
  await fireEvent(min, 'input')
  assert.equal(ed.__internals.assignments.get('Ka1').min, -50)
  assert.equal(rowOf(ed, 'Ka1'), row, 'typing must not rebuild the row under the cursor')
})

test('clicking a tab filters to that group; All restores', async () => {
  const ed = await mountWith({
    loadEditorState: async () => ({ physicalControls: [KNOB_A1, MUTE_1], mappings: [] }),
  })
  const tab = (g: string) => ed.root.querySelector('.tab[data-group="' + g + '"]')
  await fireEvent(tab('Mutes'), 'click')
  assert.deepEqual(idsOf(ed), ['M1'])
  assert.ok(hasClass(tab('Mutes'), 'active'))
  assert.ok(!hasClass(tab('all'), 'active'))
  await fireEvent(tab('all'), 'click')
  assert.deepEqual(idsOf(ed), ['Ka1', 'M1'])
})

test('typing in the filter box narrows by label or id, case-insensitively', async () => {
  const ed = await mountWith({
    loadEditorState: async () => ({ physicalControls: [KNOB_A1, MUTE_1], mappings: [] }),
  })
  const box = ed.root.querySelector('.filter-input')
  box.value = 'MUTE'
  await fireEvent(box, 'input')
  assert.deepEqual(idsOf(ed), ['M1'])
  box.value = 'ka1'
  await fireEvent(box, 'input')
  assert.deepEqual(idsOf(ed), ['Ka1'])
  assert.equal(ed.root.querySelector('.count-label').textContent, '1 of 2 controls')
})

// ---- control lookup (getControls) ----------------------------------------

function editorWithControls(getControls: any): any {
  return loadSharedEditor().__internals.createEditor({
    physicalControls: [KNOB_A1, KNOB_A2],
    mappings: [mapped(KNOB_A1, GAIN.name), mapped(KNOB_A2, GAIN.name)],
    components: [GAIN],
    getControls,
  })
}

test('control lookup fills the row datalist from the fetch', async () => {
  const ed = editorWithControls(async () => [{ name: 'gain' }, { name: 'mute' }])
  await flush()
  assert.equal(rowOf(ed, 'Ka1').querySelector('datalist').innerHTML, '<option value="gain"><option value="mute">')
})

test('rows sharing a component trigger one fetch, and a re-render hits the cache', async () => {
  let calls = 0
  const ed = editorWithControls(async () => { calls++; return [{ name: 'gain' }] })
  await flush()
  ed.__internals.renderRow('Ka1')
  ed.__internals.renderTable()
  await flush()
  assert.equal(calls, 1)
  assert.equal(rowOf(ed, 'Ka2').querySelector('datalist').innerHTML, '<option value="gain">')
})

test('a rejected fetch is cached as empty so a failing Core is not re-hit per render', async () => {
  let calls = 0
  const ed = editorWithControls(async () => { calls++; throw new Error('Core offline') })
  await flush()
  ed.__internals.renderRow('Ka1')
  ed.__internals.renderTable()
  await flush()
  assert.equal(calls, 1)
  assert.equal(rowOf(ed, 'Ka1').querySelector('datalist').innerHTML, '', 'free-text entry still works')
  assert.equal(rowOf(ed, 'Ka1').querySelector('.ctrl-input').disabled, false)
})

test('without a getControls hook an uncached datalist is left empty', () => {
  const ed = loadSharedEditor().__internals.createEditor({
    physicalControls: [KNOB_A1], mappings: [mapped(KNOB_A1, GAIN.name)], components: [GAIN],
  })
  assert.equal(rowOf(ed, 'Ka1').querySelector('datalist').innerHTML, '')
})

test('the adapter control list is sorted naturally before it reaches the datalist', async () => {
  const ed = await mountWith(withMapping({
    getComponentControls: async () => [{ name: 'in.10' }, { name: 'in.2' }],
  }))
  await flush()
  assert.equal(rowOf(ed, 'Ka1').querySelector('datalist').innerHTML, '<option value="in.2"><option value="in.10">')
})

// ---- view (tab and filter state) -----------------------------------------

test('view.group restricts rendering to that group', () => {
  const view = { group: 'Mutes', text: '' }
  const ed = loadSharedEditor().__internals.createEditor({ physicalControls: [KNOB_A1, MUTE_1], view })
  assert.deepEqual(idsOf(ed), ['M1'])
  assert.deepEqual([...ed.root.querySelectorAll('tr.group-row')].map((r: any) => r.textContent), ['Mutes'])
})

test('view.text matches label or id, ignoring case', () => {
  const view = { group: 'all', text: 'KNOB A 2' }
  const ed = loadSharedEditor().__internals.createEditor({ physicalControls: [KNOB_A1, KNOB_A2], view })
  assert.deepEqual(idsOf(ed), ['Ka2'])
})

// ---- Task 6 carry-overs and ports from the retired page tests ------------

test('a loadEditorState resolving undefined still renders a usable table and reports an error', async () => {
  const statuses: any[] = []
  const ed = await mountWith({ loadEditorState: async () => undefined }, statuses)
  assert.ok(ed.root.querySelector('table'), 'the table must exist, not just the toolbar')
  assert.ok(ed.root.querySelector('tbody'))
  assert.ok(statuses.some(s => s.kind === 'err'), 'an empty load must be reported')
  assert.throws(() => ed.getMappings(), /failed to load/)
  await ed.save()
  assert.ok(statuses.some(s => s.kind === 'err' && /Not saved/.test(s.text)),
    'an empty load must not be saveable over stored mappings')
})

test('a null loadEditorState is treated the same as undefined', async () => {
  const statuses: any[] = []
  const ed = await mountWith({ loadEditorState: async () => null }, statuses)
  assert.ok(ed.root.querySelector('tbody'))
  assert.ok(statuses.some(s => s.kind === 'err'))
})

test('a save result without a count falls back to the number of mappings sent', async () => {
  const statuses: any[] = []
  const ed = await mountWith(withMapping({ save: async () => ({}) }), statuses)
  await ed.save()
  const ok = statuses.find(s => s.kind === 'ok')
  assert.ok(ok, 'expected an ok status')
  assert.doesNotMatch(ok.text, /undefined/)
  assert.match(ok.text, /1 mappings/)
})

test('a saveAndApply result of undefined also falls back to the mappings length', async () => {
  const statuses: any[] = []
  const ed = await mountWith(withMapping({ saveAndApply: async () => undefined }), statuses)
  await ed.saveAndApply()
  const ok = statuses.find(s => s.kind === 'ok')
  assert.ok(ok)
  assert.match(ok.text, /1 mappings/)
})

test('everything the editor emits for a gang passes server validation', () => {
  const { buildMappings } = loadSharedEditor().__internals
  const ganged = GOLDEN_FIXTURES.filter(f => f.expected && f.expected.qsys.link)
  assert.ok(ganged.length >= 3, 'expected component-only, control-only, both-differ and toggle gangs')
  // A ticked-but-unfilled link must be dropped, not sent: a broken link would
  // fail server validation and lose the whole save.
  const unfilled = GOLDEN_FIXTURES.find(f => f.name === 'link ticked but unfilled')!
  assert.ok(unfilled.assignment.link, 'fixture must actually carry a link')
  const unfilledOut = JSON.parse(JSON.stringify(buildMappings([unfilled.pc], new Map([[unfilled.pc.id, unfilled.assignment]]))))
  assert.equal(unfilledOut.length, 1)
  assert.equal(unfilledOut[0].qsys.link, undefined)
  assert.equal(validateMappings(unfilledOut).valid, true)
  for (const f of ganged) {
    const out = JSON.parse(JSON.stringify(buildMappings([f.pc], new Map([[f.pc.id, f.assignment]]))))
    assert.ok(out[0].qsys.link, f.name)
    assert.equal(validateMappings(out).valid, true, f.name)
  }
})

async function roundTrip(pc: any, saved: any[]): Promise<any[]> {
  const ed = await mountWith({ loadEditorState: async () => ({ physicalControls: [pc], mappings: saved }) })
  return JSON.parse(JSON.stringify(ed.getMappings()))
}

test('a component-only link survives a load and re-save unchanged', async () => {
  const saved = [{
    label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
    qsys: { type: 'component_control', component: 'Dante.In.9.Gain', control: 'gain',
            min: -100, max: 20, link: { component: 'Dante.In.10.Gain' } },
  }]
  assert.deepEqual(await roundTrip(KNOB_A1, saved), saved)
})

test('a control-only link survives a load and re-save unchanged', async () => {
  const saved = [{
    label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
    qsys: { type: 'component_control', component: 'Dante.Pair.Gain', control: 'gain.1',
            min: -100, max: 20, link: { control: 'gain.2' } },
  }]
  assert.deepEqual(await roundTrip(KNOB_A1, saved), saved)
})

test('an unlinked mapping gains no link by passing through the editor', async () => {
  const saved = [{
    label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
    qsys: { type: 'component_control', component: 'Mic.02.Gain', control: 'gain', min: -100, max: 20 },
  }]
  assert.deepEqual(await roundTrip(KNOB_A1, saved), saved)
})

// ---- Task 6 fix round: refresh, Q-Sys message, page glue ------------------

test('refreshComponents keeps unsaved edits and picks up the new component list', async () => {
  let comps = [GAIN]
  const ed = await mountWith({ discoverComponents: async () => comps })
  const sel = rowOf(ed, 'Ka1').querySelector('.comp-sel')
  sel.value = GAIN.name
  await fireEvent(sel, 'change')
  const input = rowOf(ed, 'Ka1').querySelector('.ctrl-input')
  input.value = 'gain'
  await fireEvent(input, 'input')
  comps = [GAIN, GAIN3]
  await ed.refreshComponents()
  const opts = [...rowOf(ed, 'Ka1').querySelector('.comp-sel').children].map((o: any) => o.value)
  assert.ok(opts.includes(GAIN3.name), 'new component must be offered')
  const out = JSON.parse(JSON.stringify(ed.getMappings()))
  assert.equal(out.length, 1, 'the unsaved assignment must survive')
  assert.equal(out[0].qsys.component, GAIN.name)
  assert.equal(out[0].qsys.control, 'gain')
})

test('refreshComponents does not re-read the stored mappings', async () => {
  let loads = 0
  const ed = await mountWith({ loadEditorState: async () => { loads++; return { physicalControls: [KNOB_A1], mappings: [] } } })
  await ed.refreshComponents()
  assert.equal(loads, 1)
})

test('a disconnected status carrying a message is shown as an error with that message', async () => {
  const statuses: any[] = []
  await mountWith({ getQsysStatus: async () => ({ connected: false, message: 'Logon failed: bad credentials' }) }, statuses)
  assert.ok(statuses.some(s => s.kind === 'err' && /Logon failed: bad credentials/.test(s.text)))
  assert.ok(!statuses.some(s => s.kind === 'info'))
})

const PAGE_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'mappings', 'mappings.html'), 'utf-8')

test('the page links the shared script and stylesheet at the paths the server serves', () => {
  assert.match(PAGE_HTML, /<script src="\/shared\/mapping-editor\.js"><\/script>/)
  assert.match(PAGE_HTML, /<link rel="stylesheet" href="\/shared\/mapping-editor\.css">/)
  // The module must load before the inline script that calls it.
  assert.ok(PAGE_HTML.indexOf('/shared/mapping-editor.js') < PAGE_HTML.indexOf('MappingEditor.mount'))
})

test('the page offers an empty #editor-root and no leftover static table or toolbar', () => {
  assert.match(PAGE_HTML, /<div id="editor-root"><\/div>/)
  assert.doesNotMatch(PAGE_HTML, /<thead/)
  assert.doesNotMatch(PAGE_HTML, /id="tbody"/)
  assert.doesNotMatch(PAGE_HTML, /class="tabs"|class="filterbar"|id="filter-input"/)
})

function loadPageAdapter(failComponents = false): { adapter: any; calls: any[] } {
  const blocks = [...PAGE_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.equal(blocks.length, 1)
  const calls: any[] = []
  const stub = (): any => ({ addEventListener: () => {}, classList: { add() {}, remove() {} }, style: {}, textContent: '', value: '' })
  const sandbox: any = {
    document: { getElementById: stub },
    console,
    fetch: async (url: string, opts: any = {}) => {
      calls.push({ url, method: opts.method ?? 'GET', body: opts.body })
      if (failComponents && url === '/api/qsys/components') {
        return { ok: false, status: 502, json: async () => ({ error: 'Logon failed' }) }
      }
      return { ok: true, status: 200, json: async () => ({ components: [{ name: 'A' }], controls: [{ name: 'c' }] }) }
    },
    MappingEditor: { mount: async () => ({}) },
  }
  vm.createContext(sandbox)
  vm.runInContext(blocks[0] + '\nglobalThis.__adapter = adapter', sandbox)
  calls.length = 0   // drop the page's own startup session probe
  return { adapter: sandbox.__adapter, calls }
}

test('the page adapter hits the expected endpoint, method and body for every method', async () => {
  const { adapter, calls } = loadPageAdapter()
  const m = [{ label: 'x' }]
  await adapter.loadEditorState()
  assert.equal(JSON.stringify(await adapter.getQsysStatus()), '{"connected":true}')
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.discoverComponents())), [{ name: 'A' }])
  assert.deepEqual(JSON.parse(JSON.stringify(await adapter.getComponentControls('Mic 1/Gain'))), [{ name: 'c' }])
  await adapter.save(m)
  await adapter.saveAndApply(m)
  assert.deepEqual(calls, [
    { url: '/api/mappings', method: 'GET', body: undefined },
    { url: '/api/qsys/components', method: 'GET', body: undefined },
    { url: '/api/qsys/components', method: 'GET', body: undefined },
    { url: '/api/qsys/components/Mic%201%2FGain/controls', method: 'GET', body: undefined },
    { url: '/api/mappings', method: 'POST', body: JSON.stringify(m) },
    { url: '/api/mappings/apply', method: 'POST', body: JSON.stringify(m) },
  ])
})

test('the page adapter turns a failing components probe into disconnected plus the server message', async () => {
  const { adapter } = loadPageAdapter(true)
  const st = JSON.parse(JSON.stringify(await adapter.getQsysStatus()))
  assert.deepEqual(st, { connected: false, message: 'Logon failed' })
})

// ── Page glue: refresh wiring, shared by both hosts ─────────────────────────

/** Runs a page's single inline script against stubs and returns what it wired. */
async function runPageScript(html: string, extra: Record<string, any>) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])
  assert.equal(blocks.length, 1)
  const listeners = new Map<string, Record<string, () => any>>()
  const els = new Map<string, any>()
  const stub = (id: string): any => {
    let e = els.get(id)
    if (!e) {
      e = {
        addEventListener: (ev: string, fn: () => any) => {
          const m = listeners.get(id) ?? {}; m[ev] = fn; listeners.set(id, m)
        },
        classList: { add() {}, remove() {} }, style: {}, textContent: '', value: '', className: '',
      }
      els.set(id, e)
    }
    return e
  }
  const calls: string[] = []
  const handle = {
    save: async () => { calls.push('save') },
    saveAndApply: async () => { calls.push('saveAndApply') },
    reload: async () => { calls.push('reload') },
    refreshComponents: async () => { calls.push('refreshComponents') },
    getMappings: () => [],
  }
  let mountOpts: any = null
  const sandbox: any = {
    document: { getElementById: stub },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {},
    MappingEditor: { mount: async (o: any) => { mountOpts = o; return handle } },
    ...extra,
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(blocks[0] + '\nglobalThis.__adapter = typeof adapter === "undefined" ? null : adapter', sandbox)
  for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
  return { listeners, calls, mountOpts: () => mountOpts, adapter: sandbox.__adapter, els }
}

const okFetch = async (url: string) => ({
  ok: true, status: 200,
  json: async () => url.endsWith('/session') ? { passwordSet: true, authenticated: true } : {},
})

test('mappings page: Refresh Q-Sys calls refreshComponents and never reload', async () => {
  const p = await runPageScript(PAGE_HTML, { fetch: okFetch })
  assert.ok(p.mountOpts(), 'page should have mounted the editor')
  await p.listeners.get('refresh-btn')!.click()
  assert.deepEqual(p.calls, ['refreshComponents'])
})

const CONFIGURATOR_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'configurator.html'), 'utf-8')

function runConfigurator(invoke: (ch: string, ...a: any[]) => any = async () => ({})) {
  const ipcHandlers = new Map<string, (...a: any[]) => any>()
  return runPageScript(CONFIGURATOR_HTML, {
    require: (m: string) => {
      if (m !== 'electron') throw new Error('unexpected require ' + m)
      return { ipcRenderer: { invoke, on(ch: string, fn: any) { ipcHandlers.set(ch, fn) }, send() {} }, clipboard: { writeText() {} } }
    },
  }).then(p => ({ ...p, ipcHandlers }))
}

test('configurator links the shared script and stylesheet by relative file:// path', () => {
  assert.match(CONFIGURATOR_HTML, /<script src="\.\.\/\.\.\/assets\/shared\/mapping-editor\.js"><\/script>/)
  assert.match(CONFIGURATOR_HTML, /<link rel="stylesheet" href="\.\.\/\.\.\/assets\/shared\/mapping-editor\.css">/)
  assert.ok(CONFIGURATOR_HTML.indexOf('shared/mapping-editor.js') < CONFIGURATOR_HTML.indexOf('MappingEditor.mount'))
})

test('configurator offers an empty #editor-root and no leftover static table or toolbar', () => {
  assert.match(CONFIGURATOR_HTML, /<div id="editor-root"><\/div>/)
  assert.doesNotMatch(CONFIGURATOR_HTML, /<thead|<table|<colgroup/)
  assert.doesNotMatch(CONFIGURATOR_HTML, /id="tbody"/)
  assert.doesNotMatch(CONFIGURATOR_HTML, /class="tabs"|class="filterbar"|id="filter-input"|id="count-label"/)
})

test('configurator adapter maps every method to the right IPC channel and arguments', async () => {
  const calls: any[] = []
  const invoke = async (ch: string, ...args: any[]) => {
    calls.push([ch, ...args])
    if (ch === 'cfg:load-config') return { mappings: [{ label: 'x' }] }
    if (ch === 'cfg:get-physical-controls') return [{ id: 'F1' }]
    return { connected: true }
  }
  const p = await runConfigurator(invoke)
  calls.length = 0   // drop startup traffic
  const m = [{ label: 'x' }]
  const state = JSON.parse(JSON.stringify(await p.adapter.loadEditorState()))
  assert.deepEqual(state, { physicalControls: [{ id: 'F1' }], mappings: [{ label: 'x' }] })
  await p.adapter.getQsysStatus()
  await p.adapter.discoverComponents()
  await p.adapter.getComponentControls('Mic 1')
  await p.adapter.save(m)
  await p.adapter.saveAndApply(m)
  assert.deepEqual(calls, [
    ['cfg:get-physical-controls'],
    ['cfg:load-config'],
    ['cfg:get-qsys-status'],
    ['cfg:discover-components'],
    ['cfg:get-component-controls', 'Mic 1'],
    ['cfg:save-config', m],
    ['cfg:save-and-apply', m],
  ])
})

test('configurator adapter treats a config with no mappings key as empty', async () => {
  const p = await runConfigurator(async (ch) => ch === 'cfg:get-physical-controls' ? [] : {})
  assert.deepEqual(JSON.parse(JSON.stringify((await p.adapter.loadEditorState()).mappings)), [])
})

test('configurator buttons: Refresh -> refreshComponents, Save -> save, Save & Apply -> saveAndApply', async () => {
  const p = await runConfigurator()
  assert.ok(p.mountOpts(), 'page should have mounted the editor')
  await p.listeners.get('refresh-btn')!.click()
  assert.deepEqual(p.calls, ['refreshComponents'])
  await p.listeners.get('save-btn')!.click()
  await p.listeners.get('save-restart-btn')!.click()
  assert.deepEqual(p.calls, ['refreshComponents', 'save', 'saveAndApply'])
})

// ── Task 7 fix round 1 ──────────────────────────────────────────────────────

test('configurator: #editor-root is a flex child that can shrink so the table scrolls above the footer', () => {
  const m = CONFIGURATOR_HTML.match(/#editor-root\s*\{([^}]*)\}/)
  assert.ok(m, 'page must style #editor-root')
  assert.match(m![1], /flex:\s*1/)
  assert.match(m![1], /min-height:\s*0/)
  assert.match(m![1], /display:\s*flex/)
  assert.match(m![1], /flex-direction:\s*column/)
})

test('shared stylesheet centres the Type column header like its body cells', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'shared', 'mapping-editor.css'), 'utf-8')
  assert.match(css, /\.mapping-editor th:nth-child\(2\)\s*\{[^}]*text-align:\s*center/)
})

// ── Final whole-branch review fixes ─────────────────────────────────────────

test('every ipcRenderer.on channel the configurator registers is known and covered', async () => {
  const p = await runConfigurator()
  assert.deepEqual([...p.ipcHandlers.keys()], ['cfg:host-connected'])
})

test('cfg:host-connected re-discovers components and confirms, without throwing', async () => {
  const p = await runConfigurator()
  p.calls.length = 0
  await p.ipcHandlers.get('cfg:host-connected')!()
  assert.deepEqual(p.calls, ['refreshComponents'])
  assert.equal(p.els.get('host-status').textContent, '✓ Connected')
})

// Guessed Min/Max: driven through the real change listener, as a browser
// fires it (input per keystroke, then change on commit).
async function nameControl(ed: any, id: string, name: string, commit = true) {
  const sel = rowOf(ed, id).querySelector('.comp-sel')
  if (!ed.__internals.assignments.get(id)) {
    sel.value = GAIN.name
    await fireEvent(sel, 'change')
  }
  const row = rowOf(ed, id)
  const input = row.querySelector('.ctrl-input')
  input.value = name
  await fireEvent(input, 'input')
  if (commit) await fireEvent(input, 'change')
  return row
}

for (const [name, min, max] of [
  ['Mic.Gain', -100, 10], ['Filter.Frequency', 20, 20000], ['Comp.Threshold', -40, 0], ['Out.Delay', 0, 2000],
] as const) {
  test(`committing control name "${name}" stores and shows the guessed ${min}/${max}`, async () => {
    const ed = await mountWith()
    const row = await nameControl(ed, 'Ka1', name)
    const a = ed.__internals.assignments.get('Ka1')
    assert.equal(a.controlName, name)
    assert.deepEqual([a.min, a.max], [min, max], 'must be saved, not only displayed')
    assert.equal(row.querySelector('.min-inp').value, String(min))
    assert.equal(row.querySelector('.max-inp').value, String(max))
    assert.equal(rowOf(ed, 'Ka1'), row, 'guessing must not rebuild the row under the caret')
    const out = JSON.parse(JSON.stringify(ed.getMappings()))
    assert.deepEqual([out[0].qsys.min, out[0].qsys.max], [min, max])
  })
}

test('typing a control name by hand does not guess until it is committed', async () => {
  const ed = await mountWith()
  await nameControl(ed, 'Ka1', 'f', false)       // one keystroke: "f" would hit nothing useful
  const a = ed.__internals.assignments.get('Ka1')
  assert.deepEqual([a.min, a.max], [-100, 10])
  await nameControl(ed, 'Ka1', 'freq', false)
  assert.deepEqual([ed.__internals.assignments.get('Ka1').min, ed.__internals.assignments.get('Ka1').max], [-100, 10])
  await nameControl(ed, 'Ka1', 'freq')            // committed
  assert.equal(ed.__internals.assignments.get('Ka1').min, 20)
})

test('a row whose control name is already set is not re-guessed when edited', async () => {
  const ed = await mountWith(withMapping())     // loaded with control "gain", -100/10
  await nameControl(ed, 'Ka1', 'frequency')
  const a = ed.__internals.assignments.get('Ka1')
  assert.equal(a.controlName, 'frequency')
  assert.deepEqual([a.min, a.max], [-100, 10])
})

test('a name committed once is not re-guessed on a later edit of the same row', async () => {
  const ed = await mountWith()
  await nameControl(ed, 'Ka1', 'Mic.Gain')
  await nameControl(ed, 'Ka1', 'Mic.Frequency')
  const a = ed.__internals.assignments.get('Ka1')
  assert.deepEqual([a.min, a.max], [-100, 10])
})

test('guessing leaves a toggle row alone', async () => {
  const ed = await mountWith({ loadEditorState: async () => ({ physicalControls: [MUTE_1], mappings: [] }) })
  await nameControl(ed, MUTE_1.id, 'Mic.Frequency')
  const a = ed.__internals.assignments.get(MUTE_1.id)
  assert.equal(a.controlName, 'Mic.Frequency')
  assert.deepEqual([a.min, a.max], [-100, 10])
})

test('the Type cell carries td-type so both hosts centre it like the header', async () => {
  const ed = await mountWith()
  assert.ok(rowOf(ed, 'Ka1').children[1].classList.contains('td-type'))
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'shared', 'mapping-editor.css'), 'utf-8')
  assert.match(css, /\.td-type\s*\{[^}]*text-align:\s*center/)
  assert.doesNotMatch(CONFIGURATOR_HTML, /\.td-type/)
})

test('a throwing status probe skips discovery, so its error is not overwritten', async () => {
  let discovered = 0
  const statuses: any[] = []
  await mountWith({
    getQsysStatus: async () => { throw new Error('ipc down') },
    discoverComponents: async () => { discovered++; throw new Error('second failure') },
  }, statuses)
  assert.equal(discovered, 0)
  assert.deepEqual(statuses.filter(s => s.kind === 'err').map(s => s.text), ['Q-Sys status: ipc down'])
})

test('getMappings throws after a failed load instead of returning []', async () => {
  const ed = await mountWith({ loadEditorState: async () => { throw new Error('boom') } })
  assert.throws(() => ed.getMappings(), /failed to load/)
})

const SHARED_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'shared', 'mapping-editor.js'), 'utf-8')
test('the shared module stays a classic script', () => {
  assert.doesNotMatch(SHARED_SRC, /^\s*(?:import|export)\b/m)
  assert.doesNotMatch(SHARED_SRC, /\b(?:require|import)\s*\(/)
})
