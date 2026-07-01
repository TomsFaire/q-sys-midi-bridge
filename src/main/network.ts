/**
 * network — helpers for discovering the Mac's LAN-facing IPv4 address, so
 * the UCI web server's URL can be shown to a human at the venue (tray menu,
 * Configurator "Network" panel).
 */

import os from 'node:os'

/**
 * Best-effort discovery of this machine's LAN IPv4 address.
 *
 * Skips loopback/internal addresses and VPN/tunnel-style interfaces
 * (`utun*`, `ppp*`, `awdl*`, `llw*`). When multiple interfaces are up,
 * prefers `en0` (the Mac's usual Wi-Fi/Ethernet interface), then any
 * other `en*`/"Wi-Fi"-named interface, before falling back to the first
 * candidate found.
 *
 * Returns `null` if no suitable interface is found (e.g. offline).
 */
export function getLanIPv4(): string | null {
  const interfaces = os.networkInterfaces()
  const candidates: { name: string; address: string }[] = []

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    if (/^(utun|ppp|awdl|llw|lo)\d*$/i.test(name)) continue
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue
      if (addr.internal) continue
      candidates.push({ name, address: addr.address })
    }
  }

  if (candidates.length === 0) return null

  const preferred =
    candidates.find((c) => c.name === 'en0') ??
    candidates.find((c) => /wi-?fi/i.test(c.name) || /^en\d+$/i.test(c.name)) ??
    candidates[0]

  return preferred.address
}
