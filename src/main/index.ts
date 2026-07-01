/**
 * Electron main process — menu bar app entry point.
 *
 * No Dock icon. Tray shows connection status and rebuilds on click.
 * Config is loaded once at startup; restart app to reload config changes.
 */

import { app, Tray, Menu, nativeImage, shell, clipboard } from 'electron'
import path from 'node:path'
import { loadConfig, getConfigPath, findConfigPath, seedUserConfig } from './config.js'
import { Bridge } from './bridge.js'
import { UciServer } from './uci-server.js'
import { Configurator } from './configurator.js'
import { getLanIPv4 } from './network.js'

// No Dock icon on macOS
app.dock?.hide()

// Single-instance lock
if (!app.requestSingleInstanceLock()) {
  console.error('[Bridge] Already running — quit the tray app first, then restart.')
  app.quit()
  process.exit(0)
}

function makeIcon(connected: boolean): Electron.NativeImage {
  // 16x16 RGBA pixel buffer — all pixels fully black, alpha varies
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    // Draw a filled circle (radius 6 centered at 8,8)
    const dx = x - 7.5
    const dy = y - 7.5
    const inCircle = Math.sqrt(dx * dx + dy * dy) <= 6
    buf[i * 4 + 0] = 0   // R
    buf[i * 4 + 1] = 0   // G
    buf[i * 4 + 2] = 0   // B
    buf[i * 4 + 3] = inCircle ? (connected ? 255 : 80) : 0  // A
  }
  const img = nativeImage.createFromBuffer(buf, { width: size, height: size })
  img.setTemplateImage(true)
  return img
}

app.whenReady().then(async () => {
  // Seed writable config into userData on first launch (packaged app)
  seedUserConfig()

  let config
  try {
    config = loadConfig()
  } catch (err) {
    console.error(err)
    // Still start the app — show error in tray menu
  }

  const bridge = config ? new Bridge(config) : null

  // UCI web server — serves foh-uci.html and relays browser WS traffic to the
  // Core over its own TCP sockets (independent of the MIDI bridge connection).
  const uciEnabled = config?.uci?.enabled ?? true
  const uciPort = config?.uci?.port ?? 3001
  let uciServer: UciServer | null = null
  if (config && uciEnabled) {
    uciServer = new UciServer()
    uciServer.on('error', (err: Error) => {
      console.error(`[UCI] Server error: ${err.message}`)
    })
    // Bind 0.0.0.0 so LAN devices (iPad) can reach it; relay target is the
    // same Core the MIDI bridge talks to.
    uciServer.start('0.0.0.0', uciPort, config.qsys.host, config.qsys.port)
  }

  // Configurator window (lazily opened from tray menu)
  const configurator = new Configurator(
    config?.qsys.host ?? '10.4.84.20',
    config?.qsys.port ?? 1710,
    findConfigPath(),
    bridge ? async () => { await bridge.reloadConfig() } : undefined,
    uciPort,
  )

  // Build the tray icon
  const tray = new Tray(makeIcon(false))
  tray.setToolTip('MIDI Q-Sys Bridge')

  function buildMenu(): Electron.Menu {
    const qrcOk = bridge?.qrcConnected ?? false
    const midiOk = bridge?.midiConnected ?? false

    const lanIp = getLanIPv4()
    const uciUrl = uciEnabled && lanIp ? `http://${lanIp}:${uciPort}/foh-uci` : null
    const uciError = uciServer?.lastError ?? null
    const uciClients = uciServer?.clientCount ?? 0
    const uciClientSuffix = uciClients > 0 ? ` (${uciClients} client${uciClients === 1 ? '' : 's'})` : ''
    const uciLabel = !uciEnabled
      ? 'UCI:    ○ Disabled'
      : uciError
        ? `UCI:    ✕ Error: ${uciError}`
        : uciUrl
          ? `UCI:    ● ${uciUrl}${uciClientSuffix}`
          : 'UCI:    ○ No network'

    const items: Electron.MenuItemConstructorOptions[] = [
      {
        label: `Q-Sys:  ${qrcOk ? `● Connected (${bridge!.qsysHost})` : '○ Disconnected'}`,
        enabled: false,
      },
      {
        label: `MIDI:   ${midiOk ? `● ${bridge!.midiDeviceName}` : '○ Not found'}`,
        enabled: false,
      },
      {
        label: uciLabel,
        enabled: false,
      },
      {
        label: 'Copy UCI Link',
        enabled: !!uciUrl,
        click: () => {
          if (uciUrl) clipboard.writeText(uciUrl)
        },
      },
      { type: 'separator' },
    ]

    const activity = bridge?.recentActivity ?? []
    if (activity.length > 0) {
      items.push({ label: 'Recent activity:', enabled: false })
      for (const line of activity.slice(0, 5)) {
        items.push({ label: `  ${line}`, enabled: false })
      }
      items.push({ type: 'separator' })
    }

    items.push(
      {
        label: 'Configure Mappings…',
        click: () => configurator.open(),
      },
      {
        label: 'Open Config File',
        click: () => {
          const p = findConfigPath()
          shell.openPath(p).catch(() => {
            shell.openPath(path.join(app.getAppPath(), 'config', 'config.json'))
          })
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => app.quit(),
      }
    )

    return Menu.buildFromTemplate(items)
  }

  // Update tray icon based on connection state
  function refreshTray(): void {
    const connected = (bridge?.qrcConnected ?? false) && (bridge?.midiConnected ?? false)
    tray.setImage(makeIcon(connected))
    tray.setContextMenu(buildMenu())
  }

  tray.setContextMenu(buildMenu())

  // Rebuild menu on click so status is always fresh
  tray.on('click', refreshTray)
  tray.on('right-click', refreshTray)

  // Rebuild whenever bridge status changes
  bridge?.on('status-change', refreshTray)

  // Rebuild whenever the UCI server's connection/error state changes
  uciServer?.on('listening', refreshTray)
  uciServer?.on('error', refreshTray)
  uciServer?.on('client-connected', refreshTray)
  uciServer?.on('client-disconnected', refreshTray)

  // Also refresh on a timer in case the tray menu is already open
  setInterval(refreshTray, 3000)

  if (bridge) {
    await bridge.start()
    refreshTray()
  } else {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '⚠ No config.json found', enabled: false },
        { label: `Expected: ${getConfigPath()}`, enabled: false },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ])
    )
  }

  app.on('before-quit', async () => {
    uciServer?.stop()
    await bridge?.stop()
  })
})
