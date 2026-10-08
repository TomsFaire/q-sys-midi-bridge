/**
 * Repairs toggle mappings that were written to a button's LAMP note instead of
 * its input address.
 *
 * 0.2.13 briefly addressed the mute and Rec Arm buttons as Note On, following
 * docs/bugfix-mute-midi-type.md, which describes the MIDImix factory layout.
 * This rig runs a custom preset where those buttons send CC, so any mapping
 * saved through the editor during that window points at an address the
 * controller never sends: the button does nothing and lights nothing.
 *
 * The note it was written to is the button's lamp, so the button is still
 * identifiable. This rewrites each such mapping to that button's real input
 * address, leaving the Q-SYS target untouched.
 *
 * Usage:  node scripts/fix-button-addresses.mjs [--write] [path/to/config.json]
 *         Prints what it would change; --write applies it after a backup.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PHYSICAL_CONTROLS } from '../dist/main/physical-surface.js'

const write = process.argv.includes('--write')
const configPath =
  process.argv.slice(2).find((a) => !a.startsWith('--')) ??
  path.join(os.homedir(), 'Library/Application Support/midi-qsys-bridge/config.json')

const addr = (m) => `${m.type}:${m.channel}:${m.number}`
const BY_INPUT = new Map(PHYSICAL_CONTROLS.map((pc) => [addr(pc.midi), pc]))
/** Buttons keyed by the lamp note they drive — how a mis-addressed mapping is traced back. */
const BY_LAMP = new Map(
  PHYSICAL_CONTROLS.filter((pc) => pc.led).map((pc) => [`${pc.led.channel}:${pc.led.note}`, pc]),
)

const raw = fs.readFileSync(configPath, 'utf8')
const config = JSON.parse(raw.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1'))

const fixes = []
for (const m of config.mappings ?? []) {
  if (m.qsys?.type !== 'toggle') continue
  if (BY_INPUT.has(addr(m.midi))) continue // already a real input address
  if (m.midi?.type !== 'note_on') continue
  const pc = BY_LAMP.get(`${m.midi.channel}:${m.midi.number}`)
  if (!pc || BY_INPUT.get(addr(pc.midi))?.id !== pc.id) continue
  fixes.push({ m, pc, from: { ...m.midi } })
  m.midi = { type: pc.midi.type, channel: pc.midi.channel, number: pc.midi.number }
}

if (!fixes.length) {
  console.log(`Nothing to fix in ${configPath} — every toggle already sits on a real button.`)
  process.exit(0)
}

console.log(`${fixes.length} mapping(s) addressed to a lamp note instead of a button:\n`)
for (const { m, pc, from } of fixes) {
  console.log(
    `  ${pc.label.padEnd(10)} ${m.label ?? ''}`.trimEnd() +
    `\n      was  ${from.type} ch${from.channel} ${from.number}   (that is the lamp, not the button)` +
    `\n      now  ${m.midi.type} ch${m.midi.channel} ${m.midi.number}   lamp stays note ${pc.led.note}` +
    `\n      -> ${m.qsys.component}:${m.qsys.control}\n`,
  )
}

if (!write) {
  console.log('Dry run. Re-run with --write to apply (a .bak is taken first).')
  process.exit(0)
}

const backup = `${configPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
fs.copyFileSync(configPath, backup)
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
console.log(`Backed up to ${backup}`)
console.log(`Wrote ${configPath}`)
console.log('Restart the bridge (or save once in the editor) to pick it up.')
