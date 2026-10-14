/**
 * Mapping Engine — translates incoming MIDI events into Q-Sys QRC calls.
 *
 * Lookup maps are built at construction from config.mappings.
 * Toggle state is tracked locally (optimistic — no round-trip GET needed).
 * Errors from QRC calls are logged but not thrown (fire and forget).
 */

import { QrcClient } from './qrc-client.js'
import { MidiIO } from './midi-io.js'
import type { Config, Mapping, QsysRef } from './config.js'
import { PHYSICAL_CONTROLS } from './physical-surface.js'
import { parseCrosspoint, resolveFollowConfig, routesFromControls, watchedCrosspoints, STRIPS } from './router-follow.js'
import { PickupGate, valueToCc } from './pickup.js'

/** One resolved Q-SYS write target. */
interface Target { component: string; control: string }

const CHANGE_GROUP_ID = 'mutes'

const keyOf = (t: Target): string => `${t.component}:${t.control}`

/**
 * The primary target, plus the ganged leg when `qsys.link` is set. A link
 * field left out is inherited from the primary, so `{ component }` alone
 * means "other component, same control" and `{ control }` alone means
 * "same component, other control".
 */
function resolveTargets(q: QsysRef): Target[] {
  const primary: Target = { component: q.component ?? '', control: q.control ?? '' }
  if (!q.link) return [primary]
  return [
    primary,
    {
      component: q.link.component ?? primary.component,
      control: q.link.control ?? primary.control,
    },
  ]
}

/** Minimum gap between attempts to re-read an unknown soft-takeover target, per knob. */
const TARGET_READ_RETRY_MS = 500

/** Knob A N's MIDI address ("channel:cc", the ccMap key) → strip N. */
const KNOB_A_STRIP = new Map<string, number>()
for (const pc of PHYSICAL_CONTROLS) {
  const m = /^Knob A (\d+)$/.exec(pc.label)
  if (m && pc.midi.type === 'cc') KNOB_A_STRIP.set(`${pc.midi.channel}:${pc.midi.number}`, Number(m[1]))
}

/** What a follow-managed knob writes to, or null when it is not soft-takeover material (stereo-linked, not a gain). */
function knobTarget(m: Mapping | undefined): { component: string; control: string; min: number; max: number } | null {
  const q = m?.qsys
  if (!q || q.type !== 'component_control' || q.link || !q.component || !q.control) return null
  return { component: q.component, control: q.control, min: q.min ?? 0, max: q.max ?? 1 }
}

const knobSig = (m: Mapping | undefined): string => {
  const t = knobTarget(m)
  return t ? `${t.component}|${t.control}|${t.min}|${t.max}` : ''
}

/** A lamp derived from a mapping: which control to watch, which note to light. */
interface DerivedLed {
  key: string
  component: string
  control: string
  midi: { channel: number; note: number }
}

/** Button labels by MIDI input address, for naming one in the activity log. */
const BUTTON_BY_ADDRESS = new Map(
  PHYSICAL_CONTROLS.filter((pc) => pc.controlType === 'toggle').map((pc) => [
    `${pc.midi.type}:${pc.midi.channel}:${pc.midi.number}`,
    pc.label,
  ]),
)

/** Every physical control that owns a lamp, by its MIDI input address. */
const LAMP_BY_ADDRESS = new Map(
  PHYSICAL_CONTROLS.filter((pc) => pc.led).map((pc) => [
    `${pc.midi.type}:${pc.midi.channel}:${pc.midi.number}`,
    pc.led!,
  ]),
)

