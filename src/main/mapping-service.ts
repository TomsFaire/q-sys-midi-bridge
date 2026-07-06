/**
 * mapping-service — shared mapping data/read/write/discovery logic used by
 * both the desktop Configurator (IPC) and the browser-based mappings page
 * (HTTP). Neither caller owns this data; both call into these functions so
 * validation and file I/O aren't duplicated between the two.
 */

import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { stripComments } from './config.js'
import type { Mapping } from './config.js'

// ── Physical controls ─────────────────────────────────────────────────────────
// Hardcoded from the midi-learn session. All 51 controls, in layout order.

export type ControlType = 'fader' | 'knob' | 'toggle'

export interface PhysicalControl {
  id: string
  label: string
  group: string
  controlType: ControlType
  midi: { type: 'cc' | 'note_on'; channel: number; number: number }
}

const m = (type: 'cc' | 'note_on', channel: number, number: number) =>
  ({ type, channel, number } as const)

export const PHYSICAL_CONTROLS: PhysicalControl[] = [
  // ── Faders ────────────────────────────────────────────────────────────────
  { id: 'F1', label: 'Fader 1', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 22) },
  { id: 'F2', label: 'Fader 2', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 23) },
  { id: 'F3', label: 'Fader 3', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 24) },
  { id: 'F4', label: 'Fader 4', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 25) },
  { id: 'F5', label: 'Fader 5', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 26) },
  { id: 'F6', label: 'Fader 6', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 27) },
  { id: 'F7', label: 'Fader 7', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 28) },
  { id: 'F8', label: 'Fader 8', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 29) },
  { id: 'FM', label: 'Master Fader', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 30) },
  // ── Knobs A (top row) ────────────────────────────────────────────────────
  { id: 'Ka1', label: 'Knob A 1', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 22) },
  { id: 'Ka2', label: 'Knob A 2', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 23) },
  { id: 'Ka3', label: 'Knob A 3', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 24) },
  { id: 'Ka4', label: 'Knob A 4', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 25) },
  { id: 'Ka5', label: 'Knob A 5', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 26) },
  { id: 'Ka6', label: 'Knob A 6', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 27) },
  { id: 'Ka7', label: 'Knob A 7', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 28) },
  { id: 'Ka8', label: 'Knob A 8', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 29) },
  // ── Knobs B (middle row) ─────────────────────────────────────────────────
  { id: 'Kb1', label: 'Knob B 1', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 22) },
  { id: 'Kb2', label: 'Knob B 2', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 23) },
  { id: 'Kb3', label: 'Knob B 3', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 24) },
  { id: 'Kb4', label: 'Knob B 4', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 25) },
  { id: 'Kb5', label: 'Knob B 5', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 26) },
  { id: 'Kb6', label: 'Knob B 6', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 27) },
  { id: 'Kb7', label: 'Knob B 7', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 28) },
  { id: 'Kb8', label: 'Knob B 8', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 29) },
  // ── Knobs C (bottom row) ─────────────────────────────────────────────────
  { id: 'Kc1', label: 'Knob C 1', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 22) },
  { id: 'Kc2', label: 'Knob C 2', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 23) },
  { id: 'Kc3', label: 'Knob C 3', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 24) },
  { id: 'Kc4', label: 'Knob C 4', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 25) },
  { id: 'Kc5', label: 'Knob C 5', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 26) },
  { id: 'Kc6', label: 'Knob C 6', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 27) },
  { id: 'Kc7', label: 'Knob C 7', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 28) },
  { id: 'Kc8', label: 'Knob C 8', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 29) },
  // ── Mutes ────────────────────────────────────────────────────────────────
  { id: 'M1', label: 'Mute 1', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 22) },
  { id: 'M2', label: 'Mute 2', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 23) },
  { id: 'M3', label: 'Mute 3', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 24) },
  { id: 'M4', label: 'Mute 4', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 25) },
  { id: 'M5', label: 'Mute 5', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 26) },
  { id: 'M6', label: 'Mute 6', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 27) },
  { id: 'M7', label: 'Mute 7', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 28) },
  { id: 'M8', label: 'Mute 8', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 29) },
  // ── Rec Arms ─────────────────────────────────────────────────────────────
  { id: 'RA1', label: 'Rec Arm 1', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 22) },
  { id: 'RA2', label: 'Rec Arm 2', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 23) },
  { id: 'RA3', label: 'Rec Arm 3', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 24) },
  { id: 'RA4', label: 'Rec Arm 4', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 25) },
  { id: 'RA5', label: 'Rec Arm 5', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 26) },
  { id: 'RA6', label: 'Rec Arm 6', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 27) },
  { id: 'RA7', label: 'Rec Arm 7', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 28) },
  { id: 'RA8', label: 'Rec Arm 8', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 29) },
  // ── Bottom buttons ────────────────────────────────────────────────────────
  { id: 'BANKL',   label: 'Bank Left',  group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 25) },
  { id: 'BANKR',   label: 'Bank Right', group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 26) },
  { id: 'SOLO',    label: 'Solo',       group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 27) },
]

