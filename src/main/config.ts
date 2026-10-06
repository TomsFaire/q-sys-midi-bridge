import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * A second Q-SYS target ganged to the primary one — the right leg of a stereo
 * pair. Either field may be omitted and is then inherited from the primary,
 * which covers both topologies: `{ component }` alone means "other component,
 * same control name", `{ control }` alone means "same component, other
 * control". Only meaningful on component_control and toggle.
 */
export interface QsysLink {
  component?: string
  control?: string
}

export interface QsysRef {
  type: 'component_control' | 'component_control_relative' | 'toggle' | 'named_control' | 'snapshot'
  // component_control / toggle
  component?: string
  control?: string
  // named_control
  name?: string
  // snapshot
  bank?: number
  slot?: number
  // scaling for CC mappings (dB range etc.)
  min?: number
  max?: number
  // component_control_relative: how far one encoder tick moves the value.
  // Defaults to 1 when absent. min/max clamp the result.
  step?: number
  // stereo gang — moves with the primary target
  link?: QsysLink
}

export interface MidiRef {
  // pitchbend is the MCU fader protocol: 14-bit, one MIDI channel per fader,
  // so it is addressed by channel alone and carries no number.
  type: 'cc' | 'note_on' | 'pitchbend'
  channel: number  // 1-indexed
  number?: number  // CC number or note number; absent for pitchbend
}

export interface Mapping {
  label?: string
  midi: MidiRef
  qsys: QsysRef
}

export interface FeedbackLED {
  component: string
  control: string
  midi: { channel: number; note: number }
}

/**
 * A motorised fader that follows a Q-SYS value. `midi.channel` is the pitch
 * bend channel (1-indexed), and min/max are the dB range the fader's full
 * travel spans — the same pair the inbound mapping scales with.
 */
export interface FaderFeedback {
  component: string
  control: string
  midi: { channel: number }
  min: number
  max: number
}

export interface Config {
  // username/password are only needed when the Core has Access Control
  // enabled; leave them out (or blank) for an open Core.
  qsys: { host: string; port: number; username?: string; password?: string }
  midi: { deviceName: string }
  mappings: Mapping[]
  // fader_positions is absent for a MIDImix rig, which has no motors.
  feedback: { enabled: boolean; mute_leds: FeedbackLED[]; fader_positions?: FaderFeedback[] }
  // UCI web server (serves foh-uci.html + relays browser WS to the Core).
  // Defaults when absent: enabled: true, port: 3001.
  uci?: { enabled?: boolean; port?: number; mappingsPasswordHash?: string }
}

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function stripComments(text: string): string {
  // Strip // line comments, then trailing commas before ] or }
  // (JSONC-style — lets us freely comment/uncomment entries without managing commas)
  return text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/,(\s*[}\]])/g, '$1')
}

export function loadConfig(): Config {
  const candidates = [
    path.join(app.getPath('userData'), 'config.json'),
    path.join(app.getAppPath(), 'config', 'config.json'),
    path.join(__dirname, '../../config/config.json'),
  ]

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8')
      return JSON.parse(stripComments(raw)) as Config
    }
  }

  throw new Error(
    `No config.json found. Create one at:\n  ${candidates[0]}\n\nCopy from the bundled config/config.json and edit.`
  )
}

export function getConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

/**
 * Ensure a writable config.json exists in userData.
 * On first launch after install, copies the bundled config there.
 * Must be called before loadConfig() / findConfigPath().
 */
export function seedUserConfig(): void {
  const dest = path.join(app.getPath('userData'), 'config.json')
  if (fs.existsSync(dest)) return

  const bundledCandidates = [
    path.join(app.getAppPath(), 'config', 'config.json'),
    path.join(__dirname, '../../config/config.json'),
  ]
  for (const src of bundledCandidates) {
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      console.log(`[Config] Seeded config.json to userData from ${src}`)
      return
    }
  }
}

/**
 * Returns the writable config path (userData).
 * Always writable — safe for the configurator to save to.
 */
export function findConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json')
}

export { stripComments }