/**
 * The LED map, derived from the mappings themselves.
 *
 * A mapping says which button is involved (its MIDI address) and which Q-SYS
 * control it drives. The lamp comes from the button: on this surface a button
 * SENDS a CC but LIGHTS on a Note On at a different number, so the note cannot
 * be read off the mapping — it is a fixed property of the hardware, held in
 * PHYSICAL_CONTROLS. Joining the two makes the button assignment the single
 * source of truth, so reassigning a button during a show moves its lamp and
 * its Core subscription with it.
 *
 * Skipped: non-toggle targets (a gain has no on/off to show) and any address
 * with no lamp behind it (faders, knobs). The ganged leg follows the primary
 * rather than lighting a lamp of its own, matching how `execute` drives a
 * linked pair.
 */
function deriveLeds(config: Config): DerivedLed[] {
  const leds: DerivedLed[] = []
  for (const mapping of config.mappings) {
    if (mapping.qsys.type !== 'toggle') continue
    const lamp = LAMP_BY_ADDRESS.get(
      `${mapping.midi.type}:${mapping.midi.channel}:${mapping.midi.number}`,
    )
    if (!lamp) continue
    const primary = resolveTargets(mapping.qsys)[0]
    if (!primary.component || !primary.control) continue
    leds.push({
      key: keyOf(primary),
      component: primary.component,
      control: primary.control,
      midi: { channel: lamp.channel, note: lamp.note },
    })
  }
  return leds
}

export class MappingEngine {
  private qrc: QrcClient
  private midi: MidiIO
  private config: Config
  private ccMap = new Map<string, Mapping>()
  private noteMap = new Map<string, Mapping>()
  // Local toggle state cache: "component:control" → 0 | 1
  private toggleState = new Map<string, number>()
  // LED feedback: "component:control" → {channel, note}
  private ledMap = new Map<string, { channel: number; note: number }>()

  private recentActivity: string[] = []

  // Follow-router: last routed input per output (1-8), and the callback fired
  // when a route changes. The first state after (re)connect is a baseline and
  // does not fire, so hand-edited Knob A mappings survive a restart.
  private routes = new Map<number, number>()
  private routesBaselined = false
  // Set whenever the route picture was thrown away; the next completed baseline
  // then re-arms the knobs and fires onBaselined once (rebuilds do neither).
  private freshBaseline = true
  onRouteChange?: (strip: number, input: number) => void
  // Fired once per (re)baseline with follow enabled: the owner reconciles Knob A
  // against the routes now known.
  onBaselined?: () => void

  // Soft takeover for follow-managed Knob A (absolute knobs): a knob whose
  // strip was just pointed elsewhere is ignored until it reaches the target's
  // current position, so a live source never jumps to the knob's position.
  private gate = new PickupGate()
  private disarmNotice = new Set<string>()
  private readSeq = new Map<string, number>()
  private lastReadAt = new Map<string, number>()
  private now: () => number = () => Date.now()

  constructor(qrc: QrcClient, midi: MidiIO, config: Config) {
    this.qrc = qrc
    this.midi = midi
    this.config = config

    for (const mapping of config.mappings) {
      const key = `${mapping.midi.channel}:${mapping.midi.number}`
      if (mapping.midi.type === 'cc') {
        this.ccMap.set(key, mapping)
      } else {
        this.noteMap.set(key, mapping)
      }
    }

    for (const led of deriveLeds(config)) {
      this.ledMap.set(led.key, led.midi)
    }

    this.qrc.on('notification', (_id: string, result: unknown) => this.handleNotification(result))
  }

  handleCC(channel: number, cc: number, value: number): void {
    const mapping = this.ccMap.get(`${channel}:${cc}`)
    if (!mapping) {
      // Only for a button. An unmapped fader or knob streams CC continuously
      // and would bury the log under a single sweep.
      const button = BUTTON_BY_ADDRESS.get(`cc:${channel}:${cc}`)
      if (button && value > 0) this.log(`${button} — no mapping for this button`)
      return
    }
    // Toggle buttons (mutes, rec arm) send CC 127 on press and CC 0 on release.
    // Ignore the 0 so we don't double-fire and immediately undo the toggle.
    if (mapping.qsys.type === 'toggle' && value === 0) return
    if (this.followEnabled && !this.takeOver(`${channel}:${cc}`, mapping, value)) return
    this.execute(mapping, value).catch((err) => {
      console.error(`[Bridge] QRC error for "${mapping.label ?? 'unknown'}": ${err.message}`)
    })
  }

