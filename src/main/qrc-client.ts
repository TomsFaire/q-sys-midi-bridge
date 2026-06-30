/**
 * QRC Client — JSON-RPC 2.0 over TCP port 1710
 *
 * Adapted from q-sys-MCP/src/clients/qrc-client.ts.
 * Adds EventEmitter for connect/disconnect events.
 * Removed MCP-specific types; trimmed to methods needed by the bridge.
 *
 * Wire format: null-byte (\0) terminated JSON messages.
 *
 * NOTE: This Core only supports TCP QRC (port 1710). Do NOT use WebSocket.
 */

import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'

const DEFAULT_PORT = 1710
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RECONNECT_DELAY_MS = 30_000
const BASE_RECONNECT_DELAY_MS = 500
const KEEPALIVE_INTERVAL_MS = 55_000

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string }
}

export class QrcClient extends EventEmitter {
  private host: string
  private port: number
  private timeoutMs: number

  private socket: Socket | null = null
  private buffer = ''
  private _connected = false
  private reconnecting = false
  private destroyed = false
  private reconnectDelay = BASE_RECONNECT_DELAY_MS
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null

  private nextId = 1
  private pending = new Map<number, PendingRequest>()

  constructor(host: string, port = DEFAULT_PORT, timeoutMs = DEFAULT_TIMEOUT_MS) {
    super()
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
  }

  async connect(): Promise<void> {
    if (this._connected) return
    if (this.reconnecting) {
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (this._connected) return resolve()
          if (!this.reconnecting) return reject(new Error('Reconnect failed'))
          setTimeout(check, 50)
        }
        check()
      })
      return
    }
    await this.performConnect()
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this._connected) {
      throw new Error(`QRC not connected (${this.host}:${this.port})`)
    }

    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`QRC timeout: ${method}`))
      }, this.timeoutMs)

      this.pending.set(id, { resolve, reject, timer })

      const payload = JSON.stringify(request) + '\0'
      this.socket!.write(payload, 'utf-8', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error(`QRC write error: ${err.message}`))
        }
      })
    })
  }

  async disconnect(): Promise<void> {
    this.destroyed = true
    this.stopKeepAlive()
    this.rejectAllPending(new Error('QRC client disconnected'))
    this.socket?.destroy()
    this.socket = null
    this._connected = false
  }

  get isConnected(): boolean {
    return this._connected
  }

  private async performConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = new Socket()
      this.socket = socket

      const connectTimeout = setTimeout(() => {
        socket.destroy()
        reject(new Error(`QRC connect timeout: ${this.host}:${this.port}`))
      }, this.timeoutMs)

      socket.once('connect', () => {
        clearTimeout(connectTimeout)
        this._connected = true
        this.reconnectDelay = BASE_RECONNECT_DELAY_MS
        this.buffer = ''
        this.startKeepAlive()
        this.emit('connect')
        resolve()
      })

      socket.once('error', (err) => {
        clearTimeout(connectTimeout)
        this._connected = false
        reject(err)
      })

      socket.on('data', (chunk: Buffer) => this.handleData(chunk))
      socket.on('end', () => this.handleDisconnect('connection ended'))
      socket.on('error', () => this.handleDisconnect('socket error'))
      socket.on('close', () => {
        if (this._connected) this.handleDisconnect('socket closed')
      })

      socket.connect(this.port, this.host)
    })
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8')
    let nullIndex: number
    while ((nullIndex = this.buffer.indexOf('\0')) !== -1) {
      const raw = this.buffer.slice(0, nullIndex)
      this.buffer = this.buffer.slice(nullIndex + 1)
      if (!raw.trim()) continue
      try {
        const msg: JsonRpcResponse = JSON.parse(raw)
        this.handleMessage(msg)
      } catch { /* ignore malformed */ }
    }
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (msg.id === undefined || msg.id === null) return
    const id = typeof msg.id === 'string' ? parseInt(msg.id, 10) : msg.id
    if (Number.isNaN(id)) {
      // Non-numeric string ID = unsolicited push (e.g. ChangeGroup AutoPoll notification)
      if (msg.result !== undefined) this.emit('notification', String(msg.id), msg.result)
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (msg.error) {
      pending.reject(new Error(`QRC error ${msg.error.code}: ${msg.error.message}`))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleDisconnect(reason: string): void {
    if (!this._connected) return
    this._connected = false
    this.stopKeepAlive()
    this.rejectAllPending(new Error(`QRC disconnected: ${reason}`))
    this.emit('disconnect', reason)
    if (!this.destroyed) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.destroyed) return
    this.reconnecting = true
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS)
    setTimeout(async () => {
      if (this.destroyed) { this.reconnecting = false; return }
      try {
        await this.performConnect()
        this.reconnecting = false
      } catch {
        this.reconnecting = false
        if (!this.destroyed) this.scheduleReconnect()
      }
    }, delay)
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(() => {
      if (this._connected && !this.destroyed) {
        this.call('NoOp').catch(() => { /* disconnect handler fires */ })
      }
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }
}
