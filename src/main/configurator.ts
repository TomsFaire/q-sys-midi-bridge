/**
 * Configurator — opens the "Configure Mappings" BrowserWindow and handles
 * all IPC for component discovery, config load, and config save.
 *
 * Uses its own QrcClient so it never competes with the live bridge connection.
 * The connection is opened when the window opens, closed when it closes.
 */

import { BrowserWindow, ipcMain, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { isValidPort, stripComments } from './config.js'
import type { Mapping } from './config.js'
import { getLanIPv4 } from './network.js'
import { hashPassword } from './auth.js'
import {
  PHYSICAL_CONTROLS,
  discoverComponents,
  getComponentControls,
  saveMappings,
  saveAndApplyMappings,
} from './mapping-service.js'

// ── Configurator class ────────────────────────────────────────────────────────

export class Configurator {
  private window: BrowserWindow | null = null
  private qrc: QrcClient | null = null
  private ipcRegistered = false

  constructor(
    private host: string,
    private readonly port: number,
    private readonly configFilePath: string,
    private readonly onReload?: () => Promise<void>,
    // Configured UCI web server port — used as the fallback when config.uci
    // hasn't been written to the file yet (e.g. no config.json present).
    private readonly uciPort: number = 3001,
    private readonly isBridgeActive: () => boolean = () => false,
  ) {
    this.registerIpc()
  }

  open(): void {
    if (this.window) {
      this.window.focus()
      return
    }

    // Fresh QRC connection just for discovery
    this.qrc = new QrcClient(this.host, this.port)
    this.qrc.connect().catch(() => { /* status shown in UI */ })

    this.window = new BrowserWindow({
      width: 1150,
      height: 740,
      minWidth: 900,
      minHeight: 500,
      title: 'MIDI Q-Sys Bridge — Configure Mappings',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
      },
    })

    const htmlPath = path.join(app.getAppPath(), 'src', 'renderer', 'configurator.html')
    this.window.loadFile(htmlPath)

    this.window.on('closed', () => {
      this.window = null
      this.qrc?.disconnect().catch(() => {})
      this.qrc = null
    })
  }

  private parseConfig(raw: string): Record<string, unknown> {
    const clean = stripComments(raw)
    return JSON.parse(clean) as Record<string, unknown>
  }

  private readUciConfig(): { enabled?: boolean; port?: number; mappingsPasswordHash?: string } {
    try {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      return (config.uci as { enabled?: boolean; port?: number; mappingsPasswordHash?: string } | undefined) ?? {}
    } catch {
      return {}
    }
  }

  private registerIpc(): void {
    if (this.ipcRegistered) return
    this.ipcRegistered = true

    // ── Physical controls list ──────────────────────────────────────────────
    ipcMain.handle('cfg:get-physical-controls', () => PHYSICAL_CONTROLS)

    // ── Q-SYS connection status ─────────────────────────────────────────────
    ipcMain.handle('cfg:get-qsys-status', () => ({
      connected: this.qrc?.isConnected ?? false,
      host: this.host,
    }))

    // ── Get / save Q-SYS host ───────────────────────────────────────────────
    ipcMain.handle('cfg:get-host', () => this.host)

    ipcMain.handle('cfg:save-host', async (event, host: string) => {
      const trimmed = host.trim()

      try {
        const raw = fs.readFileSync(this.configFilePath, 'utf-8')
        const config = this.parseConfig(raw)
        ;(config.qsys as Record<string, unknown>).host = trimmed
        fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
      } catch (err) {
        throw new Error(`Could not save config: ${(err as Error).message}`)
      }

      // Reconnect the configurator's own QRC to the new host
      this.host = trimmed
      this.qrc?.disconnect().catch(() => {})
      if (trimmed) {
        this.qrc = new QrcClient(trimmed, this.port)
        // Push a status update to the renderer window when the connection lands
        this.qrc.once('connect', () => {
          this.window?.webContents.send('cfg:host-connected')
        })
        this.qrc.connect().catch(() => {})
      } else {
        this.qrc = null
      }

      // Reload the bridge if it is running (no-op via optional chaining when bridge is null)
      if (this.onReload) await this.onReload()

      return { needsRestart: !this.isBridgeActive() }
    })

    // ── Discover all components ─────────────────────────────────────────────
    ipcMain.handle('cfg:discover-components', () => discoverComponents(this.qrc))

    // ── Get controls for a specific component ───────────────────────────────
    ipcMain.handle('cfg:get-component-controls', (_event, componentName: string) =>
      getComponentControls(this.qrc, componentName))

    // ── Load current config ─────────────────────────────────────────────────
    ipcMain.handle('cfg:load-config', () => {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      return this.parseConfig(raw)
    })

    // ── Save new mappings (preserves everything else in config) ─────────────
    ipcMain.handle('cfg:save-config', (_event, mappings: Mapping[]) =>
      saveMappings(this.configFilePath, mappings))

    // ── Save + hot-reload (no restart needed) ───────────────────────────────
    ipcMain.handle('cfg:save-and-apply', (_event, mappings: Mapping[]) =>
      saveAndApplyMappings(this.configFilePath, mappings, this.onReload))

    // ── Network info (UCI web server LAN URL) ───────────────────────────────
    ipcMain.handle('cfg:get-network-info', () => {
      const uci = this.readUciConfig()
      const port = uci.port ?? this.uciPort
      const lanIp = getLanIPv4()
      return {
        localUrl: `http://localhost:${port}/foh-uci`,
        lanUrl: lanIp ? `http://${lanIp}:${port}/foh-uci` : null,
        uciEnabled: uci.enabled ?? true,
        uciPort: port,
      }
    })

    // ── Enable/disable the UCI web server (restart required to apply) ──────
    ipcMain.handle('cfg:set-uci-enabled', (_event, enabled: boolean) => {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      uci.enabled = enabled
      config.uci = uci
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
    })

    // ── Set the UCI web server port (restart required to apply) ────────────
    ipcMain.handle('cfg:set-uci-port', (_event, port: number) => {
      if (!isValidPort(port)) {
        throw new Error('Port must be a whole number between 1 and 65535')
      }
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      uci.port = port
      config.uci = uci
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
    })

    // ── Relaunch the app (used after a port change) ─────────────────────────
    ipcMain.handle('cfg:restart-app', () => {
      app.relaunch()
      app.exit(0)
    })

    // ── Set the browser mappings-page password (hashed, plaintext never stored) ─
    ipcMain.handle('cfg:set-mappings-password', (_event, password: string) => {
      const trimmed = password.trim()
      if (trimmed.length < 4) {
        throw new Error('Password must be at least 4 characters')
      }
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      uci.mappingsPasswordHash = hashPassword(trimmed)
      config.uci = uci
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
    })

    // ── Whether a mappings-page password has been set yet ───────────────────
    ipcMain.handle('cfg:has-mappings-password', () => !!this.readUciConfig().mappingsPasswordHash)
  }
}
