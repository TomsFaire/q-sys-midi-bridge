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

export class UciServer extends EventEmitter {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  // Track open relay pairs so stop() can tear them all down.
  private relays = new Set<{ ws: WebSocket; tcp: Socket }>()
  private listening = false
  private _lastError: string | null = null

  /**
   * Start the UCI HTTP + WebSocket relay server.
   *
   * @param host       interface to bind (use '0.0.0.0' so LAN devices reach it)
   * @param port       HTTP/WS port
   * @param coreHost   Q-Sys Core host for the TCP relay target
   * @param corePort   Q-Sys Core QRC port (1710)
   */
  start(host: string, port: number, coreHost: string, corePort: number): void {
    if (this.server) return  // already started

    // Resolve the bundled UCI HTML via Electron's app path so it works both
    // in dev (npm start) and in a packaged app — never relative to __dirname.
    const uciHtmlPath = path.join(app.getAppPath(), 'assets', 'uci', 'foh-uci.html')

    const server = http.createServer((req, res) => {
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

    wss.on('connection', (ws) => {
      const tcp = new Socket()
      let tcpBuf = ''

      const relay = { ws, tcp }
      this.relays.add(relay)
      this.emit('client-connected')

      tcp.connect(corePort, coreHost, () => {
        console.log(`[UCI] TCP relay connected to ${coreHost}:${corePort}`)
      })

      tcp.on('data', (chunk) => {
        tcpBuf += chunk.toString('utf-8')
        let i: number
        while ((i = tcpBuf.indexOf('\0')) !== -1) {
          const msg = tcpBuf.slice(0, i)
          tcpBuf = tcpBuf.slice(i + 1)
          if (msg.trim() && ws.readyState === WebSocket.OPEN) ws.send(msg)
        }
      })

      tcp.on('error', (err) => {
        console.error('[UCI] TCP relay error:', err.message)
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, err.message)
      })

      tcp.on('close', () => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'Core TCP closed')
      })

      ws.on('message', (data) => {
        if (tcp.writable) tcp.write(data.toString() + '\0', 'utf-8')
      })

      ws.on('close', () => {
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
