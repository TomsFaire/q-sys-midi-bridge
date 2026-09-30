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

/**
 * Credentials for a Core with Access Control enabled. When `username` is
 * empty the client skips the logon handshake entirely, which is the correct
 * behaviour for an open Core.
 */
export interface QrcCredentials {
  username?: string
  password?: string
}

/** Q-SYS returns this code when a call is made before a successful Logon. */
const QRC_LOGON_REQUIRED_CODE = 10

/**
 * Read-only call used to check whether the Core will actually accept commands.
 * A Core with Access Control enabled completes the TCP handshake and *then*
 * rejects everything, so without this probe a client with no credentials looks
 * perfectly healthy while controlling nothing.
 */
const AUTH_PROBE_METHOD = 'StatusGet'

/** A JSON-RPC error returned by the Core, pre-classified as auth or not. */
export class QrcError extends Error {
  constructor(
    readonly code: number,
    readonly coreMessage: string,
    readonly isAuthError: boolean,
  ) {
    super(`QRC error ${code}: ${coreMessage}`)
    this.name = 'QrcError'
  }
}

/** The Core's own wording for a failure, without our JSON-RPC framing. */
function coreReason(err: unknown): string {
  return err instanceof QrcError ? err.coreMessage : (err as Error).message
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

  private credentials: QrcCredentials | null
  private _lastError: string | null = null

  constructor(
    host: string,
    port = DEFAULT_PORT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    credentials?: QrcCredentials,
  ) {
    super()
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
    // Treat a blank username as "no Access Control" so an untouched config
    // behaves exactly as it did before.
    this.credentials = credentials?.username ? credentials : null
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
    try {
      await this.performConnect()
    } catch (err) {
      // The initial connect never set _connected, so handleDisconnect()
      // early-returns and no reconnect is scheduled — the client would stay
      // dead forever. Start the backoff loop here so a Core that is slow to
      // boot, or briefly unreachable at login, recovers on its own.
      if (!this.destroyed) this.scheduleReconnect()
      throw err
    }
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

  /**
   * Set while the Core is actively refusing us — wrong credentials, or Access
   * Control enabled with none configured. Null when we are simply connected,
   * or simply unreachable. Surfaced in the tray so an authorisation failure is
   * visible without reading logs.
   */
  get lastError(): string | null {
    return this._lastError
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
        // Set _connected before authenticating: call() checks this flag, and
        // Logon has to go out over this very socket.
        this._connected = true
        this.reconnectDelay = BASE_RECONNECT_DELAY_MS
        this.buffer = ''
        this.authenticate()
          .then(() => {
            this._lastError = null
            this.startKeepAlive()
            this.emit('connect')
            resolve()
          })
          .catch((err: Error) => {
            // Bad credentials shouldn't look like a network fault. Record the
            // reason, drop the socket, and let connect() schedule the retry.
            // Clearing _connected *before* destroy() matters: it makes the
            // 'close' handler early-return so handleDisconnect() can't wipe
            // the message we are about to show.
            this._lastError = err.message
            this._connected = false
            this.emit('auth-error', err.message)
            socket.destroy()
            this.socket = null
            reject(err)
          })
      })

      socket.once('error', (err) => {
        clearTimeout(connectTimeout)
        this._connected = false
        // Couldn't even reach the Core — whatever it told us last time no
        // longer applies. The tray falls back to a plain "Disconnected".
        this._lastError = null
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

  /**
   * Establish that the Core will accept our commands, by logging on when
   * credentials are configured and by probing when they are not.
   *
   * Rejecting here is what keeps "connected" honest: a Core with Access
   * Control enabled accepts the socket either way, so the only difference
   * between a working bridge and a mute one is whether calls come back.
   */
  private async authenticate(): Promise<void> {
    if (this.credentials) {
      const { username, password } = this.credentials
      try {
        await this.call('Logon', { User: username, Password: password ?? '' })
      } catch (err) {
        throw new Error(`Logon failed for "${username}" — ${coreReason(err)}`)
      }
      console.log(`[QRC] Logged on to Q-SYS as "${username}"`)
      return
    }

    // No credentials configured. If the Core turns out to want them, say so
    // now rather than letting every fader move fail silently later.
    try {
      await this.call(AUTH_PROBE_METHOD)
    } catch (err) {
      if (err instanceof QrcError && err.isAuthError) {
        throw new Error('Logon required — set qsys.username/password in config.json')
      }
      // Any other probe failure (timeout, a Core that doesn't like the method)
      // says nothing about authorisation, so let the connection stand.
    }
  }

  /** True for the errors a Core returns when Access Control blocks a call. */
  private isAuthError(error: { code: number; message: string }): boolean {
    return (
      error.code === QRC_LOGON_REQUIRED_CODE ||
      /logon|log on|login|authenticat|not authorized|unauthorized/i.test(
        error.message ?? ''
      )
    )
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
    // No id = pure JSON-RPC notification (Q-SYS AutoPoll push)
    if (msg.id === undefined || msg.id === null) {
      if (msg.result !== undefined) {
        console.log('[QRC] Notification (no id):', JSON.stringify(msg.result).slice(0, 120))
        this.emit('notification', '', msg.result)
      }
      return
    }
    const id = typeof msg.id === 'string' ? parseInt(msg.id, 10) : msg.id
    if (Number.isNaN(id)) {
      // Non-numeric string ID = named notification (e.g. ChangeGroup AutoPoll id="mutes")
      if (msg.result !== undefined) {
        console.log(`[QRC] Notification (id="${msg.id}"):`, JSON.stringify(msg.result).slice(0, 120))
        this.emit('notification', String(msg.id), msg.result)
      }
      return
    }
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (msg.error) {
      const isAuth = this.isAuthError(msg.error)
      if (isAuth) {
        // Access Control can also be switched on while we are connected, in
        // which case the socket stays up and every call starts coming back
        // rejected. Record it so the tray stops claiming we are fine.
        this._lastError = this.credentials
          ? `Logon rejected for "${this.credentials.username}" — ${msg.error.message}`
          : 'Logon required — set qsys.username/password in config.json'
        console.error(`[QRC] ${this._lastError}`)
        this.emit('auth-error', this._lastError)
      }
      pending.reject(new QrcError(msg.error.code, msg.error.message, isAuth))
    } else {
      pending.resolve(msg.result)
    }
  }

  private handleDisconnect(reason: string): void {
    if (!this._connected) return
    this._connected = false
    // A dropped socket is a network fact, not an authorisation one — don't let
    // a stale auth message outlive the connection it described.
    this._lastError = null
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
