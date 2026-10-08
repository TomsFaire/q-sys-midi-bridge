/**
 * Prints which mute LED each MIDImix button will show, derived from the live
 * config exactly the way the bridge derives it — plus whether the installed
 * app actually contains that derivation.
 *
 * Since 0.2.13 the lamps are not configurable: a mapping with
 * `midi.type: "note_on"` and `qsys.type: "toggle"` lights its own button and
 * subscribes its own control. So "the LED is tracking the wrong thing" is
 * always one of three things, and this script tells you which:
 *
 *   1. the installed app predates the change  → VERSION section says so
 *   2. the mapping does not say what you think → LAMPS section shows the truth
 *   3. the mapping cannot carry a lamp at all  → listed under NO LAMP
 *
 * Usage:  node scripts/check-leds.mjs [path/to/config.json]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const APP = '/Applications/MIDI Q-Sys Bridge.app'
const USER_CONFIG = path.join(
  os.homedir(),
  'Library/Application Support/midi-qsys-bridge/config.json',
)

/** The MIDImix lamps, by note number. Everything else is a button with no LED. */
const BUTTONS = new Map([
  ...[1, 4, 7, 10, 13, 16, 19, 22].map((n, i) => [n, `Mute ${i + 1}`]),
  ...[3, 6, 9, 12, 15, 18, 21, 24].map((n, i) => [n, `Rec Arm ${i + 1}`]),
])

/** Matches `stripComments` in src/main/config.ts. */
const parseJsonc = (text) =>
  JSON.parse(text.replace(/\/\/[^\n]*/g, '').replace(/,(\s*[}\]])/g, '$1'))

function reportVersion() {
  console.log('VERSION')
  if (!fs.existsSync(APP)) {
    console.log(`  no app at ${APP}`)
    return
  }
  const plist = fs.readFileSync(path.join(APP, 'Contents/Info.plist'), 'utf8')
  const version = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)/)?.[1]
  const asar = path.join(APP, 'Contents/Resources/app.asar')
  const derives = fs.existsSync(asar) && fs.readFileSync(asar).includes('deriveLeds')

  console.log(`  installed: ${version ?? 'unknown'}`)
  console.log(
    derives
      ? '  derives LEDs from mappings: yes'
      : '  derives LEDs from mappings: NO — this build predates 0.2.13, the lamps\n' +
        '    still come from the old feedback.mute_leds array. Install the new build.',
  )
}

function reportLamps(configPath) {
  console.log(`\nLAMPS  (from ${configPath})`)
  const config = parseJsonc(fs.readFileSync(configPath, 'utf8'))

  const lamps = []
  const noLamp = []
  for (const m of config.mappings ?? []) {
    const { midi, qsys } = m
    if (qsys?.type !== 'toggle') continue
    if (midi?.type !== 'note_on') {
      noLamp.push(`${m.label ?? '(unlabelled)'} — bound to ${midi?.type} ${midi?.number}, not a note`)
      continue
    }
    lamps.push({
      button: BUTTONS.get(midi.number) ?? `note ${midi.number}`,
      note: midi.number,
      target: `${qsys.component}:${qsys.control}`,
      label: m.label ?? '',
    })
  }

  if (config.feedback?.enabled === false) {
    console.log('  feedback.enabled is false — every lamp is suppressed.')
  }
  for (const l of lamps.sort((a, b) => a.note - b.note)) {
    console.log(`  ${l.button.padEnd(11)} note ${String(l.note).padStart(2)}  shows  ${l.target}`)
  }
  if (!lamps.length) console.log('  no note_on toggle mappings — nothing will light')

  if (noLamp.length) {
    console.log('\nNO LAMP  (a toggle on a knob has no LED to light)')
    for (const n of noLamp) console.log(`  ${n}`)
  }

  // Two buttons pointed at one control means one of them can never be right.
  const byTarget = new Map()
  for (const l of lamps) byTarget.set(l.target, [...(byTarget.get(l.target) ?? []), l.button])
  const clashes = [...byTarget].filter(([, b]) => b.length > 1)
  if (clashes.length) {
    console.log('\nCLASH  (same control on more than one button — both lamps will track it)')
    for (const [target, buttons] of clashes) console.log(`  ${target} → ${buttons.join(', ')}`)
  }

  if (config.feedback?.mute_leds) {
    console.log('\nNOTE  feedback.mute_leds is still present in this config. It is ignored;')
    console.log('      the lamps above come from mappings. You can delete it.')
  }
}

const configPath = process.argv[2] ?? USER_CONFIG
if (!fs.existsSync(configPath)) {
  console.error(`No config at ${configPath}`)
  process.exit(1)
}
reportVersion()
reportLamps(configPath)
