/**
 * Recalling a show into the live config.
 *
 * The ordering here is the whole safety story, and it is what these tests
 * pin: validate first and write nothing if it fails; back up before
 * mutating and abort if the backup cannot be written; only then touch
 * config.json. A recall you cannot undo is not safe enough to perform.
 *
 * The backup is itself a show file, in the same format, under shows/_auto.
 * That makes "undo" the same operation as "recall" rather than a second
 * mechanism with its own bugs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  recallShow,
  writeShow,
  listShows,
  listAutoBackups,
  autoDirFor,
  pruneAutoBackups,
} from './show-service.js'
import type { Mapping, Config } from './config.js'

/**
 * A temp root plus the shows directory inside it. They are separate in
 * production — config.json lives beside `shows/`, not in it — and the
 * separation matters: any .json holding a `mappings` array parses as a show,
 * so a config sharing the directory would list itself as one.
 */
function tmp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-recall-'))
  fs.mkdirSync(path.join(root, 'shows'), { recursive: true })
  return root
}

/** The shows directory for a temp root. */
const showsIn = (root: string) => path.join(root, 'shows')

const MUTE_7: Mapping = {
  label: 'Mute 7',
  midi: { type: 'cc', channel: 1, number: 28 },
  qsys: { type: 'toggle', component: 'Mic.08.Gain', control: 'mute' },
}
const MUTE_1: Mapping = {
  label: 'Mute 1',
  midi: { type: 'cc', channel: 1, number: 22 },
  qsys: { type: 'toggle', component: 'Mic.01.Gain', control: 'mute' },
}

