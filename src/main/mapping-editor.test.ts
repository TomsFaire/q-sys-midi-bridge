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
