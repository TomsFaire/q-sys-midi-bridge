/**
 * mappings-http — HTTP routes for the browser-based MIDI mappings page:
 * password login, session cookies, and a JSON API mirroring the desktop
 * Configurator's IPC handlers (list/save/apply mappings, discover Q-Sys
 * components). Mounted into UciServer's request handler.
 */

import http from 'node:http'
import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { stripComments } from './config.js'
import { verifyPassword, SessionStore } from './auth.js'
import {
  PHYSICAL_CONTROLS,
  loadMappings,
  saveMappings,
  saveAndApplyMappings,
  validateMappings,
  discoverComponents,
  getComponentControls,
} from './mapping-service.js'

const SESSION_COOKIE = 'mqb_mappings_session'

export class MappingsHttpHandler {
  private qrc: QrcClient | null = null
  private sessions = new SessionStore()

  constructor(
    private readonly configFilePath: string,
    private readonly mappingsHtmlPath: string,
    private readonly onReload?: () => Promise<void>,
  ) {}

  /** Opens the discovery QRC connection. Call once, alongside UciServer.start(). */
  connect(coreHost: string, corePort: number): void {
    this.qrc = new QrcClient(coreHost, corePort)
    this.qrc.connect().catch(() => { /* discovery calls surface the error */ })
  }

  /** Tears down the discovery QRC connection. Call alongside UciServer.stop(). */
  disconnect(): void {
    this.qrc?.disconnect().catch(() => {})
    this.qrc = null
  }

  private readPasswordHash(): string | null {
    try {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = JSON.parse(stripComments(raw)) as Record<string, unknown>
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      return (uci.mappingsPasswordHash as string | undefined) ?? null
    } catch {
      return null
    }
  }

  private getSessionToken(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie
    if (!cookieHeader) return null
    for (const part of cookieHeader.split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key === SESSION_COOKIE) return rest.join('=')
    }
    return null
  }

  private isAuthenticated(req: http.IncomingMessage): boolean {
    return this.sessions.isValid(this.getSessionToken(req))
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => {
        if (!data) { resolve(undefined); return }
        try { resolve(JSON.parse(data)) } catch (err) { reject(err) }
      })
      req.on('error', reject)
    })
  }

  /**
   * Handles the request if its URL matches a route this module owns.
   * Returns true if handled (caller should stop routing), false otherwise.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://internal')
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/mappings') {
      fs.readFile(this.mappingsHtmlPath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end(`Mappings page not found at: ${this.mappingsHtmlPath}`)
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(data)
      })
      return true
    }

    if (pathname === '/api/mappings/login' && req.method === 'POST') {
      this.readJsonBody(req).then((body) => {
        const password = (body as Record<string, unknown> | undefined)?.password
        const storedHash = this.readPasswordHash()
        if (!storedHash) {
          this.sendJson(res, 409, { error: 'No mappings password has been set yet — set one in the Configurator Network panel.' })
          return
        }
        if (typeof password !== 'string' || !verifyPassword(password, storedHash)) {
          this.sendJson(res, 401, { error: 'Incorrect password' })
          return
        }
        const token = this.sessions.create()
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`)
        this.sendJson(res, 200, { ok: true })
      }).catch(() => this.sendJson(res, 400, { error: 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/mappings/session' && req.method === 'GET') {
      this.sendJson(res, 200, { authenticated: this.isAuthenticated(req), passwordSet: !!this.readPasswordHash() })
      return true
    }

    if (!pathname.startsWith('/api/mappings') && !pathname.startsWith('/api/qsys')) {
      return false
    }

    if (!this.isAuthenticated(req)) {
      this.sendJson(res, 401, { error: 'Not authenticated' })
      return true
    }

    if (pathname === '/api/mappings' && req.method === 'GET') {
      try {
        const mappings = loadMappings(this.configFilePath)
        this.sendJson(res, 200, { physicalControls: PHYSICAL_CONTROLS, mappings })
      } catch (err) {
        this.sendJson(res, 500, { error: (err as Error).message })
      }
      return true
    }

    if (pathname === '/api/mappings' && req.method === 'POST') {
      this.readJsonBody(req).then((body) => {
        const result = validateMappings(body)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        saveMappings(this.configFilePath, result.mappings)
        this.sendJson(res, 200, { ok: true, count: result.mappings.length })
      }).catch(() => this.sendJson(res, 400, { error: 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/mappings/apply' && req.method === 'POST') {
      this.readJsonBody(req).then(async (body) => {
        const result = validateMappings(body)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        await saveAndApplyMappings(this.configFilePath, result.mappings, this.onReload)
        this.sendJson(res, 200, { ok: true, count: result.mappings.length })
      }).catch((err) => this.sendJson(res, 400, { error: (err as Error).message ?? 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/qsys/components' && req.method === 'GET') {
      discoverComponents(this.qrc)
        .then((components) => this.sendJson(res, 200, { components }))
        .catch((err) => this.sendJson(res, 503, { error: (err as Error).message }))
      return true
    }

    const controlsMatch = pathname.match(/^\/api\/qsys\/components\/([^/]+)\/controls$/)
    if (controlsMatch && req.method === 'GET') {
      if (!this.qrc?.isConnected) {
        this.sendJson(res, 503, { error: 'Q-SYS not connected — check host in config.json' })
        return true
      }
      const componentName = decodeURIComponent(controlsMatch[1])
      getComponentControls(this.qrc, componentName)
        .then((controls) => this.sendJson(res, 200, { controls }))
        .catch((err) => this.sendJson(res, 503, { error: (err as Error).message }))
      return true
    }

    this.sendJson(res, 404, { error: 'Not found' })
    return true
  }
}
