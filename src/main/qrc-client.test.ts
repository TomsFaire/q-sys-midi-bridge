import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { QrcClient } from './qrc-client.js'

/**
 * Minimal stand-in for a Q-SYS Core speaking null-terminated JSON-RPC.
 *
 * With `requireLogon` it mimics a Core that has Access Control enabled:
 * every call except Logon is rejected with code 10 until a Logon succeeds.
 * `rejectProbeWith` mimics a Core that dislikes a particular method for
 * reasons that have nothing to do with authorisation.
 */
function fakeCore(
  options: {
    requireLogon?: boolean
    password?: string
    port?: number
    rejectProbeWith?: { code: number; message: string }
  } = {},
) {
  const { requireLogon = false, password = 'secret', rejectProbeWith } = options
  const seen: string[] = []
  const sockets = new Set<Socket>()
  // Flipped by rejectEverything() to mimic Access Control being switched on
  // underneath a live connection.
  let lockedDown = false

  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => { /* torn down by the test */ })

    let authed = !requireLogon
    let buf = ''

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      let i: number
      while ((i = buf.indexOf('\0')) !== -1) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!raw.trim()) continue

        const msg = JSON.parse(raw) as {
          id: number
          method: string
          params?: { User?: string; Password?: string }
        }
        seen.push(msg.method)

        const reply = (body: Record<string, unknown>) =>
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body })}\0`)

        if (msg.method === 'Logon') {
          if (msg.params?.Password === password) {
            authed = true
            reply({ result: true })
          } else {
            reply({ error: { code: 10, message: 'Invalid credentials' } })
          }
          continue
        }

        if (rejectProbeWith && msg.method === 'StatusGet') {
          reply({ error: rejectProbeWith })
          continue
        }

        reply(
          authed && !lockedDown
            ? { result: { ok: true } }
            : { error: { code: 10, message: 'Logon required' } },
        )
      }
    })
  })

  return {
    seen,
    /** Start refusing calls on an already-open connection. */
    rejectEverything: () => { lockedDown = true },
    /** Drop live connections without closing the listener. */
    drop: async () => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
    },
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(options.port ?? 0, '127.0.0.1', () => {
          resolve((server.address() as { port: number }).port)
        })
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

test('connects without a logon when no credentials are configured', async () => {
  const core = fakeCore()
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)

  await client.connect()
  assert.equal(client.isConnected, true)
  assert.equal(client.lastError, null)
  assert.equal(core.seen.includes('Logon'), false)
  // An open Core answers the probe, so the connection stands.
  assert.equal(core.seen.includes('StatusGet'), true)

  await client.disconnect()
  await core.close()
})

test('Access Control with no credentials fails the connect instead of looking healthy', async () => {
  // The case the tray used to report as "● Connected": the socket opens, the
  // Core accepts it, and then refuses every call.
  const core = fakeCore({ requireLogon: true })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)

  await assert.rejects(() => client.connect(), /logon required/i)
  assert.equal(client.isConnected, false)
  assert.match(String(client.lastError), /set qsys\.username\/password/i)

  await client.disconnect()
  await core.close()
})

test('a non-auth probe failure does not block the connection', async () => {
  // Old firmware that dislikes StatusGet must not be treated as locked down.
  const core = fakeCore({ rejectProbeWith: { code: 7, message: 'Unknown method' } })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)

  await client.connect()
  assert.equal(client.isConnected, true)
  assert.equal(client.lastError, null)

  await client.disconnect()
  await core.close()
})

test('lastError is cleared by a plain disconnect, not left to mislead', async () => {
  const core = fakeCore({ requireLogon: true })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port, undefined, {
    username: 'admin',
    password: 'secret',
  })

  await client.connect()
  // Core-side Access Control change: calls start coming back rejected while
  // the socket is still up.
  core.rejectEverything()
  await client.call('Component.Set').catch(() => {})
  assert.match(String(client.lastError), /logon rejected/i)

  // A subsequent network drop is not an auth problem and must not inherit
  // the auth message.
  await core.drop()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(client.lastError, null)

  await client.disconnect()
  await core.close()
})

test('logs on before any other call when the Core requires it', async () => {
  const core = fakeCore({ requireLogon: true })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port, undefined, {
    username: 'admin',
    password: 'secret',
  })

  await client.connect()
  assert.equal(client.isConnected, true)
  // Logon has to be the very first thing on the wire, or the Core rejects
  // everything that follows.
  assert.equal(core.seen[0], 'Logon')

  const result = await client.call('StatusGet')
  assert.deepEqual(result, { ok: true })

  await client.disconnect()
  await core.close()
})

test('rejected credentials surface as an auth error, not a network fault', async () => {
  const core = fakeCore({ requireLogon: true })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port, undefined, {
    username: 'admin',
    password: 'wrong',
  })

  let authErrorEmitted: string | null = null
  client.on('auth-error', (msg: string) => { authErrorEmitted = msg })

  await assert.rejects(() => client.connect(), /logon failed/i)
  assert.equal(client.isConnected, false)
  assert.match(String(client.lastError), /logon failed/i)
  assert.notEqual(authErrorEmitted, null)

  await client.disconnect()
  await core.close()
})

test('a failed initial connect still schedules a retry', async () => {
  // Reserve a port and immediately release it, so the first attempt is
  // guaranteed to fail against a port nothing is listening on.
  const probe = createServer()
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port))
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))

  const client = new QrcClient('127.0.0.1', port, 500)
  await assert.rejects(() => client.connect())
  assert.equal(client.isConnected, false)

  // Bring a Core up on that same port. Before this fix the client had no
  // pending timer at all and would never have noticed.
  const core = fakeCore({ port })
  await core.listen()

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no retry was scheduled')), 8000)
    client.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  assert.equal(client.isConnected, true)
  await client.disconnect()
  await core.close()
})
