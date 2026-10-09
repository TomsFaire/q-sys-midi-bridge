/**
 * router-follow — pure logic for "Knob A follows the input router".
 *
 * Input.Router has boolean crosspoints named `output.N.input.M.select`.
 * Outputs 1-8 feed Mic 1-8 (the primary faders). Inputs 1-8 are Analog,
 * 9-16 Flex, 17-24 Dante. When the setting is on, Knob A N is pointed at the
 * gain control of whichever source is routed to output N. The result is stored
 * as an ordinary component_control mapping, so it stays editable by hand.
 */

import type { Mapping, QsysRef } from './config.js'

export type SourceKind = 'analog' | 'flex' | 'dante'

export interface SourceSpec {
  component: string
  /** Control name; `{n}` is replaced with the port number within the group (1-8). */
  control: string
  min: number
  max: number
}

export interface FollowRouterConfig {
  enabled: boolean
  router: string
  sources: Record<SourceKind, SourceSpec>
}

export const STRIPS = 8
export const INPUTS_PER_GROUP = 8
export const ROUTER_INPUTS = 24

// Knob A 1-8 are CC ch4 #22-29 (see PHYSICAL_CONTROLS in mapping-service.ts).
export const KNOB_A_CHANNEL = 4
export const KNOB_A_FIRST_CC = 22

// Component names are the Q-SYS script names, not the block labels shown in
// Designer (the Dante block is labelled "Software-Dante-RX-1" but scripts as
// "Dante.Input"). A source with a blank component is skipped and reported.
export const DEFAULT_FOLLOW_ROUTER: FollowRouterConfig = {
  enabled: false,
  router: 'Input.Router',
  sources: {
    analog: { component: 'Analog.Inputs', control: 'channel.{n}.preamp.gain', min: -100, max: 20 },
    flex: { component: 'Flex.Input', control: 'channel.{n}.preamp.gain', min: -100, max: 20 },
    dante: { component: 'Dante.Input', control: 'channel.{n}.input.gain', min: -100, max: 20 },
  },
}

export function resolveFollowConfig(partial?: Partial<FollowRouterConfig> | null): FollowRouterConfig {
  const d = DEFAULT_FOLLOW_ROUTER
  const s = (partial?.sources ?? {}) as Partial<Record<SourceKind, Partial<SourceSpec>>>
  return {
    enabled: partial?.enabled === true,
    router: partial?.router || d.router,
    sources: {
      analog: { ...d.sources.analog, ...s.analog },
      flex: { ...d.sources.flex, ...s.flex },
      dante: { ...d.sources.dante, ...s.dante },
    },
  }
}

const CROSSPOINT = /^output\.(\d+)\.input\.(\d+)\.select$/

export function parseCrosspoint(name: string): { output: number; input: number } | null {
  const m = CROSSPOINT.exec(name)
  return m ? { output: Number(m[1]), input: Number(m[2]) } : null
}

/** Names of every crosspoint a follower needs to watch (outputs 1-8 only). */
export function watchedCrosspoints(): string[] {
  const names: string[] = []
  for (let out = 1; out <= STRIPS; out++) {
    for (let inp = 1; inp <= ROUTER_INPUTS; inp++) names.push(`output.${out}.input.${inp}.select`)
  }
  return names
}

export function inputToSource(input: number): { kind: SourceKind; n: number } | null {
  if (!Number.isInteger(input) || input < 1 || input > ROUTER_INPUTS) return null
  const group = Math.floor((input - 1) / INPUTS_PER_GROUP)
  return { kind: (['analog', 'flex', 'dante'] as const)[group], n: ((input - 1) % INPUTS_PER_GROUP) + 1 }
}

/** The gain control for a router input, or null when its component is not configured. */
export function gainRefForInput(input: number, cfg: FollowRouterConfig): QsysRef | null {
  const src = inputToSource(input)
  if (!src) return null
  const spec = cfg.sources[src.kind]
  if (!spec.component) return null
  return {
    type: 'component_control',
    component: spec.component,
    control: spec.control.replace('{n}', String(src.n)),
    min: spec.min,
    max: spec.max,
  }
}

/** Reduce Input.Router control values to { output → routed input } for outputs 1-8. */
export function routesFromControls(controls: Array<{ Name: string; Value?: unknown }>): Map<number, number> {
  const routes = new Map<number, number>()
  for (const c of controls) {
    const cp = parseCrosspoint(c.Name)
    if (!cp || cp.output < 1 || cp.output > STRIPS) continue
    if (c.Value === true || (typeof c.Value === 'number' && c.Value > 0)) routes.set(cp.output, cp.input)
  }
  return routes
}

export interface AutoMapResult {
  mappings: Mapping[]
  /** Strips whose mapping was rewritten. */
  changed: number[]
  /** Strips that could not be mapped, with the reason. */
  skipped: Array<{ strip: number; reason: string }>
}

function sameTarget(a: QsysRef, b: QsysRef): boolean {
  return a.type === b.type && a.component === b.component && a.control === b.control &&
    a.min === b.min && a.max === b.max
}

/**
 * Point Knob A N at the gain control of the source routed to output N.
 * `only` limits the rewrite to those strips; other knobs are left untouched.
 */
export function autoMapKnobA(
  mappings: Mapping[],
  routes: Map<number, number>,
  cfg: FollowRouterConfig,
  only?: number[],
): AutoMapResult {
  const out = mappings.map((m) => ({ ...m }))
  const changed: number[] = []
  const skipped: Array<{ strip: number; reason: string }> = []

  for (let strip = 1; strip <= STRIPS; strip++) {
    if (only && !only.includes(strip)) continue
    const input = routes.get(strip)
    if (input === undefined) {
      skipped.push({ strip, reason: 'no route found' })
      continue
    }
    const ref = gainRefForInput(input, cfg)
    if (!ref) {
      const src = inputToSource(input)
      skipped.push({ strip, reason: src ? `${src.kind} component not configured` : `unknown input ${input}` })
      continue
    }
    const cc = KNOB_A_FIRST_CC + strip - 1
    const idx = out.findIndex((m) => m.midi.type === 'cc' && m.midi.channel === KNOB_A_CHANNEL && m.midi.number === cc)
    if (idx === -1) {
      out.push({ label: `Knob A ${strip}`, midi: { type: 'cc', channel: KNOB_A_CHANNEL, number: cc }, qsys: ref })
      changed.push(strip)
    } else if (!sameTarget(out[idx].qsys, ref)) {
      out[idx] = { ...out[idx], qsys: ref }
      changed.push(strip)
    }
  }
  return { mappings: out, changed, skipped }
}

/** What the mapping pages (desktop IPC and browser HTTP) need from the running bridge. */
export interface FollowRouterControl {
  isEnabled(): boolean
  setEnabled(enabled: boolean): Promise<void>
  autoMap(): Promise<AutoMapResult>
}