/** A config with everything a recall must leave alone. */
function writeConfig(dir: string, mappings: Mapping[]): string {
  const config: Config = {
    qsys: { host: '192.168.1.50', port: 1710, username: 'admin', password: 'secret' },
    midi: { deviceName: 'MIDI Mix' },
    mappings,
    feedback: { enabled: true },
    uci: { enabled: true, port: 3001 },
  }
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

const readConfig = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Config

// ── the happy path ───────────────────────────────────────────────────────────

test('recalling a show replaces the live mappings and reloads once', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])

    let reloads = 0
    const result = await recallShow(showsIn(dir), 'gala', configFile, async () => { reloads++ })

    assert.equal(reloads, 1)
    assert.equal(result.name, 'Gala')
    assert.equal(result.count, 1)
    assert.deepEqual(readConfig(configFile).mappings, [MUTE_7])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a recall leaves the Core connection and every other setting untouched', async () => {
  // This is the portability guarantee: a show from another rig must never
  // be able to repoint the bridge at that rig's Core.
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])
    const before = readConfig(configFile)

    await recallShow(showsIn(dir), 'gala', configFile)

    const after = readConfig(configFile)
    assert.deepEqual(after.qsys, before.qsys)
    assert.deepEqual(after.midi, before.midi)
    assert.deepEqual(after.uci, before.uci)
    assert.deepEqual(after.feedback, before.feedback)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a recall records which show is live', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])

    await recallShow(showsIn(dir), 'gala', configFile)

    const active = readConfig(configFile).activeShow
    assert.equal(active?.id, 'gala')
    assert.equal(active?.name, 'Gala')
    assert.ok(Date.parse(active!.appliedAt) > 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('activeShow and mappings land in a single write', async () => {
  // Two writes would leave a window where the config names one show but
  // holds another's mappings — and a crash in between makes it permanent.
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])

    let seen = 0
    await recallShow(showsIn(dir), 'gala', configFile, async () => {
      // By the time anything reloads, both must already be on disk.
      const c = readConfig(configFile)
      assert.deepEqual(c.mappings, [MUTE_7])
      assert.equal(c.activeShow?.id, 'gala')
      seen++
    })
    assert.equal(seen, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── refusal paths: nothing may be written ────────────────────────────────────

test('an invalid show is refused and the config is left byte-identical', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    const before = fs.readFileSync(configFile, 'utf-8')
    // A structurally wrong mapping: validateMappings rejects the qsys type.
    writeShow(showsIn(dir), 'Bad', [{ midi: { type: 'cc', channel: 1, number: 28 },
                             qsys: { type: 'nonsense' } } as unknown as Mapping])

    let reloads = 0
    await assert.rejects(
      () => recallShow(showsIn(dir), 'bad', configFile, async () => { reloads++ }),
      /invalid|valid/i,
    )

    assert.equal(fs.readFileSync(configFile, 'utf-8'), before, 'config must not change')
    assert.equal(reloads, 0, 'nothing should have reloaded')
    assert.deepEqual(listAutoBackups(autoDirFor(showsIn(dir))), [], 'no backup should have been taken')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing show is refused before anything is written', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    const before = fs.readFileSync(configFile, 'utf-8')

    await assert.rejects(() => recallShow(showsIn(dir), 'nope', configFile), /nope/)
    assert.equal(fs.readFileSync(configFile, 'utf-8'), before)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a recall that cannot be backed up does not happen at all', async () => {
  // Disk full or a read-only volume. A recall with no undo is exactly the
  // irreversible thing the backup exists to prevent, so refuse instead.
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])
    const before = fs.readFileSync(configFile, 'utf-8')

    // Occupy the auto-backup directory name with a regular file.
    fs.writeFileSync(autoDirFor(showsIn(dir)), 'not a directory')

    let reloads = 0
    await assert.rejects(
      () => recallShow(showsIn(dir), 'gala', configFile, async () => { reloads++ }),
      /back ?up/i,
    )
    assert.equal(fs.readFileSync(configFile, 'utf-8'), before)
    assert.equal(reloads, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── backups and undo ─────────────────────────────────────────────────────────

test('a recall backs up what was live, as a recallable show', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])

    await recallShow(showsIn(dir), 'gala', configFile)

    const backups = listAutoBackups(autoDirFor(showsIn(dir)))
    assert.equal(backups.length, 1)
    assert.match(backups[0].name, /Gala/, 'the backup should name the show it preceded')
    assert.deepEqual(backups[0].mappings, [MUTE_1], 'it should hold the pre-recall mappings')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('undo is just recalling the backup, and restores the previous surface', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])

    await recallShow(showsIn(dir), 'gala', configFile)
    assert.deepEqual(readConfig(configFile).mappings, [MUTE_7])

    const backup = listAutoBackups(autoDirFor(showsIn(dir)))[0]
    await recallShow(autoDirFor(showsIn(dir)), backup.id, configFile)

    assert.deepEqual(readConfig(configFile).mappings, [MUTE_1], 'undo should restore the old surface')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('auto-backups do not clutter the show list', async () => {
  const dir = tmp()
  try {
    const configFile = writeConfig(dir, [MUTE_1])
    writeShow(showsIn(dir), 'Gala', [MUTE_7])
    await recallShow(showsIn(dir), 'gala', configFile)

    assert.deepEqual(listShows(showsIn(dir)).map((s) => s.id), ['gala'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('backups are pruned to the newest few, newest first', async () => {
  const dir = tmp()
  try {
    const auto = autoDirFor(showsIn(dir))
    fs.mkdirSync(auto, { recursive: true })
    for (let i = 1; i <= 5; i++) {
      const s = writeShow(auto, `backup ${i}`, [MUTE_1])
      // Force distinct, increasing stamps so ordering is deterministic.
      const p = path.join(auto, `${s.id}.json`)
      const show = JSON.parse(fs.readFileSync(p, 'utf-8'))
      show.savedAt = `2026-01-0${i}T00:00:00.000Z`
      fs.writeFileSync(p, JSON.stringify(show))
    }

    pruneAutoBackups(auto, 3)

    const left = listAutoBackups(auto)
    assert.equal(left.length, 3)
    assert.deepEqual(left.map((b) => b.name), ['backup 5', 'backup 4', 'backup 3'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
