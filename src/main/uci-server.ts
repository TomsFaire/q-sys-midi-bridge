/**
 * UciServer — serves the FOH UCI mixer HTML and relays browser WebSocket
 * traffic to a Q-Sys Core over raw TCP QRC (port 1710).
 *
 * Runs alongside the MIDI Bridge but does NOT share its QrcClient/TCP
 * connection. Each browser tab that opens /qrc gets its own dedicated raw
 * TCP socket to the Core, proxied byte-for-byte over its WebSocket — ported
 * verbatim from Q-sys-MCP-webUI/backend/src/server.ts (lines 77–121).
 *
 * No Express — a plain http.createServer with two routes:
 *   GET /foh-uci → bundled assets/uci/foh-uci.html
 *   everything else → 404
 *
 * Wire format matches QrcClient: null-byte (\0) terminated JSON messages.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { WebSocketServer, WebSocket } from 'ws'
import type { QrcCredentials } from './qrc-client.js'
import type { MappingsHttpHandler } from './mappings-http.js'

// Sentinel id for the relay's own Logon call, so its reply can be filtered
// out of the stream instead of confusing the browser-side UCI.
const RELAY_LOGON_ID = '__bridge_logon'

/** How long the relay holds browser traffic waiting for its Logon reply. */
const LOGON_TIMEOUT_MS = 5_000

/**
 * Clamp a WebSocket close reason to the 123 bytes the protocol allows. `ws`
 * throws a RangeError past that, which in the main process is an uncaught
 * exception — and the Core's error text is not ours to bound.
 */
function closeReason(text: string): string {
  const bytes = Buffer.from(text, 'utf-8')
  if (bytes.length <= 123) return text
  return bytes.subarray(0, 120).toString('utf-8').replace(/\uFFFD+$/, '') + '...'
}

/** True if `msg` is the reply to the relay's own Logon request. */
function isRelayLogonReply(msg: string): boolean {
  // Cheap guard first — avoids JSON.parse on every relayed message.
  if (!msg.includes(RELAY_LOGON_ID)) return false
  try {
    return (JSON.parse(msg) as { id?: unknown }).id === RELAY_LOGON_ID
  } catch {
    return false
  }
}

export class UciServer extends EventEmitter {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  // Track open relay pairs so stop() can tear them all down.
  private relays = new Set<{ ws: WebSocket; tcp: Socket }>()
  private listening = false
  private _lastError: string | null = null
  private mappingsHandler: MappingsHttpHandler | null = null

