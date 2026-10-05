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

    for (const led of config.feedback.mute_leds) {
      this.ledMap.set(`${led.component}:${led.control}`, led.midi)
    }

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
    const mapping = this.noteMap.get(`${channel}:${note}`)
    if (!mapping) return
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
    if (this.config.feedback.enabled) {
      this.qrc.on('notification', (_id: string, result: unknown) => this.handleNotification(result))
    }
  }

  /** Hot-reload mappings from a new config without restarting the app. */
  reload(config: Config): void {
    this.ccMap.clear()
    this.noteMap.clear()
    this.toggleState.clear()
    this.ledMap.clear()

    for (const mapping of config.mappings) {
      const key = `${mapping.midi.channel}:${mapping.midi.number}`
      if (mapping.midi.type === 'cc') this.ccMap.set(key, mapping)
      else this.noteMap.set(key, mapping)
    }
    for (const led of config.feedback.mute_leds) {
      this.ledMap.set(`${led.component}:${led.control}`, led.midi)
    }
    console.log(`[Bridge] Mappings reloaded — ${this.ccMap.size} CC, ${this.noteMap.size} note`)
  }

  getRecentActivity(): string[] {
    return this.recentActivity.slice()
  }

  async setupChangeGroup(): Promise<void> {
    if (!this.config.feedback.enabled || this.ledMap.size === 0) return

    // Group controls by component for the ChangeGroup subscription
    const byComponent = new Map<string, string[]>()
    for (const led of this.config.feedback.mute_leds) {
      if (!byComponent.has(led.component)) byComponent.set(led.component, [])
      byComponent.get(led.component)!.push(led.control)
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
    console.log('[Bridge] handleNotification raw:', JSON.stringify(result).slice(0, 200))
    if (!result || typeof result !== 'object') return
    const r = result as { Changes?: Array<{ Component: string; Name: string; Value: number }> }
    if (!Array.isArray(r.Changes)) {
      console.warn('[Bridge] handleNotification: no Changes array in result')
      return
    }

    for (const change of r.Changes) {
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
