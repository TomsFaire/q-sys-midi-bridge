import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface QsysRef {
  type: 'component_control' | 'toggle' | 'named_control' | 'snapshot'
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
}

export interface MidiRef {
  type: 'cc' | 'note_on'
  channel: number  // 1-indexed
  number: number   // CC number or note number
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

export interface Config {
  qsys: { host: string; port: number }
  midi: { deviceName: string }
  mappings: Mapping[]
  feedback: { enabled: boolean; mute_leds: FeedbackLED[] }
  // UCI web server (serves foh-uci.html + relays browser WS to the Core).
  // Defaults when absent: enabled: true, port: 3001.
  uci?: { enabled?: boolean; port?: number }
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
