/**
 * Shared mapping editor — pure logic.
 *
 * Runs assets/shared/mapping-editor.js in a vm and checks that it reproduces
 * the output both legacy editors were frozen to in editor-golden.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSharedEditor } from './helpers/load-shared-editor.js'
import { GOLDEN_FIXTURES } from './helpers/golden-fixtures.js'

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
