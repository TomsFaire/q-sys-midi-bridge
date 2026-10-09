/**
 * The shows HTTP surface, and the stale-write guard that protects it.
 *
 * The guard is the point. The mappings page POSTs its whole in-memory array,
 * so a tab left open across a recall holds a pre-recall snapshot — and its
 * next Save silently reverts the show, with no error anywhere. That is the
 * only failure in this feature with no symptom until someone presses a
 * button, so a save carrying a stale revision is refused with 409.
 *
 * MappingsHttpHandler loads outside Electron (its electron import is only
 * transitive via config.ts, and `app` is never touched at module scope), so
 * the routes are driven here over a real loopback server.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { MappingsHttpHandler } from './mappings-http.js'
import { hashPassword } from './auth.js'
import type { Mapping, Config } from './config.js'

const MUTE_1: Mapping = {
  label: 'Mute 1',
  midi: { type: 'cc', channel: 1, number: 22 },
  qsys: { type: 'toggle', component: 'Mic.01.Gain', control: 'mute' },
}
const MUTE_7: Mapping = {
  label: 'Mute 7',
  midi: { type: 'cc', channel: 1, number: 28 },
  qsys: { type: 'toggle', component: 'Mic.08.Gain', control: 'mute' },
}

const PASSWORD = 'showtime'

interface Rig {
  base: string
  cookie: string
  configFile: string
  showsDir: string
  close: () => Promise<void>
  reloads: () => number
}

/** A live server over a temp config, already logged in. */
async function rig(mappings: Mapping[] = [MUTE_1]): Promise<Rig> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-http-'))
  const showsDir = path.join(root, 'shows')
  const configFile = path.join(root, 'config.json')
  const config: Config = {
    qsys: { host: '192.168.1.50', port: 1710 },
    midi: { deviceName: 'MIDI Mix' },
    mappings,
    feedback: { enabled: true },
    uci: { mappingsPasswordHash: hashPassword(PASSWORD) },
  }
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2))

  let reloads = 0
  const handler = new MappingsHttpHandler(
    configFile,
    path.join(root, 'missing.html'),
    async () => { reloads++ },
    showsDir,
  )
  const server = http.createServer((req, res) => {
    if (handler.handle(req, res)) return
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`

  const login = await fetch(`${base}/api/mappings/login`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  })
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie, 'login should set a session cookie')

  return {
    base, cookie, configFile, showsDir,
    reloads: () => reloads,
    close: () => new Promise<void>((r) => { server.close(() => { fs.rmSync(root, { recursive: true, force: true }); r() }) }),
  }
}

const get = (r: Rig, p: string) => fetch(r.base + p, { headers: { cookie: r.cookie } })
const post = (r: Rig, p: string, body?: unknown) =>
  fetch(r.base + p, {
    method: 'POST',
    headers: { cookie: r.cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// ── the stale-write guard ────────────────────────────────────────────────────

test('a save carrying the current revision is accepted', async () => {
  const r = await rig()
  try {
    const { revision } = await (await get(r, '/api/mappings')).json()
    assert.ok(revision, 'GET should hand out a revision')

    const res = await post(r, '/api/mappings', { mappings: [MUTE_7], revision })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, 'utf-8')).mappings, [MUTE_7])
  } finally { await r.close() }
})

test('a save carrying a stale revision is refused and changes nothing', async () => {
  // The page loaded, a show was recalled behind its back, and it now tries
  // to save what it still believes is current.
  const r = await rig()
  try {
    const { revision: stale } = await (await get(r, '/api/mappings')).json()

    // Something else writes — a recall from the tray.
    await post(r, '/api/mappings', { mappings: [MUTE_7], revision: stale })
    const after = fs.readFileSync(r.configFile, 'utf-8')

    const res = await post(r, '/api/mappings', { mappings: [MUTE_1], revision: stale })
    assert.equal(res.status, 409)
    const body = await res.json()
    assert.match(body.error, /changed/i)
    assert.equal(fs.readFileSync(r.configFile, 'utf-8'), after, 'the stale save must not land')
  } finally { await r.close() }
})

test('a save with no revision at all is refused', async () => {
  // A page cached from before this guard existed would otherwise slip past it.
  const r = await rig()
  try {
    const res = await post(r, '/api/mappings', [MUTE_7])
    assert.equal(res.status, 409)
  } finally { await r.close() }
})

test('apply is guarded the same way, and does not reload on a stale save', async () => {
  const r = await rig()
  try {
    const { revision: stale } = await (await get(r, '/api/mappings')).json()
    await post(r, '/api/mappings', { mappings: [MUTE_7], revision: stale })

    const res = await post(r, '/api/mappings/apply', { mappings: [MUTE_1], revision: stale })
    assert.equal(res.status, 409)
    assert.equal(r.reloads(), 0, 'a refused apply must not reload the bridge')
  } finally { await r.close() }
})

// ── shows ────────────────────────────────────────────────────────────────────

test('a show can be saved, listed and recalled over HTTP', async () => {
  const r = await rig([MUTE_1])
  try {
    const saved = await post(r, '/api/mappings/shows', { name: 'Gala 2026', mappings: [MUTE_7] })
    assert.equal(saved.status, 200)

    const { shows } = await (await get(r, '/api/mappings/shows')).json()
    assert.deepEqual(shows.map((s: { id: string }) => s.id), ['gala-2026'])

    const res = await post(r, '/api/mappings/shows/gala-2026/recall')
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.name, 'Gala 2026')
    assert.deepEqual(JSON.parse(fs.readFileSync(r.configFile, 'utf-8')).mappings, [MUTE_7])
    assert.equal(r.reloads(), 1, 'a recall should hot-reload the bridge')
  } finally { await r.close() }
})

test('a recall hands back a new revision so the page can keep saving', async () => {
  // Without this the page would have to guess, and its next save would 409.
  const r = await rig()
  try {
    await post(r, '/api/mappings/shows', { name: 'Gala', mappings: [MUTE_7] })
    const { revision } = await (await post(r, '/api/mappings/shows/gala/recall')).json()

    const res = await post(r, '/api/mappings', { mappings: [MUTE_1], revision })
    assert.equal(res.status, 200)
  } finally { await r.close() }
})

test('a show id cannot escape the shows directory', async () => {
  const r = await rig()
  try {
    const before = fs.readFileSync(r.configFile, 'utf-8')
    for (const bad of ['..%2Fconfig', '%2e%2e%2fconfig', '..']) {
      const res = await post(r, `/api/mappings/shows/${bad}/recall`)
      assert.ok(res.status >= 400, `${bad} should be refused, got ${res.status}`)
    }
    assert.equal(fs.readFileSync(r.configFile, 'utf-8'), before)
  } finally { await r.close() }
})

test('saving a show with invalid mappings is refused before it reaches disk', async () => {
  // A show that recall would reject is a trap set for the operator.
  const r = await rig()
  try {
    const res = await post(r, '/api/mappings/shows', {
      name: 'Bad',
      mappings: [{ midi: { type: 'cc', channel: 1, number: 28 }, qsys: { type: 'nonsense' } }],
    })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(Array.isArray(body.details), 'should report per-entry details the page already renders')
    assert.deepEqual((await (await get(r, '/api/mappings/shows')).json()).shows, [])
  } finally { await r.close() }
})

test('recalling a show that is not there is a 404', async () => {
  const r = await rig()
  try {
    assert.equal((await post(r, '/api/mappings/shows/nope/recall')).status, 404)
  } finally { await r.close() }
})

test('every shows route needs a session', async () => {
  const r = await rig()
  try {
    for (const [method, p] of [['GET', '/api/mappings/shows'], ['POST', '/api/mappings/shows/gala/recall']] as const) {
      const res = await fetch(r.base + p, { method })
      assert.equal(res.status, 401, `${method} ${p} should require auth`)
    }
  } finally { await r.close() }
})
