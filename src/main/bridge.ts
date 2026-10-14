/**
 * Bridge — wires MIDI events → Q-Sys QRC calls.
 *
 * Owns the QrcClient, MidiIO, and MappingEngine.
 * Exposes status properties for the tray menu.
 */

import { EventEmitter } from 'node:events'
import { QrcClient } from './qrc-client.js'
import { MidiIO } from './midi-io.js'
import { MappingEngine } from './mapping-engine.js'
import { CoalescingRunner } from './coalescing-runner.js'
import { loadConfig, findConfigPath } from './config.js'
import { loadMappings, saveMappings, loadFollowRouter, saveFollowRouterEnabled } from './mapping-service.js'
import { autoMapKnobA, resolveFollowConfig } from './router-follow.js'
import type { AutoMapResult } from './router-follow.js'
import type { Config } from './config.js'

export class Bridge extends EventEmitter {
  private qrc: QrcClient
  private midi: MidiIO
  private engine: MappingEngine
  private config: Config
  /**
   * Every setupChangeGroup goes through here. Un-awaited calls from quick
   * successive reloads/recalls would otherwise interleave Destroy/Add/
   * AutoPoll/Poll and leave the group watching stale components. Looks up
   * this.engine at run time, so a rebuilt engine is honoured.
   */
  private changeGroup = new CoalescingRunner(() => this.engine.setupChangeGroup())
  /**
   * Follow-router rewrites (remaps and reconciles) run strictly one at a time:
   * each is a load-modify-save of config.json plus a reload, and two in flight
   * would clobber each other. The tail never rejects.
   */
  private remapChain: Promise<unknown> = Promise.resolve()
  /** Strips whose route changed since the last flush; one flush per tick covers them all. */
  private pendingStrips = new Set<number>()

  constructor(config: Config) {
    super()
    this.config = config
    this.qrc = new QrcClient(config.qsys.host, config.qsys.port, undefined, {
      username: config.qsys.username,
      password: config.qsys.password,
    })
    this.midi = new MidiIO(config.midi.deviceName)
    this.engine = new MappingEngine(this.qrc, this.midi, config)
    // A route changed in Q-SYS/UCI: retarget only that strip's Knob A.
    // A scene recall flips several routers in one push, so collect the strips
    // and remap them together once the push has been fully read.
    this.engine.onRouteChange = (strip) => {
      if (this.pendingStrips.size === 0) queueMicrotask(() => this.flushRemaps())
      this.pendingStrips.add(strip)
    }
    // Routes may have changed while the Core link was down or the app was off.
    this.engine.onBaselined = () => {
      this.serialize(() => this.reconcile()).catch((err) => {
        console.error(`[Bridge] Follow-router reconcile failed: ${err.message}`)
      })
    }

    this.wireQrcEvents(`Connected to Q-Sys at ${config.qsys.host}:${config.qsys.port}`)

    this.midi.on('connect', (name: string) => {
      console.log(`[MIDI] Device connected: ${name}`)
      this.engine.syncLEDs()
      this.emit('status-change')
    })
    this.midi.on('disconnect', () => {
      console.log('[MIDI] Device disconnected')
      this.emit('status-change')
    })

    this.midi.on('cc', (channel: number, cc: number, value: number) => {
      this.engine.handleCC(channel, cc, value)
    })
    this.midi.on('note_on', (channel: number, note: number) => {
      this.engine.handleNoteOn(channel, note)
    })
  }

  async start(): Promise<void> {
    this.midi.start()
    // Connect to Q-Sys in the background — don't block startup on this
    this.qrc.connect().catch((err) => {
      console.error(`[QRC] Initial connect failed: ${err.message} — will retry automatically`)
    })
  }

  async stop(): Promise<void> {
    this.midi.stop()
    await this.qrc.disconnect()
  }