  handleNoteOn(channel: number, note: number): void {
    const mapping = this.noteMap.get(`${channel}:${note}`)
    if (!mapping) {
      this.log(`note ${channel}:${note} — no mapping for this button`)
      return
    }
    this.execute(mapping, 127).catch((err) => {
      console.error(`[Bridge] QRC error for "${mapping.label ?? 'unknown'}": ${err.message}`)
    })
  }

  get mappingCount(): number {
    return this.ccMap.size + this.noteMap.size
  }

  /** Swap the underlying QRC client (e.g. after a host change). */
  setQrc(qrc: QrcClient): void {
    this.qrc.removeAllListeners('notification')
    this.qrc = qrc
    this.resetRouteBaseline()
    this.qrc.on('notification', (_id: string, result: unknown) => this.handleNotification(result))
  }

  /** Hot-reload mappings from a new config without restarting the app. */
  reload(config: Config): void {
    // A lamp lit under the outgoing assignment has to be darkened here. The
    // Core only pushes changes to controls we are still watching, so once a
    // button moves off a component nothing will ever arrive to clear the lamp
    // it left behind — it would sit lit for the rest of the show.
    const lit = [...this.ledMap].filter(([key]) => this.toggleState.get(key) === 1)
    const wasFollow = this.followEnabled
    const before = new Map(this.ccMap)

    this.ccMap.clear()
    this.noteMap.clear()
    this.toggleState.clear()
    this.ledMap.clear()

    for (const mapping of config.mappings) {
      const key = `${mapping.midi.channel}:${mapping.midi.number}`
      if (mapping.midi.type === 'cc') this.ccMap.set(key, mapping)
      else this.noteMap.set(key, mapping)
    }
    for (const led of deriveLeds(config)) {
      this.ledMap.set(led.key, led.midi)
    }

    // Only lamps whose binding actually moved. One that still shows the same
    // control is left alone rather than blinked off and repainted by the poll.
    for (const [key, old] of lit) {
      if (this.ledMap.get(key)?.note === old.note) continue
      this.midi.sendNoteOff(old.channel, old.note)
    }

    this.config = config

    if (!this.followEnabled) {
      if (wasFollow) this.resetRouteBaseline()
    } else if (!wasFollow) {
      // Nothing was tracked while it was off, so routes and knob positions are both unknown.
      this.resetRouteBaseline()
      this.rearmKnobs(KNOB_A_STRIP.keys())
    } else {
      this.rearmKnobs([...KNOB_A_STRIP.keys()].filter((k) => knobSig(before.get(k)) !== knobSig(this.ccMap.get(k))))
    }
    console.log(`[Bridge] Mappings reloaded — ${this.ccMap.size} CC, ${this.noteMap.size} note, ${this.ledMap.size} LED`)
  }

  getRecentActivity(): string[] {
    return this.recentActivity.slice()
  }

  private get followEnabled(): boolean {
    return this.config.follow_router?.enabled === true
  }

  /** True once follow is on and the Core's current routing has been read. */
  get routesKnown(): boolean {
    return this.followEnabled && this.routesBaselined
  }

  /**
   * The route picture is unknown (new Core link, reconnect, follow just turned
   * on): forget it, so the next poll is a baseline again, and put every knob
   * back to "not yet picked up". A rebuild of the change group is NOT such a
   * moment — the routes held across it are still valid, and resetting there
   * would swallow the rest of a push that is still being processed.
   */
  resetRouteBaseline(): void {
    this.routes.clear()
    this.routesBaselined = false
    this.freshBaseline = true
    if (!this.followEnabled) {
      this.gate = new PickupGate()
      this.disarmNotice.clear()
      return
    }
    for (const key of KNOB_A_STRIP.keys()) {
      if (!knobTarget(this.ccMap.get(key))) continue
      this.gate.disarm(key, null)
      this.disarmNotice.delete(key)
    }
  }

