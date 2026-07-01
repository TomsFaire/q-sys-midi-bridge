/**
 * MIDI I/O wrapper around @julusian/midi.
 *
 * Polls for the configured device every 2s and auto-reconnects when found.
 * Emits 'cc' and 'note_on' events for the mapping engine.
 * Exposes sendNoteOn / sendNoteOff for LED feedback.
 */

import { EventEmitter } from 'node:events'
import midi from '@julusian/midi'

const POLL_INTERVAL_MS = 2000

export class MidiIO extends EventEmitter {
  private deviceName: string
  private input: midi.Input | null = null
  private output: midi.Output | null = null
  private _connected = false
  private _connectedDeviceName = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(deviceName: string) {
    super()
    this.deviceName = deviceName
  }

  start(): void {
    this.poll()
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    this.closeDevice()
  }

  get isConnected(): boolean { return this._connected }
  get connectedDeviceName(): string { return this._connectedDeviceName }

  sendNoteOn(channel: number, note: number, velocity = 127): void {
    if (!this.output) {
      console.warn(`[MIDI] sendNoteOn ch=${channel} note=${note} — no output port open`)
      return
    }
    console.log(`[MIDI LED] NoteOn ch=${channel} note=${note} vel=${velocity}`)
    this.output.sendMessage([0x90 | (channel - 1), note, velocity])
  }

  sendNoteOff(channel: number, note: number): void {
    if (!this.output) return
    console.log(`[MIDI LED] NoteOff ch=${channel} note=${note}`)
    // MIDImix turns LEDs off with Note On velocity 0, not a Note Off message
    this.output.sendMessage([0x90 | (channel - 1), note, 0])
  }

  private poll(): void {
    if (this.stopped) return
    if (this._connected) {
      // Check the device is still present
      if (this.findPortIndex(new midi.Input(), this.deviceName) === null) {
        console.log(`[MIDI] Device lost: ${this._connectedDeviceName}`)
        this.closeDevice()
      }
      return
    }
    this.tryOpen()
  }

  private tryOpen(): void {
    const probe = new midi.Input()
    const count = probe.getPortCount()
    const available = Array.from({ length: count }, (_, i) => probe.getPortName(i))
    const idx = this.findPortIndex(probe, this.deviceName)
    if (idx === null) {
      if (count === 0) {
        console.log('[MIDI] No MIDI ports found')
      } else {
        console.log(`[MIDI] "${this.deviceName}" not found. Available: ${available.join(', ')}`)
      }
      return
    }

    const portName = probe.getPortName(idx)
    // Don't closePort on probe — it was never opened; closePort on an
    // unopened RtMidi port throws, which would abort this function silently.

    try {
      const input = new midi.Input()
      input.ignoreTypes(false, false, false) // receive all MIDI message types
      input.openPort(idx)
      input.on('message', (_delta: number, msg: number[]) => this.handleMessage(msg))

      // Open matching output port for LED feedback
      const out = new midi.Output()
      const outCount = out.getPortCount()
      const outPorts = Array.from({ length: outCount }, (_, i) => out.getPortName(i))
      console.log(`[MIDI] Output ports available: ${outPorts.join(', ') || 'none'}`)
      const outIdx = this.findPortIndex(out, this.deviceName)
      if (outIdx !== null) {
        out.openPort(outIdx)
        this.output = out
        console.log(`[MIDI] Output port opened: ${outPorts[outIdx]}`)
      } else {
        console.warn(`[MIDI] No output port found matching "${this.deviceName}" — LED feedback disabled`)
      }

      this.input = input
      this._connected = true
      this._connectedDeviceName = portName
      console.log(`[MIDI] Connected: ${portName}`)
      this.emit('connect', portName)
    } catch (err) {
      console.error(`[MIDI] Failed to open port: ${err}`)
    }
  }

  private closeDevice(): void {
    try { this.input?.closePort() } catch { /* ignore */ }
    try { this.output?.closePort() } catch { /* ignore */ }
    this.input = null
    this.output = null
    const wasConnected = this._connected
    this._connected = false
    this._connectedDeviceName = ''
    if (wasConnected) this.emit('disconnect')
  }

  private findPortIndex(device: midi.Input | midi.Output, name: string): number | null {
    const count = device.getPortCount()
    for (let i = 0; i < count; i++) {
      if (device.getPortName(i).includes(name)) return i
    }
    return null
  }

  private handleMessage(msg: number[]): void {
    if (msg.length < 2) return
    const status = msg[0]
    const type = status & 0xf0
    const channel = (status & 0x0f) + 1  // convert to 1-indexed

    if (type === 0xb0) {
      // CC
      const cc = msg[1]
      const value = msg[2] ?? 0
      console.log(`[MIDI RAW] CC  ch=${channel} cc=${cc} val=${value}`)
      this.emit('cc', channel, cc, value)
    } else if (type === 0x90) {
      // Note On
      const note = msg[1]
      const velocity = msg[2] ?? 0
      console.log(`[MIDI RAW] NOTE ch=${channel} note=${note} vel=${velocity}`)
      if (velocity > 0) {
        this.emit('note_on', channel, note)
      }
      // velocity=0 is a note-off — ignore for our purposes
    } else {
      console.log(`[MIDI RAW] OTHER status=0x${status.toString(16)} data=${msg.slice(1).join(',')}`)
    }
  }
}