  /** Hot-reload config from disk without restarting the app. */
  async reloadConfig(opts: { reconcile?: boolean } = {}): Promise<void> {
    const newConfig = loadConfig()
    // Credentials and port matter as much as the host: any of them changing
    // means the existing socket is talking to the wrong place, or as the
    // wrong user, and has to be rebuilt.
    const connectionChanged =
      newConfig.qsys.host !== this.config.qsys.host ||
      newConfig.qsys.port !== this.config.qsys.port ||
      newConfig.qsys.username !== this.config.qsys.username ||
      newConfig.qsys.password !== this.config.qsys.password

    this.config = newConfig
    this.engine.reload(newConfig)

    if (connectionChanged) {
      await this.qrc.disconnect()
      this.qrc = new QrcClient(newConfig.qsys.host, newConfig.qsys.port, undefined, {
        username: newConfig.qsys.username,
        password: newConfig.qsys.password,
      })
      // Update engine's QRC reference before connecting so notifications
      // and outgoing calls use the new socket from the moment it connects.
      this.engine.setQrc(this.qrc)
      this.wireQrcEvents(`Reconnected to Q-Sys at ${newConfig.qsys.host}`)
      this.qrc.connect().catch((err) => {
        console.error(`[QRC] Reconnect failed: ${err.message}`)
      })
    } else if (this.qrc.isConnected) {
      // Deliberately not awaited. engine.reload() above has already swapped
      // ccMap/noteMap synchronously, so the new mappings are live right now —
      // whereas setupChangeGroup subscribes one component at a time, each with
      // its own 10s QRC timeout. Against a Core that is up but not answering
      // (Designer compiling, CPU pegged) that is minutes, and awaiting it would
      // leave a show recall looking hung long after it had actually taken
      // effect. Lamp feedback catches up when it catches up.
      this.requestChangeGroup('setupChangeGroup after reload', 'Lamp feedback rebuilt')
    }

    this.emit('status-change')
    console.log('[Bridge] Config hot-reloaded')

    // An editor page left open can post stale Knob A rows over the follow-managed
    // ones. Put them right before returning, so the revision the save endpoints
    // hand back (computed after this resolves) already includes the rewrite.
    // applyAutoMap's own reload passes reconcile: false.
    if (opts.reconcile !== false) {
      await this.serialize(() => this.reconcile()).catch((err) => {
        console.error(`[Bridge] Follow-router reconcile failed: ${err.message}`)
      })
    }
  }

  get followRouterEnabled(): boolean {
    return resolveFollowConfig(this.config.follow_router).enabled
  }

  /** Turn "Knob A follows the input router" on or off and apply it. */
  async setFollowRouter(enabled: boolean): Promise<void> {
    saveFollowRouterEnabled(findConfigPath(), enabled)
    await this.reloadConfig()
  }

  /** The Auto-map button: read the router now and point every Knob A at its routed source. */
  async autoMapKnobAFromRouter(): Promise<AutoMapResult> {
    if (!this.followRouterEnabled) throw new Error('Follow input router is turned off')
    const routes = await this.engine.readRoutes()
    return this.serialize(() => this.applyAutoMap(routes))
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.remapChain.then(task)
    this.remapChain = run.catch(() => undefined)
    return run
  }

  private flushRemaps(): void {
    const strips = [...this.pendingStrips]
    this.pendingStrips.clear()
    this.serialize(() => this.applyAutoMap(this.engine.getRoutes(), strips)).catch((err) => {
      console.error(`[Bridge] Follow-router remap of strip(s) ${strips.join(', ')} failed: ${err.message}`)
    })
  }

  /**
   * Point every Knob A at its currently routed source. Idempotent: a pass that
   * finds nothing to change writes and reloads nothing. Does nothing until the
   * Core's routing is actually known.
   */
  private async reconcile(): Promise<void> {
    if (!this.engine.routesKnown || !this.qrc.isConnected) return
    await this.applyAutoMap(this.engine.getRoutes())
  }

  private async applyAutoMap(routes: Map<number, number>, only?: number[]): Promise<AutoMapResult> {
    const configPath = findConfigPath()
    const cfg = loadFollowRouter(configPath)
    const result = autoMapKnobA(loadMappings(configPath), routes, cfg, only)
    if (result.changed.length > 0) {
      saveMappings(configPath, result.mappings)
      await this.reloadConfig({ reconcile: false })
      console.log(`[Bridge] Knob A remapped for strip(s) ${result.changed.join(', ')}`)
    }
    return result
  }

  private requestChangeGroup(errorLabel: string, okMessage?: string): void {
    let failed = false
    this.changeGroup
      .request((err) => { failed = true; console.error(`[Bridge] ${errorLabel}: ${err.message}`) })
      .then(() => { if (okMessage && !failed) console.log(`[Bridge] ${okMessage}`) })
  }

  /**
   * Subscribe to the current QRC client. Called once per client, so the
   * constructor and reloadConfig() can't drift apart.
   */
  private wireQrcEvents(connectMessage: string): void {
    this.qrc.on('connect', () => {
      console.log(`[QRC] ${connectMessage}`)
      // Whatever we knew about routing is unverified on a fresh link; the
      // rebuild below re-baselines it.
      this.engine.resetRouteBaseline()
      this.requestChangeGroup('setupChangeGroup error')
      this.emit('status-change')
    })
    this.qrc.on('disconnect', (reason: string) => {
      console.log(`[QRC] Disconnected: ${reason}`)
      this.emit('status-change')
    })
    // Access Control can be switched on mid-session, which never produces a
    // disconnect — repaint the tray so the rejection doesn't stay invisible.
    this.qrc.on('auth-error', () => this.emit('status-change'))
  }

  get qrcConnected(): boolean { return this.qrc.isConnected }
  get qrcLastError(): string | null { return this.qrc.lastError }
  get midiConnected(): boolean { return this.midi.isConnected }
  get midiDeviceName(): string { return this.midi.connectedDeviceName }
  get mappingCount(): number { return this.engine.mappingCount }
  get qsysHost(): string { return this.config.qsys.host }
  get recentActivity(): string[] { return this.engine.getRecentActivity() }
}
