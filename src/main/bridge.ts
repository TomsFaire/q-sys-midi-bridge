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
import { loadConfig } from './config.js'
import type { Config } from './config.js'

export class Bridge extends EventEmitter {
  private qrc: QrcClient
  private midi: MidiIO
  private engine: MappingEngine
  private config: Config

  constructor(config: Config) {
    super()
    this.config = config
    this.qrc = new QrcClient(config.qsys.host, config.qsys.port, undefined, {
      username: config.qsys.username,
      password: config.qsys.password,
    })
    this.midi = new MidiIO(config.midi.deviceName)
    this.engine = new MappingEngine(this.qrc, this.midi, config)

    this.wireQrcEvents(`Connected to Q-Sys at ${config.qsys.host}:${config.qsys.port}`)

    this.midi.on('connect', (name: string) => {
      console.log(`[MIDI] Device connected: ${name}`)
      this.engine.syncLEDs()
      this.emit('status-change')
    })
    this.midi.on('disconnect', () => {
      console.log('[MIDI] Device disconnected')
      // Any fader held as the cable went will never send its release.
      this.engine.forgetSurfaceState()
      this.emit('status-change')
    })

    this.midi.on('cc', (channel: number, cc: number, value: number) => {
      this.engine.handleCC(channel, cc, value)
    })
    this.midi.on('note_on', (channel: number, note: number) => {
      this.engine.handleNoteOn(channel, note)
    })
    this.midi.on('note_off', (channel: number, note: number) => {
      this.engine.handleNoteOff(channel, note)
    })
    this.midi.on('pitchbend', (channel: number, value: number) => {
      this.engine.handlePitchBend(channel, value)
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
  async reloadConfig(): Promise<void> {
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
      await this.engine.setupChangeGroup().catch((err) => {
        console.error(`[Bridge] setupChangeGroup after reload: ${err.message}`)
      })
    }

    this.emit('status-change')
    console.log('[Bridge] Config hot-reloaded')
  }

  /**
   * Subscribe to the current QRC client. Called once per client, so the
   * constructor and reloadConfig() can't drift apart.
   */
  private wireQrcEvents(connectMessage: string): void {
    this.qrc.on('connect', () => {
      console.log(`[QRC] ${connectMessage}`)
      this.engine.setupChangeGroup().catch((err) => {
        console.error(`[Bridge] setupChangeGroup error: ${err.message}`)
      })
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
