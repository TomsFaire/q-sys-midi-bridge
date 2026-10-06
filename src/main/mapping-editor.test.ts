/**
 * Shared mapping editor — pure logic.
 *
 * Runs assets/shared/mapping-editor.js in a vm and checks that it reproduces
 * the output both legacy editors were frozen to in editor-golden.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSharedEditor } from './helpers/load-shared-editor.js'
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