// ── Config file read/write ───────────────────────────────────────────────────

function parseConfigFile(raw: string): Record<string, unknown> {
  return JSON.parse(stripComments(raw)) as Record<string, unknown>
}

export function loadMappings(configFilePath: string): Mapping[] {
  const raw = fs.readFileSync(configFilePath, 'utf-8')
  const config = parseConfigFile(raw)
  return (config.mappings as Mapping[] | undefined) ?? []
}

export function saveMappings(configFilePath: string, mappings: Mapping[]): void {
  const raw = fs.readFileSync(configFilePath, 'utf-8')
  const config = parseConfigFile(raw)
  config.mappings = mappings
  fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8')
}

export async function saveAndApplyMappings(
  configFilePath: string,
  mappings: Mapping[],
  onReload?: () => Promise<void>,
): Promise<void> {
  saveMappings(configFilePath, mappings)
  if (onReload) await onReload()
}

// ── Q-Sys discovery ───────────────────────────────────────────────────────────

export async function discoverComponents(qrc: QrcClient | null): Promise<Array<{ name: string; type: string }>> {
  if (!qrc?.isConnected) {
    throw new Error('Q-SYS not connected — check host in config.json')
  }
  const result = await qrc.call('Component.GetComponents', {})
  const list: Array<{ Name: string; Type?: string }> =
    Array.isArray(result) ? result :
    (result as Record<string, unknown>)?.Components as Array<{ Name: string; Type?: string }> ?? []
  return list
    .map(c => ({ name: c.Name, type: c.Type ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getComponentControls(qrc: QrcClient | null, componentName: string): Promise<Array<{ name: string; isBoolean: boolean }>> {
  if (!qrc?.isConnected) return []
  try {
    const result = await qrc.call('Component.GetControls', { Name: componentName }) as Record<string, unknown>
    const controls = (result?.Controls ?? []) as Array<{ Name: string; Value: unknown }>
    return controls.map(c => ({
      name: c.Name,
      // Infer whether this is a boolean/toggle control vs continuous
      isBoolean: typeof c.Value === 'boolean' || c.Value === 0 || c.Value === 1
        ? c.Name.match(/mute|bypass|enable|power|solo|on$/i) !== null
        : false,
    }))
  } catch {
    // GetControls may not exist on all Q-SYS versions — caller falls back to text input
    return []
  }
}

// ── Validation (used by the HTTP save/apply endpoints before writing) ──────

export interface MappingValidationError { index: number; reason: string }

export function validateMappings(
  mappings: unknown,
): { valid: true; mappings: Mapping[] } | { valid: false; errors: MappingValidationError[] } {
  if (!Array.isArray(mappings)) {
    return { valid: false, errors: [{ index: -1, reason: 'mappings must be an array' }] }
  }
  const errors: MappingValidationError[] = []
  const validTypes = new Set(['component_control', 'toggle', 'named_control', 'snapshot'])
  mappings.forEach((entry, index) => {
    const e = entry as Record<string, unknown>
    const midi = e?.midi as Record<string, unknown> | undefined
    const qsys = e?.qsys as Record<string, unknown> | undefined
    if (!midi || (midi.type !== 'cc' && midi.type !== 'note_on')) {
      errors.push({ index, reason: 'midi.type must be "cc" or "note_on"' })
    } else if (typeof midi.channel !== 'number' || typeof midi.number !== 'number') {
      errors.push({ index, reason: 'midi.channel and midi.number must be numbers' })
    }
    if (!qsys || typeof qsys.type !== 'string' || !validTypes.has(qsys.type as string)) {
      errors.push({ index, reason: `qsys.type must be one of ${[...validTypes].join(', ')}` })
    }
  })
  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, mappings: mappings as Mapping[] }
}