  /** Disarm these knobs and read each one's target from the Core (in parallel). */
  private rearmKnobs(keys: Iterable<string>): void {
    for (const key of keys) {
      const t = knobTarget(this.ccMap.get(key))
      if (!t) continue
      this.gate.disarm(key, null)
      this.disarmNotice.delete(key)
      this.readKnobTarget(key, t)
    }
  }

  private readKnobTarget(key: string, t: { component: string; control: string; min: number; max: number }): void {
    const seq = (this.readSeq.get(key) ?? 0) + 1
    this.readSeq.set(key, seq)
    this.lastReadAt.set(key, this.now())
    if (!this.qrc.isConnected) return
    this.qrc.call('Component.Get', { Name: t.component, Controls: [{ Name: t.control }] })
      .then((res) => {
        // A newer read (the strip moved again meanwhile) owns the answer.
        if (this.readSeq.get(key) !== seq) return
        const controls = (res as { Controls?: Array<{ Name?: string; Value?: unknown }> } | undefined)?.Controls
        const value = (controls?.find((c) => c.Name === t.control) ?? controls?.[0])?.Value
        if (typeof value === 'number') this.gate.setTarget(key, valueToCc(value, t.min, t.max))
      })
      .catch((err) => console.error(`[Bridge] Could not read ${t.component}:${t.control} for soft takeover: ${err.message}`))
  }

  /** false => drop this CC: the knob has not yet reached the strip's current value. */
  private takeOver(key: string, mapping: Mapping, value: number): boolean {
    const strip = KNOB_A_STRIP.get(key)
    const t = strip ? knobTarget(mapping) : null
    if (!strip || !t) return true
    if (this.gate.accept(key, value)) return true
    const target = this.gate.pendingTarget(key)
    if (target === null) {
      if (this.now() - (this.lastReadAt.get(key) ?? 0) >= TARGET_READ_RETRY_MS) this.readKnobTarget(key, t)
    } else if (!this.disarmNotice.has(key)) {
      this.disarmNotice.add(key)
      this.log(`Knob A ${strip} — move to about ${target}/127 to take over`)
    }
    return false
  }

  private get followRouter() {
    return resolveFollowConfig(this.config.follow_router)
  }

