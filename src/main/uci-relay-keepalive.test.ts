/**
 * UCI relay keepalive.
 *
 * A Q-SYS Core closes any QRC session that sends nothing for 120 s. The relay
 * gives each browser tab its own TCP session to the Core, and a tab left idle
 * (an iPad on the wall) sends nothing, so the Core dropped it every two
 * minutes — "Remote Control closed - TIMEOUT" — and the page reconnected 2 s
 * later with a fresh Logon, hundreds of times a day.
 *
 * The relay now sends its own NoOp on each tab's behalf. These tests run the
 * real UciServer between a real WebSocket client and a fake Core, with the
 * interval shortened so they take milliseconds instead of minutes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Module from 'node:module'
import net from 'node:net'
import { WebSocket } from 'ws'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const REPO_ROOT = path.join(__dirname, '..', '..')
const KEEPALIVE_MS = 40
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function loadUciServer(): Any {
  const M = Module as Any
  const realLoad = M._load
  M._load = function (request: string, ...rest: unknown[]) {
    if (request === 'electron') return { app: { getAppPath: () => REPO_ROOT } }
    return realLoad.call(this, request, ...rest)
  }
  try {
    return require('./uci-server.js')
  } finally {
    M._load = realLoad
  }
}

interface Rig {
  /** Every JSON-RPC message the Core has received. */
  coreSaw: Any[]
  /** Every message the browser has received. */
  browserSaw: Any[]
  ws: WebSocket
  open: Promise<void>
  teardown: () => Promise<void>
}

/** UciServer → fake Core, with a WebSocket "browser" attached to the relay. */
async function startRig(): Promise<Rig> {
  const coreSaw: Any[] = []
  const coreSockets = new Set<net.Socket>()
  // A Core that answers every call with `result: true`, as it does for NoOp.
  const core = net.createServer((sock) => {
    coreSockets.add(sock)
    let buf = ''
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      let i: number
      while ((i = buf.indexOf('\0')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i))
        buf = buf.slice(i + 1)
        coreSaw.push(msg)
        sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: true }) + '\0')
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => coreSockets.delete(sock))
  })
  await new Promise<void>((r) => core.listen(0, '127.0.0.1', r))
  const corePort = (core.address() as net.AddressInfo).port

  const { UciServer } = loadUciServer()
  const server = new UciServer()
  server.keepAliveMs = KEEPALIVE_MS
  const listening = new Promise<void>((r) => server.once('listening', () => r()))
  server.start('127.0.0.1', 0, '127.0.0.1', corePort)
  await listening
  const uciPort = (server as Any).server.address().port as number

  const browserSaw: Any[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${uciPort}/qrc`)
  ws.on('message', (data) => browserSaw.push(JSON.parse(data.toString())))
  const open = new Promise<void>((r) => ws.once('open', () => r()))

  return {
    coreSaw, browserSaw, ws, open,
    teardown: async () => {
      ws.terminate()
      server.stop()
      for (const s of coreSockets) s.destroy()
      await new Promise<void>((r) => core.close(() => r()))
    },
  }
}

const keepAlives = (msgs: Any[]) => msgs.filter((m) => m.method === 'NoOp')

test('an idle tab keeps its Core session alive with NoOps', async () => {
  const rig = await startRig()
  try {
    await rig.open
    // The browser says nothing at all — this is the wall-mounted iPad.
    await sleep(KEEPALIVE_MS * 5)
    assert.ok(
      keepAlives(rig.coreSaw).length >= 3,
      `the Core should see regular NoOps from an idle tab, saw ${rig.coreSaw.length} message(s)`,
    )
  } finally { await rig.teardown() }
})

test('the keepalive reply never reaches the browser', async () => {
  const rig = await startRig()
  try {
    await rig.open
    await sleep(KEEPALIVE_MS * 4)
    assert.ok(keepAlives(rig.coreSaw).length >= 2, 'precondition: the Core was pinged')
    assert.deepEqual(rig.browserSaw, [], 'the page must not see replies it never asked for')
  } finally { await rig.teardown() }
})

test("the browser's own calls still get their replies alongside the keepalive", async () => {
  const rig = await startRig()
  try {
    await rig.open
    rig.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'StatusGet', params: 0 }))
    await sleep(KEEPALIVE_MS * 4)
    assert.deepEqual(rig.browserSaw, [{ jsonrpc: '2.0', id: 7, result: true }])
  } finally { await rig.teardown() }
})

test('the keepalive stops when the tab goes away', async () => {
  const rig = await startRig()
  try {
    await rig.open
    await sleep(KEEPALIVE_MS * 3)
    rig.ws.close()
    // Let the relay tear its TCP session down, then see whether pings continue
    // on it. (The Core only tracks messages, so a leaked timer shows up as
    // NoOps arriving after the close.)
    await sleep(KEEPALIVE_MS)
    const before = keepAlives(rig.coreSaw).length
    await sleep(KEEPALIVE_MS * 4)
    assert.equal(keepAlives(rig.coreSaw).length, before, 'no NoOps after the tab closed')
  } finally { await rig.teardown() }
})
