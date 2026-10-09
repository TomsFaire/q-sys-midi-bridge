/**
 * mappings-http — HTTP routes for the browser-based MIDI mappings page:
 * password login, session cookies, and a JSON API mirroring the desktop
 * Configurator's IPC handlers (list/save/apply mappings, discover Q-Sys
 * components). Mounted into UciServer's request handler.
 */

import http from 'node:http'
import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import type { QrcCredentials } from './qrc-client.js'
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
import { listShows, writeShow, deleteShow, recallShow } from './show-service.js'

const SESSION_COOKIE = 'mqb_mappings_session'

export class MappingsHttpHandler {
  private qrc: QrcClient | null = null
  private sessions = new SessionStore()

  constructor(
    private readonly configFilePath: string,
    private readonly mappingsHtmlPath: string,
    private readonly onReload?: () => Promise<void>,
    private readonly showsDir?: string,
  ) {}

  /**
   * A cheap fingerprint of the config as it stands on disk.
   *
   * The page POSTs its whole in-memory array, so a tab left open across a
   * recall holds a pre-recall snapshot and its next save would silently
   * revert the show. Handing out a revision on read and requiring it on write
   * turns that into a 409 the page can act on.
   */
  private revision(): string {
    const s = fs.statSync(this.configFilePath)
    return `${s.mtimeMs}:${s.size}`
  }

  /**
   * Splits a save body into its mappings and the revision it was based on.
   * A body with no revision is refused rather than trusted — a page cached
   * from before this guard existed would otherwise slip straight past it.
   */
  private checkRevision(body: unknown): { ok: true; mappings: unknown } | { ok: false } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
    const { mappings, revision } = body as { mappings?: unknown; revision?: unknown }
    if (typeof revision !== 'string' || revision !== this.revision()) return { ok: false }
    return { ok: true, mappings }
  }

  /** Which show the live mappings came from, for the page header. */
  private activeShow(): unknown {
    try {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      return (JSON.parse(stripComments(raw)) as { activeShow?: unknown }).activeShow ?? null
    } catch {
      return null
    }
  }

  private sendStale(res: http.ServerResponse): void {
    this.sendJson(res, 409, {
      error: 'The mappings changed on disk — a show may have been recalled. Reload before saving.',
      revision: this.revision(),
    })
  }

  /** Opens the discovery QRC connection. Call once, alongside UciServer.start(). */
  connect(coreHost: string, corePort: number, credentials?: QrcCredentials): void {
    this.qrc = new QrcClient(coreHost, corePort, undefined, credentials)
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
        this.sendJson(res, 200, {
          physicalControls: PHYSICAL_CONTROLS,
          mappings,
          revision: this.revision(),
          activeShow: this.activeShow(),
        })
      } catch (err) {
        this.sendJson(res, 500, { error: (err as Error).message })
      }
      return true
    }

    if (pathname === '/api/mappings' && req.method === 'POST') {
      this.readJsonBody(req).then((body) => {
        const fresh = this.checkRevision(body)
        if (!fresh.ok) { this.sendStale(res); return }
        const result = validateMappings(fresh.mappings)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        saveMappings(this.configFilePath, result.mappings)
        this.sendJson(res, 200, { ok: true, count: result.mappings.length, revision: this.revision() })
      }).catch(() => this.sendJson(res, 400, { error: 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/mappings/apply' && req.method === 'POST') {
      this.readJsonBody(req).then(async (body) => {
        const fresh = this.checkRevision(body)
        if (!fresh.ok) { this.sendStale(res); return }
        const result = validateMappings(fresh.mappings)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        await saveAndApplyMappings(this.configFilePath, result.mappings, this.onReload)
        this.sendJson(res, 200, { ok: true, count: result.mappings.length, revision: this.revision() })
      }).catch((err) => this.sendJson(res, 400, { error: (err as Error).message ?? 'Invalid request body' }))
      return true
    }

    // ── Shows ────────────────────────────────────────────────────────────────
    // Nested under /api/mappings so they fall inside the auth gate above with
    // no new auth code.

    if (pathname === '/api/mappings/shows' && req.method === 'GET') {
      this.sendJson(res, 200, { shows: this.showsDir ? listShows(this.showsDir) : [] })
      return true
    }

    if (pathname === '/api/mappings/shows' && req.method === 'POST') {
      this.readJsonBody(req).then((body) => {
        if (!this.showsDir) { this.sendJson(res, 503, { error: 'Shows are not available' }); return }
        const { name, mappings } = (body ?? {}) as { name?: unknown; mappings?: unknown }
        if (typeof name !== 'string' || !name.trim()) {
          this.sendJson(res, 400, { error: 'A show needs a name' }); return
        }
        // A show that recall would refuse is a trap set for the operator, so
        // it is validated on the way in, not only on the way out.
        const result = validateMappings(mappings)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        try {
          this.sendJson(res, 200, { ok: true, show: writeShow(this.showsDir, name, result.mappings) })
        } catch (err) {
          this.sendJson(res, 400, { error: (err as Error).message })
        }
      }).catch(() => this.sendJson(res, 400, { error: 'Invalid request body' }))
      return true
    }

    const recall = pathname.match(/^\/api\/mappings\/shows\/([^/]+)\/recall$/)
    if (recall && req.method === 'POST') {
      if (!this.showsDir) { this.sendJson(res, 503, { error: 'Shows are not available' }); return true }
      let id: string
      try { id = decodeURIComponent(recall[1]) } catch { this.sendJson(res, 400, { error: 'Bad show id' }); return true }
      recallShow(this.showsDir, id, this.configFilePath, this.onReload)
        .then((r) => this.sendJson(res, 200, { ok: true, ...r, revision: this.revision() }))
        .catch((err) => {
          const message = (err as Error).message
          this.sendJson(res, /not found/i.test(message) ? 404 : 400, { error: message })
        })
      return true
    }

    const show = pathname.match(/^\/api\/mappings\/shows\/([^/]+)$/)
    if (show && req.method === 'DELETE') {
      if (!this.showsDir) { this.sendJson(res, 503, { error: 'Shows are not available' }); return true }
      try {
        deleteShow(this.showsDir, decodeURIComponent(show[1]))
        this.sendJson(res, 200, { ok: true })
      } catch (err) {
        this.sendJson(res, 404, { error: (err as Error).message })
      }
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