  async setupChangeGroup(): Promise<void> {
    const follow = this.followRouter
    if (!this.config.feedback.enabled && !follow.enabled) return

    // AddComponentControl accumulates on a group id, so re-subscribing after a
    // reload would leave the component a button was reassigned away from
    // watched forever. Destroy first — the group is rebuilt from scratch below.
    // On the first connect there is no group yet and the Core may reject this;
    // that is the expected case, not a fault, so it stays out of the error log.
    await this.qrc.call('ChangeGroup.Destroy', { Id: CHANGE_GROUP_ID })
      .catch((err) => console.log(`[Bridge] No existing ChangeGroup to destroy (${err.message})`))

    const leds = this.config.feedback.enabled ? deriveLeds(this.config) : []
    if (leds.length === 0 && !follow.enabled) return

    // Group controls by component for the ChangeGroup subscription. Everything
    // goes into the one existing group: the Core has a small change-group budget.
    const byComponent = new Map<string, string[]>()
    for (const led of leds) {
      if (!byComponent.has(led.component)) byComponent.set(led.component, [])
      const controls = byComponent.get(led.component)!
      if (!controls.includes(led.control)) controls.push(led.control)
    }
    if (follow.enabled) {
      const controls = byComponent.get(follow.router) ?? []
      for (const c of watchedCrosspoints()) if (!controls.includes(c)) controls.push(c)
      byComponent.set(follow.router, controls)
    }

    for (const [component, controls] of byComponent) {
      await this.qrc.call('ChangeGroup.AddComponentControl', {
        Id: CHANGE_GROUP_ID,
        Component: {
          Name: component,
          Controls: controls.map((Name) => ({ Name })),
        },
      }).catch((err) => console.error(`[Bridge] ChangeGroup subscribe failed for ${component}: ${err.message}`))
    }

    // AutoPoll at 50ms — Q-Sys pushes changes over the existing TCP connection
    await this.qrc.call('ChangeGroup.AutoPoll', {
      Id: CHANGE_GROUP_ID,
      Rate: 0.05,
    }).catch((err) => console.error(`[Bridge] ChangeGroup AutoPoll failed: ${err.message}`))

    // Immediate poll to sync initial LED / route state on connect
    const initial = await this.qrc.call('ChangeGroup.Poll', { Id: CHANGE_GROUP_ID })
      .catch((err) => {
        console.error(`[Bridge] Initial ChangeGroup.Poll failed: ${err.message}`)
        return null
      })
    if (initial) this.handleNotification(initial)
    // Whatever the poll returned is the baseline; later changes are real route changes.
    this.routesBaselined = true
    if (this.followEnabled && this.freshBaseline) {
      this.freshBaseline = false
      this.rearmKnobs(KNOB_A_STRIP.keys())
      this.onBaselined?.()
    }

    console.log('[Bridge] ChangeGroup feedback active')
  }

  /** Current route per strip, as last seen from the Core. */
  getRoutes(): Map<number, number> {
    return new Map(this.routes)
  }

  /** Read the router fresh from the Core (used by the Auto-map button). */
  async readRoutes(): Promise<Map<number, number>> {
    if (!this.qrc.isConnected) throw new Error('Q-SYS not connected — check host in config.json')
    const result = await this.qrc.call('Component.GetControls', { Name: this.followRouter.router }) as
      { Controls?: Array<{ Name: string; Value?: unknown }> } | undefined
    return routesFromControls(result?.Controls ?? [])
  }

  syncLEDs(): void {
    for (const [key, val] of this.toggleState) {
      const led = this.ledMap.get(key)
      if (!led) continue
      if (val === 1) {
        this.midi.sendNoteOn(led.channel, led.note)
      } else {
        this.midi.sendNoteOff(led.channel, led.note)
      }
    }
  }

  private handleNotification(result: unknown): void {
    if (!result || typeof result !== 'object') return
    const r = result as { Changes?: Array<{ Component: string; Name: string; Value: number }> }
    if (!Array.isArray(r.Changes)) {
      console.warn('[Bridge] handleNotification: no Changes array in result')
      return
    }
    // An empty push is the AutoPoll clock ticking, not news.
    if (r.Changes.length === 0) return
    console.log('[Bridge] handleNotification:', JSON.stringify(r.Changes).slice(0, 200))

    const follow = this.followRouter
    for (const change of r.Changes) {
      // A crosspoint is route state, not a lamp or toggle: keep it out of toggleState.
      if (follow.enabled && change.Component === follow.router) {
        this.trackRoute(change)
        continue
      }
      if (!this.config.feedback.enabled) continue
      const key = `${change.Component}:${change.Name}`
      const val = change.Value > 0 ? 1 : 0
      this.toggleState.set(key, val)

      const led = this.ledMap.get(key)
      if (!led) continue
      if (val === 1) {
        this.midi.sendNoteOn(led.channel, led.note)
      } else {
        this.midi.sendNoteOff(led.channel, led.note)
      }
    }
  }

