/**
 * GET /shared/<file> — the UCI server's route for assets/shared/, which the
 * browser mappings page loads the shared editor script and stylesheet from.
 *
 * Starts the real UciServer on an OS-assigned port and talks to it with
 * fetch. uci-server.ts imports `electron` only for app.getAppPath(), so the
 * module is loaded with a stub that points at the repo root.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import Module from 'node:module'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

const REPO_ROOT = path.join(__dirname, '..', '..')

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

async function startServer(): Promise<{ port: number; stop: () => void }> {
  const { UciServer } = loadUciServer()
  const server = new UciServer()
  const listening = new Promise<{ port: number }>((resolve) => server.once('listening', resolve))
  // Port 0: the OS picks a free one. The Core address is never dialled — no
  // test here opens /qrc.
  server.start('127.0.0.1', 0, '127.0.0.1', 1)
  await listening
  const port = (server as Any).server.address().port as number
  return { port, stop: () => server.stop() }
}

test('the UCI server serves the shared editor script', async () => {
  const { port, stop } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shared/mapping-editor.js`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /javascript/)
    assert.match(await res.text(), /MappingEditor/)
  } finally { stop() }
})

test('the UCI server serves the shared editor stylesheet', async () => {
  const { port, stop } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shared/mapping-editor.css`)
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/css/)
  } finally { stop() }
})

test('the shared route refuses path traversal', async () => {
  const { port, stop } = await startServer()
  try {
    // Encoded so fetch does not normalise the .. away before it reaches us.
    const res = await fetch(`http://127.0.0.1:${port}/shared/%2E%2E%2F%2E%2E%2Fpackage.json`)
    assert.equal(res.status, 404)
    assert.doesNotMatch(await res.text(), /"name"/)
  } finally { stop() }
})

test('the shared route 404s for a file that does not exist', async () => {
  const { port, stop } = await startServer()
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shared/nope.js`)
    assert.equal(res.status, 404)
  } finally { stop() }
})
