/**
 * Bundled config/config.json sanity tests.
 *
 * This file is the seed a fresh install copies into userData, and nothing ever
 * re-seeds an install that already has one — so a wrong value here is a wrong
 * value on every machine set up from this point on, and it is invisible until
 * someone turns the knob and the wrong thing moves.
 *
 * The expected values come from a read-only survey of the live FOH Core
 * (110f, design FOH-Mixer_ExtFXMixer9-30-2026) recorded in
 * qsys-bridge-mapping-handoff.md.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { stripComments } from './config.js'
import type { Mapping } from './config.js'

const SEED_PATH = path.join(__dirname, '..', '..', 'config', 'config.json')

function seedMappings(): Mapping[] {
  const raw = fs.readFileSync(SEED_PATH, 'utf-8')
  return (JSON.parse(stripComments(raw)) as { mappings: Mapping[] }).mappings
}

const labelled = (prefix: string) =>
  seedMappings().filter(m => (m.label ?? '').startsWith(prefix))

/**
 * The Q-SYS channel a per-strip component belongs to: 'Mic.05.HPF' → 'Mic.05',
 * 'Styb.Gain' → 'Styb'. Blocks on one channel all share this prefix.
 */
function channelOf(component: string): string {
  return component.replace(/\.(Gain|HPF|LPF|EQ|Delay)$/, '')
}

test('every Knob B knob sweeps an HPF frequency range, not a gain range', () => {
  const knobs = labelled('Knob B')
  assert.ok(knobs.length > 0, 'no Knob B mappings in the seed config')

  for (const m of knobs) {
    assert.equal(m.qsys.control, 'frequency', `${m.label} is not a frequency control`)
    // A frequency cannot be negative, and -100..10 Hz is the gain range pasted
    // onto an HPF by mistake: the knob would spend its whole sweep below 10 Hz.
    assert.ok(
      (m.qsys.min ?? -1) >= 10,
      `${m.label} min is ${m.qsys.min}, not a frequency (expected >= 10)`,
    )
    assert.ok(
      (m.qsys.max ?? 0) > (m.qsys.min ?? 0),
      `${m.label} max ${m.qsys.max} does not exceed min ${m.qsys.min}`,
    )
  }
})

test('each MIDImix strip column drives one Q-SYS channel', () => {
  // Columns are CC 22–29 across the fader (ch7), mute (ch1) and Knob B (ch5)
  // rows. Analog.Inputs is keyed by physical preamp input, not by strip, so the
  // trim knobs are deliberately not part of a column.
  const byColumn = new Map<number, Map<string, string[]>>()

  for (const m of seedMappings()) {
    const comp = m.qsys.component
    if (m.midi.type !== 'cc' || !comp) continue
    if (m.midi.number < 22 || m.midi.number > 29) continue
    if (comp.startsWith('Analog.Inputs')) continue

    const col = byColumn.get(m.midi.number) ?? new Map<string, string[]>()
    const chan = channelOf(comp)
    col.set(chan, (col.get(chan) ?? []).concat(m.label ?? comp))
    byColumn.set(m.midi.number, col)
  }

  for (const [cc, channels] of [...byColumn].sort((a, b) => a[0] - b[0])) {
    const detail = [...channels].map(([c, ls]) => `${c} (${ls.join(', ')})`).join(' vs ')
    assert.equal(channels.size, 1, `CC ${cc} spans more than one channel: ${detail}`)
  }
})

// MIDI channel per MIDImix control row, from the mappings themselves.
const ROWS: [string, number][] = [['fader', 7], ['mute', 1], ['Knob B', 5]]
const COLUMNS = [22, 23, 24, 25, 26, 27, 28, 29]

test('every MIDImix strip column has a fader, a mute and an HPF knob', () => {
  // The column-consistency test above is satisfied by a column with a single
  // entry, so a missing row hides from it. A knob with no mapping is a knob
  // that does nothing on a fresh install.
  const present = new Set<string>()
  for (const m of seedMappings()) {
    if (m.midi.type !== 'cc' || !m.qsys.component) continue
    if (m.qsys.component.startsWith('Analog.Inputs')) continue
    present.add(`${m.midi.number}/${m.midi.channel}`)
  }

  const missing: string[] = []
  for (const cc of COLUMNS) {
    for (const [row, ch] of ROWS) {
      if (!present.has(`${cc}/${ch}`)) missing.push(`column CC ${cc} has no ${row}`)
    }
  }
  assert.deepEqual(missing, [], missing.join('; '))
})

test('the analog trim knobs reach the full gain the Core allows', () => {
  const knobs = labelled('Knob A')
  assert.ok(knobs.length > 0, 'no Knob A mappings in the seed config')

  for (const m of knobs) {
    assert.equal(m.qsys.min, -100, `${m.label} min`)
    // Core range for Analog.Inputs channel.N.input.gain is -100..20; stopping
    // the knob at +10 makes the top half of the Core's range unreachable.
    assert.equal(m.qsys.max, 20, `${m.label} max`)
  }
})
