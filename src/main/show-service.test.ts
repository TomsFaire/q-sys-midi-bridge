/**
 * Show files — named mapping sets that can be recalled between productions.
 *
 * A show holds the whole `mappings` array and nothing else: no Core host, no
 * credentials, no UCI settings. That is what makes a show file safe to copy
 * between rigs — recalling one can never repoint the bridge at another Core.
 *
 * These tests run against a real temporary directory rather than a mocked fs,
 * following the round-trip precedent in mapping-service.test.ts. The service
 * takes directories as parameters and never imports electron, so it is
 * testable at all — config.ts imports `app`, which is why nothing tests it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  slugify,
  listShows,
  readShow,
  writeShow,
  deleteShow,
} from './show-service.js'
import { loadMappings } from './mapping-service.js'
import type { Mapping } from './config.js'

/** A fresh temp dir per test; callers clean up. */
function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-shows-'))
}

const MUTE_7: Mapping = {
  label: 'Mute 7',
  midi: { type: 'cc', channel: 1, number: 28 },
  qsys: { type: 'toggle', component: 'Mic.08.Gain', control: 'mute' },
}
const FADER_1: Mapping = {
  label: 'Fader 1',
  midi: { type: 'cc', channel: 7, number: 22 },
  qsys: { type: 'component_control', component: 'Mic.01.Gain', control: 'gain', min: -100, max: 20 },
}

// ── slugify ──────────────────────────────────────────────────────────────────

test('a show name becomes a safe lowercase filename stem', () => {
  assert.equal(slugify('Gala 2026'), 'gala-2026')
  assert.equal(slugify('Monday Stand-up'), 'monday-stand-up')
  assert.equal(slugify('  All   Hands  '), 'all-hands')
})

test('punctuation and separators collapse rather than surviving', () => {
  // A separator surviving here would let a name escape the shows directory.
  assert.equal(slugify('FOH / Stage'), 'foh-stage')
  assert.equal(slugify('../../etc/passwd'), 'etc-passwd')
  assert.equal(slugify('a\\b'), 'a-b')
  assert.equal(slugify('Show: "Night 1"'), 'show-night-1')
})

test('a name with nothing usable in it is refused', () => {
  // Returning '' would write a dotfile or clobber the directory entry.
  assert.throws(() => slugify('...'), /name/i)
  assert.throws(() => slugify('   '), /name/i)
  assert.throws(() => slugify(''), /name/i)
})

test('a very long name is capped', () => {
  assert.ok(slugify('x'.repeat(300)).length <= 64)
})

// ── write / list / read ──────────────────────────────────────────────────────

test('a saved show round-trips through the directory', () => {
  const dir = tmp()
  try {
    const summary = writeShow(dir, 'Gala 2026', [MUTE_7, FADER_1])
    assert.equal(summary.id, 'gala-2026')
    assert.equal(summary.name, 'Gala 2026')
    assert.equal(summary.count, 2)

    const show = readShow(dir, 'gala-2026')
    assert.equal(show.name, 'Gala 2026')
    assert.equal(show.schema, 1)
    assert.deepEqual(show.mappings, [MUTE_7, FADER_1])
    assert.ok(Date.parse(show.savedAt) > 0, 'savedAt should be an ISO timestamp')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('the display name survives independently of the filename', () => {
  // The file is a slug so it is safe; the name is what the operator typed.
  const dir = tmp()
  try {
    writeShow(dir, 'FOH / Stage', [MUTE_7])
    assert.ok(fs.existsSync(path.join(dir, 'foh-stage.json')))
    assert.equal(readShow(dir, 'foh-stage').name, 'FOH / Stage')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a second show of the same name gets its own file', () => {
  const dir = tmp()
  try {
    assert.equal(writeShow(dir, 'Gala', [MUTE_7]).id, 'gala')
    assert.equal(writeShow(dir, 'Gala', [FADER_1]).id, 'gala-2')
    assert.deepEqual(readShow(dir, 'gala').mappings, [MUTE_7])
    assert.deepEqual(readShow(dir, 'gala-2').mappings, [FADER_1])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('listing is newest first and counts mappings', () => {
  const dir = tmp()
  try {
    writeShow(dir, 'Older', [MUTE_7])
    // savedAt is written from the clock; force a distinct, older stamp.
    const p = path.join(dir, 'older.json')
    const older = JSON.parse(fs.readFileSync(p, 'utf-8'))
    older.savedAt = '2020-01-01T00:00:00.000Z'
    fs.writeFileSync(p, JSON.stringify(older))

    writeShow(dir, 'Newer', [MUTE_7, FADER_1])

    const shows = listShows(dir)
    assert.deepEqual(shows.map((s) => s.id), ['newer', 'older'])
    assert.deepEqual(shows.map((s) => s.count), [2, 1])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('listing a directory that does not exist yet is empty, not an error', () => {
  // First run, before anyone has saved a show.
  const dir = path.join(tmp(), 'not-created')
  assert.deepEqual(listShows(dir), [])
})

test('a show file is readable by the existing loadMappings', () => {
  // The `mappings` key is deliberate: tooling that already reads configs,
  // including scripts/check-leds.mjs, works on a show file unchanged.
  const dir = tmp()
  try {
    writeShow(dir, 'Gala', [MUTE_7, FADER_1])
    assert.deepEqual(loadMappings(path.join(dir, 'gala.json')), [MUTE_7, FADER_1])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── robustness ───────────────────────────────────────────────────────────────

test('a half-written file is never listed or read', () => {
  // Writes go to .tmp then rename, so a crash mid-write cannot leave a show
  // that loads as valid-but-truncated.
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'broken.json.tmp'), '{"schema":1,"mapp')
    assert.deepEqual(listShows(dir), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable show is skipped by the listing instead of breaking it', () => {
  // One corrupt file must not hide every other show from the operator.
  const dir = tmp()
  try {
    writeShow(dir, 'Good', [MUTE_7])
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json at all')
    assert.deepEqual(listShows(dir).map((s) => s.id), ['good'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('reading a corrupt show reports the show by name', () => {
  const dir = tmp()
  try {
    fs.writeFileSync(path.join(dir, 'bad.json'), 'not json at all')
    assert.throws(() => readShow(dir, 'bad'), /bad/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a show id cannot escape the shows directory', () => {
  // ids arrive from HTTP and IPC, so they are untrusted input.
  const dir = tmp()
  try {
    for (const bad of ['../config', 'a/b', 'a\\b', '..', '']) {
      assert.throws(() => readShow(dir, bad), /show/i, `expected ${JSON.stringify(bad)} to be refused`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a show removes it from the listing', () => {
  const dir = tmp()
  try {
    writeShow(dir, 'Gala', [MUTE_7])
    writeShow(dir, 'Keep', [FADER_1])
    deleteShow(dir, 'gala')
    assert.deepEqual(listShows(dir).map((s) => s.id), ['keep'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('deleting a show that is not there is refused, not silent', () => {
  const dir = tmp()
  try {
    assert.throws(() => deleteShow(dir, 'nope'), /nope/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
