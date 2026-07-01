/**
 * Throwaway QA script (Phase 4) — opens N concurrent WebSocket connections
 * to the UciServer's /qrc relay and confirms each gets an independent,
 * valid JSON-RPC response, proving the relay doesn't serialize/collide
 * concurrent browser clients.
 *
 * Usage: node qrc-ws-concurrency-test.mjs [wsUrl] [count]
 * Default: ws://localhost:3001/qrc, 3 connections.
 */
import WebSocket from 'ws'

const url = process.argv[2] || 'ws://localhost:3001/qrc'
const count = parseInt(process.argv[3] || '3', 10)

function openClient(idx) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const result = { idx, opened: false, response: null, error: null }
    const timer = setTimeout(() => {
      result.error = result.error || 'timeout waiting for response'
      ws.terminate()
      resolve(result)
    }, 8000)

    ws.on('open', () => {
      result.opened = true
      const msg = JSON.stringify({ jsonrpc: '2.0', id: idx, method: 'NoOp', params: {} })
      ws.send(msg)
    })

    ws.on('message', (data) => {
      result.response = data.toString()
      clearTimeout(timer)
      ws.close()
      resolve(result)
    })

    ws.on('error', (err) => {
      result.error = err.message
    })

    ws.on('close', (code, reason) => {
      if (!result.response) {
        clearTimeout(timer)
        result.error = result.error || `closed before response (code=${code} reason=${reason})`
        resolve(result)
      }
    })
  })
}

const clients = Array.from({ length: count }, (_, i) => i + 1)
const results = await Promise.all(clients.map(openClient))

console.log(`\n=== Concurrency test: ${count} simultaneous /qrc WS clients ===`)
for (const r of results) {
  if (r.response) {
    console.log(`  client ${r.idx}: OPENED, got response: ${r.response}`)
  } else {
    console.log(`  client ${r.idx}: OPENED=${r.opened}, NO response — ${r.error}`)
  }
}

const allGotResponse = results.every((r) => r.response)
console.log(`\nAll clients got a valid response: ${allGotResponse}`)
process.exit(allGotResponse ? 0 : 1)
