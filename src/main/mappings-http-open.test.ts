/**
 * The mappings editor is open until a password is set.
 *
 * Some installs sit on a secured VLAN with nothing else on it, and a user who
 * lands on /mappings from the UCI would otherwise never learn that a password
 * can be set (the only place is the desktop Configurator). So with no password
 * the API is open and the page shows a subtle notice; the moment one is set,
 * every route needs a session again. The risky edge is a config the server
 * cannot read: that must stay locked, never fall open.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { MappingsHttpHandler } from './mappings-http.js'
import { hashPassword } from './auth.js'

interface Rig { base: string; configFile: string; close: () => Promise<void> }

async function rig(uci: Record<string, unknown> | null, rawConfig?: string): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-open-'))
  const configFile = path.join(root, 'config.json')
  fs.writeFileSync(configFile, rawConfig ?? JSON.stringify({
    qsys: { host: '192.168.1.50', port: 1710 },
    midi: { deviceName: 'MIDI Mix' },
    mappings: [],
    feedback: { enabled: true },
    ...(uci ? { uci } : {}),
  }))
  const handler = new MappingsHttpHandler(configFile, path.join(root, 'missing.html'), undefined, path.join(root, 'shows'))
  const server = http.createServer((req, res) => {
    if (handler.handle(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    base: `http://127.0.0.1:${port}`,
    configFile,
    close: () => new Promise<void>(r => server.close(() => { fs.rmSync(root, { recursive: true, force: true }); r() })),
  }
}

test('with no password, the session reports authenticated and passwordSet false', async () => {
  const r = await rig(null)
  try {
    const body = await (await fetch(r.base + '/api/mappings/session')).json()
    assert.deepEqual(body, { authenticated: true, passwordSet: false })
  } finally { await r.close() }
})

test('with no password, the mappings and shows routes answer without a session', async () => {
  const r = await rig({})
  try {
    assert.equal((await fetch(r.base + '/api/mappings')).status, 200)
    assert.equal((await fetch(r.base + '/api/mappings/shows')).status, 200)
  } finally { await r.close() }
})

test('login still answers 409 when no password is set', async () => {
  const r = await rig({})
  try {
    const res = await fetch(r.base + '/api/mappings/login', { method: 'POST', body: JSON.stringify({ password: 'x' }) })
    assert.equal(res.status, 409)
  } finally { await r.close() }
})

test('with a password set, the same routes need a session', async () => {
  const r = await rig({ mappingsPasswordHash: hashPassword('showtime') })
  try {
    assert.equal((await fetch(r.base + '/api/mappings')).status, 401)
    assert.equal((await fetch(r.base + '/api/mappings/shows')).status, 401)
    const body = await (await fetch(r.base + '/api/mappings/session')).json()
    assert.deepEqual(body, { authenticated: false, passwordSet: true })
  } finally { await r.close() }
})

test('setting a password closes a previously open server without a restart', async () => {
  const r = await rig({})
  try {
    assert.equal((await fetch(r.base + '/api/mappings')).status, 200)
    const cfg = JSON.parse(fs.readFileSync(r.configFile, 'utf-8'))
    cfg.uci = { mappingsPasswordHash: hashPassword('showtime') }
    fs.writeFileSync(r.configFile, JSON.stringify(cfg))
    assert.equal((await fetch(r.base + '/api/mappings')).status, 401)
  } finally { await r.close() }
})

test('a config the server cannot read stays locked, never open', async () => {
  const r = await rig(null, '{ this is not json')
  try {
    assert.equal((await fetch(r.base + '/api/mappings')).status, 401)
    const body = await (await fetch(r.base + '/api/mappings/session')).json()
    assert.equal(body.authenticated, false)
  } finally { await r.close() }
})
