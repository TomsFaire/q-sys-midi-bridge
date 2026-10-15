/**
 * One password for everything, or none.
 *
 * With no mappings password set, the UCI page, its /qrc relay and the mappings
 * editor are all open (secured-VLAN installs). Once a password is set, all of
 * them need the same session: /foh-uci serves a sign-in page instead of the
 * mixer, and the /qrc WebSocket upgrade is refused. Before this, the mixer and
 * routing stayed open while only the mappings editor was locked.
 *
 * These run the real UciServer and MappingsHttpHandler over loopback.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import net from 'node:net'
import { WebSocket } from 'ws'
import { MappingsHttpHandler } from './mappings-http.js'
import { hashPassword } from './auth.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const REPO_ROOT = path.join(__dirname, '..', '..')
const PASSWORD = 'showtime'

function loadUciServer(): Any {
  const M = Module as Any
  const realLoad = M._load
  M._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return { app: { getAppPath: () => REPO_ROOT } }
    return realLoad.call(this, request, ...rest)
  }
  try { return require('./uci-server.js') } finally { M._load = realLoad }
}

interface Rig { base: string; port: number; close: () => Promise<void> }

async function rig(opts: { password?: boolean; rawConfig?: string }): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-gate-'))
  const configFile = path.join(root, 'config.json')
  fs.writeFileSync(configFile, opts.rawConfig ?? JSON.stringify({
    qsys: { host: '127.0.0.1', port: 1710 },
    midi: { deviceName: 'MIDI Mix' },
    mappings: [],
    feedback: { enabled: true },
    ...(opts.password ? { uci: { mappingsPasswordHash: hashPassword(PASSWORD) } } : {}),
  }))
  const coreSockets = new Set<net.Socket>()
  // Answers every call with `result: true`, so the bridge's own startup calls
  // settle instead of leaving timers that keep the test process alive.
  const core = net.createServer(sock => {
    coreSockets.add(sock)
    let buf = ''
    sock.on('data', chunk => {
      buf += chunk.toString('utf-8')
      let i: number
      while ((i = buf.indexOf('\0')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: true }) + '\0')
      }
    })
    sock.on('error', () => {})
  })
  await new Promise<void>(r => core.listen(0, '127.0.0.1', r))
  const corePort = (core.address() as net.AddressInfo).port

  const handler = new MappingsHttpHandler(configFile, path.join(REPO_ROOT, 'assets', 'mappings', 'mappings.html'))
  const { UciServer } = loadUciServer()
  const server = new UciServer()
  const listening = new Promise<void>(r => server.once('listening', () => r()))
  server.start('127.0.0.1', 0, '127.0.0.1', corePort, handler)
  await listening
  const port = (server as Any).server.address().port as number
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      server.stop()
      handler.disconnect()
      for (const s of coreSockets) s.destroy()
      await new Promise<void>(r => core.close(() => r()))
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** Opens a /qrc WebSocket; resolves 'open' or the HTTP status that refused it. */
function wsOutcome(port: number, cookie?: string): Promise<'open' | number> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/qrc`, { headers: cookie ? { cookie } : {} })
    ws.once('open', () => { ws.terminate(); resolve('open') })
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate() })
    ws.once('error', () => { /* paired with unexpected-response */ })
  })
}

async function signIn(r: Rig): Promise<string> {
  const res = await fetch(r.base + '/api/mappings/login', { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

test('with no password, the UCI page and the /qrc relay are open', async () => {
  const r = await rig({})
  try {
    const page = await fetch(r.base + '/foh-uci')
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>FOH Mixer<\/title>/)
    assert.equal(await wsOutcome(r.port), 'open')
  } finally { await r.close() }
})

test('with a password set and no session, /foh-uci is a sign-in page, not the mixer', async () => {
  const r = await rig({ password: true })
  try {
    const res = await fetch(r.base + '/foh-uci')
    assert.equal(res.status, 401)
    const body = await res.text()
    assert.doesNotMatch(body, /<title>FOH Mixer<\/title>/)
    assert.match(body, /id="login-password"/)
    assert.equal(res.headers.get('cache-control'), 'no-store')
  } finally { await r.close() }
})

test('with a password set and no session, the /qrc relay refuses the upgrade', async () => {
  const r = await rig({ password: true })
  try {
    assert.equal(await wsOutcome(r.port), 401)
  } finally { await r.close() }
})

test('after signing in, the page and the relay open with the same session', async () => {
  const r = await rig({ password: true })
  try {
    const cookie = await signIn(r)
    assert.ok(cookie, 'login should set a session cookie')
    const page = await fetch(r.base + '/foh-uci', { headers: { cookie } })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /<title>FOH Mixer<\/title>/)
    assert.equal(await wsOutcome(r.port, cookie), 'open')
  } finally { await r.close() }
})

test('a wrong session cookie is refused everywhere', async () => {
  const r = await rig({ password: true })
  try {
    const bad = 'mqb_mappings_session=deadbeef'
    assert.equal((await fetch(r.base + '/foh-uci', { headers: { cookie: bad } })).status, 401)
    assert.equal(await wsOutcome(r.port, bad), 401)
  } finally { await r.close() }
})

test('a config the server cannot read keeps the UCI locked', async () => {
  const r = await rig({ rawConfig: '{ not json' })
  try {
    assert.equal((await fetch(r.base + '/foh-uci')).status, 401)
    assert.equal(await wsOutcome(r.port), 401)
  } finally { await r.close() }
})
