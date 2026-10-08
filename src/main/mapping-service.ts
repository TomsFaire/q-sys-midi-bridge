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

// The physical surface lives in physical-surface.ts, which the mapping
// engine also reads for lamp notes. Re-exported so existing importers of
// mapping-service keep working.
export type { ControlType, PhysicalControl } from './physical-surface.js'
export { PHYSICAL_CONTROLS } from './physical-surface.js'

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
  // A gang needs a component to inherit, so named_control and snapshot can't
  // carry one. Rejecting rather than ignoring keeps a typo from silently
  // moving only one leg of a pair.
  const linkableTypes = new Set(['component_control', 'toggle'])
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
    if (qsys?.link !== undefined) {
      const link = qsys.link
      if (typeof link !== 'object' || link === null || Array.isArray(link)) {
        errors.push({ index, reason: 'qsys.link must be an object' })
      } else {
        const l = link as Record<string, unknown>
        const named = (v: unknown) => typeof v === 'string' && v.trim() !== ''
        if (!named(l.component) && !named(l.control)) {
          errors.push({ index, reason: 'qsys.link must name a component, a control, or both' })
        } else if (!linkableTypes.has(qsys.type as string)) {
          errors.push({ index, reason: 'qsys.link is only valid on component_control and toggle mappings' })
        }
      }
    }
  })
  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, mappings: mappings as Mapping[] }
}