  private trackRoute(change: { Component: string; Name: string; Value: number }): void {
    const follow = this.followRouter
    if (!follow.enabled || change.Component !== follow.router) return
    const cp = parseCrosspoint(change.Name)
    if (!cp || cp.output < 1 || cp.output > STRIPS) return
    // A route change flips two crosspoints (old off, new on); only the "on" matters.
    if (!(change.Value > 0)) return
    const previous = this.routes.get(cp.output)
    this.routes.set(cp.output, cp.input)
    if (this.routesBaselined && previous !== cp.input) this.onRouteChange?.(cp.output, cp.input)
  }

  private async execute(mapping: Mapping, midiValue: number): Promise<void> {
    const q = mapping.qsys
    const label = mapping.label ?? `${mapping.midi.type}:${mapping.midi.number}`

    // Returning silently here made a dropped Core connection indistinguishable
    // from a broken mapping — raw MIDI in the log, nothing else, no error.
    if (!this.qrc.isConnected) {
      this.log(`${label} — Q-SYS not connected, press ignored`)
      return
    }

    switch (q.type) {
      case 'component_control': {
        // Scale once, then write that same value to every leg — a stereo pair
        // must never drift apart by re-scaling per leg.
        const scaled = this.scale(midiValue, q.min ?? 0, q.max ?? 1)
        const targets = resolveTargets(q)
        await this.setTargets(targets, scaled)
        this.log(`${label} → ${scaled.toFixed(1)}${targets.length > 1 ? ' (ganged)' : ''}`)
        break
      }

      case 'toggle': {
        const targets = resolveTargets(q)
        // The linked leg follows the primary's cached state rather than
        // toggling on its own, so a ganged pair can't desync into
        // "left muted, right open".
        const current = this.toggleState.get(keyOf(targets[0])) ?? 0
        const next = current === 0 ? 1 : 0
        for (const t of targets) this.toggleState.set(keyOf(t), next)
        await this.setTargets(targets, next)
        // Update LEDs immediately — Q-SYS won't push a notification for
        // changes we initiated ourselves on the same connection.
        for (const t of targets) {
          const led = this.ledMap.get(keyOf(t))
          if (!led) continue
          if (next === 1) this.midi.sendNoteOn(led.channel, led.note)
          else this.midi.sendNoteOff(led.channel, led.note)
        }
        this.log(`${label} → ${next === 1 ? 'MUTED' : 'unmuted'}${targets.length > 1 ? ' (ganged)' : ''}`)
        break
      }

      case 'named_control': {
        const scaled = this.scale(midiValue, q.min ?? 0, q.max ?? 1)
        await this.qrc.call('Control.Set', {
          Name: q.name,
          Value: scaled,
        })
        this.log(`${label} → ${scaled.toFixed(1)}`)
        break
      }

      case 'snapshot': {
        if (q.name) {
          await this.qrc.call('Snapshot.Load', { Name: q.name })
        } else {
          await this.qrc.call('Snapshot.Load', { Bank: q.bank, Slot: q.slot })
        }
        this.log(`${label} → snapshot`)
        break
      }
    }
  }

  /**
   * Writes `value` to every target, batching those that share a component
   * into one Component.Set. Separate components go out together rather than
   * in series, so a knob sweep isn't throttled by the extra leg.
   */
  private async setTargets(targets: Target[], value: number): Promise<void> {
    const byComponent = new Map<string, string[]>()
    for (const t of targets) {
      const controls = byComponent.get(t.component) ?? []
      if (!controls.includes(t.control)) controls.push(t.control)
      byComponent.set(t.component, controls)
    }
    await Promise.all(
      [...byComponent].map(([Name, controls]) =>
        this.qrc.call('Component.Set', {
          Name,
          Controls: controls.map((name) => ({ Name: name, Value: value })),
        }),
      ),
    )
  }

  private scale(value: number, min: number, max: number): number {
    return min + (value / 127) * (max - min)
  }

  private log(entry: string): void {
    console.log(`[Bridge] ${entry}`)
    this.recentActivity.unshift(entry)
    if (this.recentActivity.length > 8) this.recentActivity.pop()
  }
}
