/**
 * Mapping Engine — translates incoming MIDI events into Q-Sys QRC calls.
 *
 * Lookup maps are built at construction from config.mappings.
 * Toggle state is tracked locally (optimistic — no round-trip GET needed).
 * Errors from QRC calls are logged but not thrown (fire and forget).
 */

import { QrcClient } from './qrc-client.js'
import { MidiIO, PITCH_BEND_MAX } from './midi-io.js'
import type { Config, Mapping, QsysRef } from './config.js'

/** One resolved Q-SYS write target. */
interface Target { component: string; control: string }

const CHANGE_GROUP_ID = 'mutes'

/**
 * MCU fader touch notes: 104-111 are faders 1-8 and 112 is the master, so a
 * touch note is its pitch bend channel plus 103. Buttons live far below this
 * range, which is what keeps a mute release from reading as a fader release.
 */
const TOUCH_NOTE_BASE = 103
const TOUCH_NOTE_MIN = 104
const TOUCH_NOTE_MAX = 112

const keyOf = (t: Target): string => `${t.component}:${t.control}`

/**
 * How far an encoder was turned, in ticks, signed clockwise-positive.
 *
 * MCU puts the direction in bit 6 — 0x01-0x3F clockwise, 0x41-0x7F
 * anticlockwise — and the magnitude in the low bits, so a faster turn
 * reports more ticks. The "signed" variant centres on 64 instead.
 */
function decodeRelativeTicks(value: number, encoding: 'mcu' | 'signed'): number {
  if (encoding === 'signed') return value - 64
  return value & 0x40 ? -(value & 0x3f) : value & 0x3f
}

