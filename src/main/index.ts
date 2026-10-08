/**
 * Electron main process — menu bar app entry point.
 *
 * No Dock icon. Tray shows connection status and rebuilds on click.
 * Config is loaded once at startup; restart app to reload config changes.
 */

import { app, Tray, Menu, nativeImage, shell, clipboard, powerSaveBlocker } from 'electron'
import path from 'node:path'
import { loadConfig, getConfigPath, findConfigPath, getShowsDir, seedUserConfig } from './config.js'
import { listShows, writeShow, recallShow, listAutoBackups, autoDirFor } from './show-service.js'
import { loadMappings } from './mapping-service.js'
import { Bridge } from './bridge.js'
import { UciServer } from './uci-server.js'
import { MappingsHttpHandler } from './mappings-http.js'
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

  const hasHost = !!config?.qsys?.host
  const bridge = config && hasHost ? new Bridge(config) : null

  /** Hot-reload after anything rewrites the config. Shared by both editors and the tray. */
  const onReload = async () => { await bridge?.reloadConfig() }

  const showsDir = getShowsDir()

  // The show list is read from disk only on demand — never from buildMenu(),
  // which also runs on a 3s timer. A readdir plus a parse per show every three
  // seconds, forever, on a machine whose whole job is not to glitch during a
  // show, is not a trade worth making.
  let cachedShows = listShows(showsDir)
  let cachedBackups = listAutoBackups(autoDirFor(showsDir))
  let showError: string | null = null
  let menuOpen = false

  function reloadShowCache(): void {
    try {
      cachedShows = listShows(showsDir)
      cachedBackups = listAutoBackups(autoDirFor(showsDir))
    } catch (err) {
      showError = (err as Error).message
    }
  }

  /** Recalls from a directory, then refreshes the cache and tray. Errors land in the menu. */
  function recallFrom(dir: string, id: string): void {
    showError = null
    recallShow(dir, id, findConfigPath(), onReload)
      .then((r) => { showError = `Recalled "${r.name}" — ${r.count} mappings. Re-sync faders.` })
      .catch((err) => { showError = (err as Error).message })
      .finally(() => { reloadShowCache(); refreshTray() })
  }

  const recallFromTray = (id: string) => recallFrom(showsDir, id)
  /** Undo: a backup is an ordinary show file, so this is the same operation. */
  const recallFromTray__auto = (id: string) => recallFrom(autoDirFor(showsDir), id)

  /**
   * Saves the live mappings under a generated name. The tray has no text
   * input and this app uses no dialogs; renaming happens on the mappings page.
   */
  function saveShowFromTray(): void {
    showError = null
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      const saved = writeShow(showsDir, `Show ${stamp}`, loadMappings(findConfigPath()))
      showError = `Saved "${saved.name}" — ${saved.count} mappings`
    } catch (err) {
      showError = (err as Error).message
    }
    reloadShowCache()
    refreshTray()
  }

  // Populated only when the Core has Access Control enabled; blank fields
  // mean "open Core" and every consumer skips the logon.
  const qsysCredentials = {
    username: config?.qsys?.username,
    password: config?.qsys?.password,
  }

  // UCI web server — serves foh-uci.html and relays browser WS traffic to the
  // Core over its own TCP sockets (independent of the MIDI bridge connection).
  const uciEnabled = hasHost && (config?.uci?.enabled ?? true)
  const uciPort = config?.uci?.port ?? 3001
  let uciServer: UciServer | null = null
  if (config && uciEnabled) {
    const mappingsHtmlPath = path.join(app.getAppPath(), 'assets', 'mappings', 'mappings.html')
    const mappingsHandler = new MappingsHttpHandler(
      findConfigPath(),
      mappingsHtmlPath,
      onReload,
      getShowsDir(),
    )
    uciServer = new UciServer()
    uciServer.on('error', (err: Error) => {
      console.error(`[UCI] Server error: ${err.message}`)
    })
    // Bind 0.0.0.0 so LAN devices (iPad) can reach it; relay target is the
    // same Core the MIDI bridge talks to.
    uciServer.start(
      '0.0.0.0',
      uciPort,
      config.qsys.host,
      config.qsys.port,
      mappingsHandler,
      qsysCredentials,
    )
  }

  // Configurator window (lazily opened from tray menu)
  const configurator = new Configurator(
    config?.qsys.host ?? '',
    config?.qsys.port ?? 1710,
    findConfigPath(),
    async () => { await bridge?.reloadConfig() },
    uciPort,
    () => bridge !== null,
    qsysCredentials,
  )

  // Build the tray icon
  const tray = new Tray(makeIcon(false))
  tray.setToolTip('MIDI Q-Sys Bridge')

  function buildMenu(): Electron.Menu {
    const qrcOk = bridge?.qrcConnected ?? false
    const midiOk = bridge?.midiConnected ?? false
    // Takes priority over both Connected and Disconnected: a Core with Access
    // Control enabled accepts the socket and then refuses every call, so
    // "Connected" would be the most misleading thing we could show.
    const qrcError = bridge?.qrcLastError ?? null

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
        label: `Q-Sys:  ${
          qrcError
            ? `✕ ${qrcError.length > 60 ? `${qrcError.slice(0, 57)}…` : qrcError}`
            : qrcOk
              ? `● Connected (${bridge!.qsysHost})`
              : hasHost
                ? '○ Disconnected'
                : '○ No host — open Configure Mappings'
        }`,
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

    // Undo sits at the top level, not inside the submenu: a mis-recall is
    // found under time pressure, and the fix should not need navigating to.
    const lastBackup = cachedBackups[0]
    if (lastBackup) {
      items.push(
        {
          label: `Undo recall → "${lastBackup.name.replace(/^before /, '')}"`,
          click: () => recallFromTray__auto(lastBackup.id),
        },
        { type: 'separator' },
      )
    }

    const showItems: Electron.MenuItemConstructorOptions[] = cachedShows.length
      ? cachedShows.map((s) => ({
          label: `${s.name}  (${s.count})`,
          click: () => recallFromTray(s.id),
        }))
      : [{ label: 'No shows saved yet', enabled: false }]

    items.push({
      label: 'Shows',
      submenu: [
        ...showItems,
        { type: 'separator' },
        { label: 'Save Current as Show', click: () => saveShowFromTray() },
        { label: 'Open Shows Folder', click: () => { shell.openPath(showsDir) } },
      ],
    })
    if (showError) items.push({ label: `  ${showError.slice(0, 70)}`, enabled: false })
    items.push({ type: 'separator' })

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
    const menu = buildMenu()
    // Track whether a menu is on screen so the 3s timer cannot swap it out
    // from under the cursor mid-hover.
    menu.on('menu-will-show', () => { menuOpen = true })
    menu.on('menu-will-close', () => { menuOpen = false })
    tray.setContextMenu(menu)
  }

  tray.setContextMenu(buildMenu())

  // Rebuild menu on click so status is always fresh. This is also the only
  // place the show list is re-read from disk.
  const refreshFromDisk = () => { reloadShowCache(); refreshTray() }
  tray.on('click', refreshFromDisk)
  tray.on('right-click', refreshFromDisk)

  // Rebuild whenever bridge status changes
  bridge?.on('status-change', refreshTray)

  // Rebuild whenever the UCI server's connection/error state changes
  uciServer?.on('listening', refreshTray)
  uciServer?.on('error', refreshTray)
  uciServer?.on('client-connected', refreshTray)
  uciServer?.on('client-disconnected', refreshTray)

  // Also refresh on a timer in case the tray menu is already open. Suppressed
  // while a menu is actually open: setContextMenu replaces the live menu, so a
  // rebuild under the cursor can move the item being hovered — and with no
  // confirmation step, that is a silent mis-recall.
  setInterval(() => { if (!menuOpen) refreshTray() }, 3000)

  let powerSaveBlockerId: number | null = null

  if (bridge) {
    await bridge.start()
    refreshTray()
    // Keep the system awake so the Q-Sys socket and MIDI device survive
    // idle sleep — the app can't reconnect while the whole process is suspended.
    powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!hasHost) {
    // No Q-SYS host configured — open configurator immediately so user can enter it
    refreshTray()
    configurator.open()
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
    if (powerSaveBlockerId !== null) powerSaveBlocker.stop(powerSaveBlockerId)
    uciServer?.stop()
    await bridge?.stop()
  })
})