  /**
   * Start the UCI HTTP + WebSocket relay server.
   *
   * @param host       interface to bind (use '0.0.0.0' so LAN devices reach it)
   * @param port       HTTP/WS port
   * @param coreHost   Q-Sys Core host for the TCP relay target
   * @param corePort   Q-Sys Core QRC port (1710)
   */
  start(
    host: string,
    port: number,
    coreHost: string,
    corePort: number,
    mappingsHandler?: MappingsHttpHandler,
    credentials?: QrcCredentials,
  ): void {
    if (this.server) return  // already started

    this.mappingsHandler = mappingsHandler ?? null
    this.mappingsHandler?.connect(coreHost, corePort, credentials)

    // Resolve the bundled UCI HTML via Electron's app path so it works both
    // in dev (npm start) and in a packaged app — never relative to __dirname.
    const uciHtmlPath = path.join(app.getAppPath(), 'assets', 'uci', 'foh-uci.html')

    const server = http.createServer((req, res) => {
      if (this.mappingsHandler?.handle(req, res)) return

      if (req.method === 'GET' && (req.url === '/foh-uci' || req.url?.startsWith('/foh-uci?'))) {
        fs.readFile(uciHtmlPath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end(`FOH UCI not found at: ${uciHtmlPath}`)
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(data)
        })
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
    })

    server.on('error', (err) => {
      this._lastError = err.message
      this.emit('error', err)
    })

    // ------------------------------------------------------------------
    // /qrc — raw QRC TCP relay, one TCP connection per WS client.
    // Browser sends raw JSON-RPC strings; we append \0 and forward to Core.
    // Core responses (split on \0) are forwarded back as WS text frames.
    // ------------------------------------------------------------------
    const wss = new WebSocketServer({ server, path: '/qrc' })

    wss.on('connection', (ws: InstanceType<typeof WebSocket>) => {
      const tcp = new Socket()
      let tcpBuf = ''

      const relay = { ws, tcp }
      this.relays.add(relay)
      this.emit('client-connected')

      // When the Core has Access Control enabled it rejects every call until
      // a Logon succeeds. The relay is a byte-for-byte proxy, so it logs on
      // on the browser's behalf rather than baking credentials into the UCI.
      //
      // Set before connect(), not inside the callback: a net.Socket is
      // `writable` while it is still connecting, so a browser message
      // arriving in that window would otherwise be queued ahead of the Logon
      // and be the first thing the Core sees.
      let logonPending = !!credentials?.username
      const preLogonQueue: string[] = []
      let logonTimer: ReturnType<typeof setTimeout> | null = null

      const sendToCore = (msg: string) => {
        if (tcp.writable) tcp.write(msg + '\0', 'utf-8')
      }

      /** Stop holding browser traffic and forward whatever has piled up. */
      const releaseQueue = () => {
        logonPending = false
        if (logonTimer) { clearTimeout(logonTimer); logonTimer = null }
        for (const queued of preLogonQueue) sendToCore(queued)
        preLogonQueue.length = 0
      }

      tcp.connect(corePort, coreHost, () => {
        console.log(`[UCI] TCP relay connected to ${coreHost}:${corePort}`)
        if (credentials?.username) {
          sendToCore(JSON.stringify({
            jsonrpc: '2.0',
            id: RELAY_LOGON_ID,
            method: 'Logon',
            params: { User: credentials.username, Password: credentials.password ?? '' },
          }))
          // Don't let a Core that never answers the Logon strand the UCI
          // behind a queue that is waiting on a reply that isn't coming.
          logonTimer = setTimeout(() => {
            if (!logonPending) return
            console.error('[UCI] No Logon reply from the Core — releasing queued traffic')
            releaseQueue()
          }, LOGON_TIMEOUT_MS)
        }
      })

      tcp.on('data', (chunk) => {
        tcpBuf += chunk.toString('utf-8')
        let i: number
        while ((i = tcpBuf.indexOf('\0')) !== -1) {
          const msg = tcpBuf.slice(0, i)
          tcpBuf = tcpBuf.slice(i + 1)
          if (!msg.trim()) continue
          if (logonPending && isRelayLogonReply(msg)) {
            let rejected = false
            try {
              const reply = JSON.parse(msg) as { error?: { message: string } }
              rejected = !!reply.error
              if (reply.error) {
                console.error(`[UCI] Core logon failed: ${reply.error.message}`)
                if (ws.readyState === WebSocket.OPEN) {
                  ws.close(1011, closeReason(`Core logon failed: ${reply.error.message}`))
                }
              } else {
                console.log(`[UCI] Relay logged on as "${credentials?.username}"`)
              }
            } catch { /* unparseable — treat as success, the Core accepted it */ }
            // Either way we stop holding traffic: on success it flows, on
            // rejection the socket is closing and the queue is discarded.
            if (rejected) preLogonQueue.length = 0
            releaseQueue()
            continue
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(msg)
        }
      })

      tcp.on('error', (err) => {
        console.error('[UCI] TCP relay error:', err.message)
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, closeReason(err.message))
      })

      tcp.on('close', () => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Core TCP closed')
      })

      ws.on('message', (data: Buffer | string) => {
        const msg = data.toString()
        // Hold browser traffic until the Logon has been answered, so the Core
        // never sees a call it would reject before we are authenticated.
        if (logonPending) preLogonQueue.push(msg)
        else sendToCore(msg)
      })

      ws.on('close', () => {
        if (logonTimer) { clearTimeout(logonTimer); logonTimer = null }
        tcp.destroy()
        this.relays.delete(relay)
        this.emit('client-disconnected')
        console.log('[UCI] client disconnected')
      })
    })

    server.listen(port, host, () => {
      console.log(`[UCI] listening on http://${host}:${port} (relay → ${coreHost}:${corePort})`)
      this.listening = true
      this._lastError = null
      this.emit('listening', { host, port })
    })

    this.server = server
    this.wss = wss
  }

  /**
   * Stop the server: destroy all open relay sockets (both TCP and WS) and
   * close the HTTP/WS server. Safe to call if never started or already stopped.
   */
  stop(): void {
    this.mappingsHandler?.disconnect()

    for (const { ws, tcp } of this.relays) {
      try { tcp.destroy() } catch { /* ignore */ }
      try { ws.terminate() } catch { /* ignore */ }
    }
    this.relays.clear()

    this.wss?.close()
    this.wss = null

    this.server?.close()
    this.server = null
    this.listening = false
  }

  /** Number of currently open browser↔Core relay connections. */
  get clientCount(): number { return this.relays.size }

  /** True once `start()`'s `server.listen` callback has fired, false after `stop()`/before `start()`. */
  get isListening(): boolean { return this.listening }

  /** Last error message emitted via the `error` event, cleared on a successful `start()`. */
  get lastError(): string | null { return this._lastError }
}