/** Keeps a value inside whichever of min/max the mapping actually sets. */
function clamp(value: number, min?: number, max?: number): number {
  let out = value
  if (min !== undefined) out = Math.max(min, out)
  if (max !== undefined) out = Math.min(max, out)
  return out
}

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
  // Motorised faders, by pitch bend channel and by target key
  private pitchBendMap = new Map<number, Mapping>()
  private faderFeedback = new Map<string, { midiChannel: number; min: number; max: number }>()
  private faderKeyByChannel = new Map<number, string>()
  // Faders with a hand on them — their motors hold still until released
  private touchedFaders = new Set<string>()
  // Last value the Core reported for a control, raw rather than 0/1
  private controlValues = new Map<string, number>()

  private recentActivity: string[] = []

  constructor(qrc: QrcClient, midi: MidiIO, config: Config) {
    this.qrc = qrc
    this.midi = midi
    this.config = config

    this.buildIndexes(config)

    if (config.feedback.enabled) {
      this.qrc.on('notification', (_id: string, result: unknown) => this.handleNotification(result))
    }
  }

  handleCC(channel: number, cc: number, value: number): void {
    const mapping = this.ccMap.get(`${channel}:${cc}`)
    if (!mapping) return
    // Toggle buttons (mutes, rec arm) send CC 127 on press and CC 0 on release.
    // Ignore the 0 so we don't double-fire and immediately undo the toggle.
    if (mapping.qsys.type === 'toggle' && value === 0) return
    this.execute(mapping, value).catch((err) => {
      console.error(`[Bridge] QRC error for "${mapping.label ?? 'unknown'}": ${err.message}`)
    })
  }

  handleNoteOn(channel: number, note: number): void {
    if (note >= TOUCH_NOTE_MIN && note <= TOUCH_NOTE_MAX) {
      const key = this.faderKeyByChannel.get(note - TOUCH_NOTE_BASE)
      // A touched fader holds its position until the hand comes off.
      if (key) { this.touchedFaders.add(key); return }
    }
    const mapping = this.noteMap.get(`${channel}:${note}`)
    if (!mapping) return
    this.execute(mapping, 127).catch((err) => {
      console.error(`[Bridge] QRC error for "${mapping.label ?? 'unknown'}": ${err.message}`)
    })
  }

  /** A fader moved on the surface. */
  handlePitchBend(channel: number, value14: number): void {
    const mapping = this.pitchBendMap.get(channel)
    if (!mapping) return
    if (!this.qrc.isConnected) return
    const q = mapping.qsys
    if (q.type !== 'component_control' && q.type !== 'component_control_relative') {
      // Without a component and control to resolve, setTargets would write to
      // Name: "" on every message of a sweep.
      console.warn(`[Bridge] "${mapping.label ?? 'fader'}": a fader needs a component_control target`)
      return
    }
    const db = this.scaleFrom14Bit(value14, q.min ?? 0, q.max ?? 1)
    const targets = resolveTargets(q)
    // Record where the operator put it. The Core does not push our own writes
    // back on this connection, so without this the release below would snap
    // the motor to whatever value the Core last volunteered.
    for (const t of targets) this.controlValues.set(keyOf(t), db)
    this.setTargets(targets, db).catch((err) => {
      console.error(`[Bridge] QRC error for "${mapping.label ?? 'fader'}": ${err.message}`)
    })
  }

  /**
   * A button or fader was released. Only the MCU touch range means a fader;
   * every other note is a button release the bridge has no use for.
   */
  handleNoteOff(channel: number, note: number): void {
    if (note < TOUCH_NOTE_MIN || note > TOUCH_NOTE_MAX) return
    const key = this.faderKeyByChannel.get(note - TOUCH_NOTE_BASE)
    if (!key) return
    this.touchedFaders.delete(key)
    // The Core may have moved under the operator's hand; catch the motor up.
    const value = this.controlValues.get(key)
    if (value !== undefined) this.driveFader(key, value)
  }

  /**
   * Forget what the control surface was doing. A fader held when the cable
   * goes never sends its release, and a touch nobody can clear would freeze
   * that motor for the life of the process.
   */
  forgetSurfaceState(): void {
    this.touchedFaders.clear()
  }

  get mappingCount(): number {
    return this.ccMap.size + this.noteMap.size + this.pitchBendMap.size
  }

  /** Swap the underlying QRC client (e.g. after a host change). */
  setQrc(qrc: QrcClient): void {
    this.qrc.removeAllListeners('notification')
    this.qrc = qrc
    if (this.config.feedback.enabled) {
      this.qrc.on('notification', (_id: string, result: unknown) => this.handleNotification(result))
    }
  }

  /** Hot-reload mappings from a new config without restarting the app. */
  reload(config: Config): void {
    // The config object backs setupChangeGroup() and the feedback.enabled
    // checks, so a reload that didn't adopt it would re-subscribe the old set.
    this.config = config
    this.toggleState.clear()
    this.touchedFaders.clear()
    // controlValues is what the Core said, not what the config says. Clearing
    // it would leave every relative encoder with nothing to add to until
    // something moved that control from elsewhere.
    this.buildIndexes(config)
    console.log(
      `[Bridge] Mappings reloaded — ${this.ccMap.size} CC, ${this.noteMap.size} note, ` +
      `${this.pitchBendMap.size} fader`,
    )
  }

  /** (Re)build every lookup map from a config. */
  private buildIndexes(config: Config): void {
    this.ccMap.clear()
    this.noteMap.clear()
    this.ledMap.clear()
    this.pitchBendMap.clear()
    this.faderFeedback.clear()
    this.faderKeyByChannel.clear()

    for (const mapping of config.mappings) {
      if (mapping.midi.type === 'pitchbend') {
        // A fader is addressed by MIDI channel alone.
        this.pitchBendMap.set(mapping.midi.channel, mapping)
        continue
      }
      const key = `${mapping.midi.channel}:${mapping.midi.number}`
      if (mapping.midi.type === 'cc') this.ccMap.set(key, mapping)
      else this.noteMap.set(key, mapping)
    }

    for (const led of config.feedback.mute_leds) {
      this.ledMap.set(`${led.component}:${led.control}`, led.midi)
    }

    for (const fader of config.feedback.fader_positions ?? []) {
      const key = `${fader.component}:${fader.control}`
      this.faderFeedback.set(key, {
        midiChannel: fader.midi.channel,
        min: fader.min,
        max: fader.max,
      })
      this.faderKeyByChannel.set(fader.midi.channel, key)
    }
  }

  getRecentActivity(): string[] {
    return this.recentActivity.slice()
  }

  async setupChangeGroup(): Promise<void> {
    if (!this.config.feedback.enabled) return
    const hasRelative = this.config.mappings.some(
      (m) => m.qsys.type === 'component_control_relative',
    )
    if (this.ledMap.size === 0 && this.faderFeedback.size === 0 && !hasRelative) return

    // Group controls by component for the ChangeGroup subscription. Faders
    // ride in the same group as the mutes: the Core's change group budget is
    // small, and a second group here would cost one the UCI needs.
    const byComponent = new Map<string, string[]>()
    const subscribe = (component: string, control: string) => {
      const controls = byComponent.get(component) ?? []
      if (!controls.includes(control)) controls.push(control)
      byComponent.set(component, controls)
    }
    for (const led of this.config.feedback.mute_leds) subscribe(led.component, led.control)
    for (const fader of this.config.feedback.fader_positions ?? []) {
      subscribe(fader.component, fader.control)
    }
    // A relative encoder adds a delta to the Core's value, so it only works
    // once the Core reports that value — which means subscribing its target
    // whether or not the control is also on a motor or an LED.
    for (const mapping of this.config.mappings) {
      if (mapping.qsys.type !== 'component_control_relative') continue
      for (const t of resolveTargets(mapping.qsys)) {
        if (t.component && t.control) subscribe(t.component, t.control)
      }
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

    // Immediate poll to sync initial LED state on connect
    const initial = await this.qrc.call('ChangeGroup.Poll', { Id: CHANGE_GROUP_ID })
      .catch((err) => {
        console.error(`[Bridge] Initial ChangeGroup.Poll failed: ${err.message}`)
        return null
      })
    if (initial) this.handleNotification(initial)

    console.log('[Bridge] ChangeGroup feedback active')
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

    for (const change of r.Changes) {
      const key = `${change.Component}:${change.Name}`
      this.controlValues.set(key, change.Value)
      const val = change.Value > 0 ? 1 : 0
      this.toggleState.set(key, val)

      // A fader with a hand on it keeps its position; the release catches up.
      if (!this.touchedFaders.has(key)) this.driveFader(key, change.Value)

      const led = this.ledMap.get(key)
      if (!led) continue
      if (val === 1) {
        this.midi.sendNoteOn(led.channel, led.note)
      } else {
        this.midi.sendNoteOff(led.channel, led.note)
      }
    }
  }

  /** Move a motorised fader to the position a Q-SYS value implies. */
  private driveFader(key: string, value: number): void {
    const fader = this.faderFeedback.get(key)
    if (!fader) return
    this.midi.sendPitchBend(fader.midiChannel, this.scaleTo14Bit(value, fader.min, fader.max))
  }

  private async execute(mapping: Mapping, midiValue: number): Promise<void> {
    if (!this.qrc.isConnected) return

    const q = mapping.qsys
    const label = mapping.label ?? `${mapping.midi.type}:${mapping.midi.number}`

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

      case 'component_control_relative': {
        // An encoder reports movement, not position, so the new value is the
        // last one the Core reported plus the delta. Until the Core has told
        // us where the control sits there is nothing to add to, and guessing
        // would jump the value somewhere nobody asked for.
        const targets = resolveTargets(q)
        const current = this.controlValues.get(keyOf(targets[0]))
        if (current === undefined) {
          console.warn(`[Bridge] ${label}: no value from the Core yet, ignoring tick`)
          break
        }
        const ticks = decodeRelativeTicks(midiValue, q.encoding ?? 'mcu')
        if (ticks === 0) break
        const next = clamp(current + ticks * (q.step ?? 1), q.min, q.max)
        if (next === current) break
        for (const t of targets) this.controlValues.set(keyOf(t), next)
        await this.setTargets(targets, next)
        this.log(`${label} → ${next.toFixed(1)}${targets.length > 1 ? ' (ganged)' : ''}`)
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

  /** A Q-SYS value to a 14-bit fader position. */
  private scaleTo14Bit(value: number, min: number, max: number): number {
    if (max === min) return 0
    const ratio = (value - min) / (max - min)
    return Math.round(Math.max(0, Math.min(1, ratio)) * PITCH_BEND_MAX)
  }

  /** A 14-bit fader position to a Q-SYS value. */
  private scaleFrom14Bit(value14: number, min: number, max: number): number {
    const ratio = Math.max(0, Math.min(1, value14 / PITCH_BEND_MAX))
    return min + ratio * (max - min)
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
