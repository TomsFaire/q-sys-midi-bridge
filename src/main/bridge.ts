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
    this.qrc = new QrcClient(config.qsys.host, config.qsys.port)
    this.midi = new MidiIO(config.midi.deviceName)
    this.engine = new MappingEngine(this.qrc, this.midi, config)

    this.qrc.on('connect', () => {
      console.log(`[QRC] Connected to Q-Sys at ${config.qsys.host}:${config.qsys.port}`)
      this.engine.setupChangeGroup().catch((err) => {
        console.error(`[Bridge] setupChangeGroup error: ${err.message}`)
      })
      this.emit('status-change')
    })
    this.qrc.on('disconnect', (reason: string) => {
      console.log(`[QRC] Disconnected: ${reason}`)
      this.emit('status-change')
    })

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
  async reloadConfig(): Promise<void> {
    const newConfig = loadConfig()
    const hostChanged = newConfig.qsys.host !== this.config.qsys.host

    this.config = newConfig
    this.engine.reload(newConfig)

    if (hostChanged) {
      await this.qrc.disconnect()
      this.qrc = new QrcClient(newConfig.qsys.host, newConfig.qsys.port)
      // Update engine's QRC reference before connecting so notifications
      // and outgoing calls use the new socket from the moment it connects.
      this.engine.setQrc(this.qrc)
      this.qrc.on('connect', () => {
        console.log(`[QRC] Reconnected to Q-Sys at ${newConfig.qsys.host}`)
        this.engine.setupChangeGroup().catch((err) => {
          console.error(`[Bridge] setupChangeGroup error: ${err.message}`)
        })
        this.emit('status-change')
      })
      this.qrc.on('disconnect', (reason: string) => {
        console.log(`[QRC] Disconnected: ${reason}`)
        this.emit('status-change')
      })
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

  get qrcConnected(): boolean { return this.qrc.isConnected }
  get midiConnected(): boolean { return this.midi.isConnected }
  get midiDeviceName(): string { return this.midi.connectedDeviceName }
  get mappingCount(): number { return this.engine.mappingCount }
  get qsysHost(): string { return this.config.qsys.host }
  get recentActivity(): string[] { return this.engine.getRecentActivity() }
}
