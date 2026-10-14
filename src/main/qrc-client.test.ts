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
    /** Methods this Core answers even before a logon (e.g. StatusGet). */
    ungatedMethods?: string[]
    /** Error this Core returns pre-logon, if not the documented code 10. */
    logonRequiredError?: { code: number; message: string }
    /** Only accept Logon params spelled this way. */
    logonParamStyle?: 'upper' | 'lower'
  } = {},
) {
  const {
    requireLogon = false,
    password = 'secret',
    rejectProbeWith,
    ungatedMethods = [],
    logonRequiredError = { code: 10, message: 'Logon required' },
    logonParamStyle = 'upper',
  } = options
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
          const params = msg.params as Record<string, unknown> | undefined
          const supplied =
            logonParamStyle === 'upper' ? params?.Password : params?.password
          const wrongShape =
            logonParamStyle === 'upper' ? params?.Password === undefined
                                        : params?.password === undefined
          if (wrongShape) {
            reply({ error: { code: -32602, message: 'Invalid params' } })
          } else if (supplied === password) {
            authed = true
            reply({ result: true })
          } else {
            reply({ error: { code: 10, message: 'Invalid credentials' } })
          }
          continue
        }

        if (rejectProbeWith && msg.method === 'Component.Get') {
          reply({ error: rejectProbeWith })
          continue
        }

        if (!authed && ungatedMethods.includes(msg.method)) {
          // Answered before logon, the way a real Core answers StatusGet.
          reply({ result: { ok: true } })
          continue
        }

        if (!authed || lockedDown) {
          reply({ error: logonRequiredError })
          continue
        }

        // Authorised. An unknown component is a complaint about the request,
        // not a refusal to serve it.
        if (msg.method === 'Component.Get') {
          reply({ error: { code: 7, message: 'Unknown component name' } })
          continue
        }
        reply({ result: { ok: true } })
      }
    })
  })

  return {
    seen,
    /** Start refusing calls on an already-open connection. */
    rejectEverything: () => { lockedDown = true },
    /** Send an unsolicited frame, the way AutoPoll pushes arrive. */
    push: (frame: Record<string, unknown>) => {
      for (const socket of sockets) socket.write(`${JSON.stringify(frame)}\0`)
    },
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
  // An open Core engages with the probe, so the connection stands.
  assert.equal(core.seen.includes('Component.Get'), true)

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


test('a Core that answers StatusGet before logon is still detected', async () => {
  // The firmware assumption that worried me most: status is how clients
  // discover a Core, so it may well be served pre-logon. Probing with it
  // would have reported an Access Control Core as wide open.
  const core = fakeCore({ requireLogon: true, ungatedMethods: ['StatusGet'] })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)

  await assert.rejects(() => client.connect(), /logon required/i)
  assert.equal(client.isConnected, false)
  assert.equal(core.seen.includes('StatusGet'), false)

  await client.disconnect()
  await core.close()
})

test('an Access Control Core using a non-standard error code is still detected', async () => {
  // Detection must not hinge on the documented code 10.
  const core = fakeCore({
    requireLogon: true,
    logonRequiredError: { code: 1234, message: 'Not authorized for this operation' },
  })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)

  await assert.rejects(() => client.connect(), /logon required/i)
  assert.equal(client.isConnected, false)

  await client.disconnect()
  await core.close()
})

test('an unknown-component complaint proves the Core authorised us', async () => {
  // An open Core rejects the probe component — that is engagement, not
  // refusal, and must not be mistaken for an authorisation failure.
  const core = fakeCore()
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)

  await client.connect()
  assert.equal(client.isConnected, true)
  assert.equal(client.lastError, null)

  await client.disconnect()
  await core.close()
})

test('Logon retries with lowercase keys when the Core objects to the shape', async () => {
  const core = fakeCore({ requireLogon: true, logonParamStyle: 'lower' })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port, undefined, {
    username: 'admin',
    password: 'secret',
  })

  await client.connect()
  assert.equal(client.isConnected, true)
  // Two Logon attempts: the documented shape, then the fallback.
  assert.equal(core.seen.filter((m) => m === 'Logon').length, 2)

  await client.disconnect()
  await core.close()
})

test('a rejected credential is not retried as a parameter-shape problem', async () => {
  // Only an invalid-params error earns a second attempt; a plain "no" must
  // not send the password twice.
  const core = fakeCore({ requireLogon: true })
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port, undefined, {
    username: 'admin',
    password: 'wrong',
  })

  await assert.rejects(() => client.connect(), /logon failed/i)
  assert.equal(core.seen.filter((m) => m === 'Logon').length, 1)

  await client.disconnect()
  await core.close()
})

test('an AutoPoll push carrying params reaches the notification listeners', async () => {
  // A real Core pushes ChangeGroup.Poll as a JSON-RPC notification: a method
  // and params, no id and no result. Dropping it leaves mute LEDs frozen at
  // whatever the bridge last set itself.
  const core = fakeCore()
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)
  await client.connect()

  const seen: Array<{ id: string; result: unknown }> = []
  client.on('notification', (id: string, result: unknown) => seen.push({ id, result }))

  try {
    core.push({
      jsonrpc: '2.0',
      method: 'ChangeGroup.Poll',
      params: {
        Id: 'mutes',
        Changes: [{ Component: 'Mic.01.Gain', Name: 'mute', Value: 1, String: 'muted' }],
      },
    })
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(seen.length, 1)
    assert.equal(seen[0].id, 'mutes')
    assert.deepEqual(
      (seen[0].result as { Changes: unknown[] }).Changes,
      [{ Component: 'Mic.01.Gain', Name: 'mute', Value: 1, String: 'muted' }],
    )
  } finally {
    await client.disconnect()
    await core.close()
  }
})

test('a push the Core volunteers unprompted is not mistaken for feedback', async () => {
  // EngineStatus arrives the same way as AutoPoll. It carries no Changes, so
  // forwarding it would only make the engine warn.
  const core = fakeCore()
  const port = await core.listen()
  const client = new QrcClient('127.0.0.1', port)
  await client.connect()

  let count = 0
  client.on('notification', () => { count += 1 })

  try {
    core.push({
      jsonrpc: '2.0',
      method: 'EngineStatus',
      params: { State: 'Active', DesignName: 'FOH' },
    })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(count, 0)
  } finally {
    await client.disconnect()
    await core.close()
  }
})
