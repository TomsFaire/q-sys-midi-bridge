/**
 * Removing the mappings password.
 *
 * With "no password" now a real mode (everything open), the Configurator needs
 * a way back to it: saving a blank password stays an error so it cannot happen
 * by accident, and an explicit Remove clears the hash. Nothing else in the
 * config may be touched, and the open/locked state must follow immediately.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { clearMappingsPassword } from './mappings-password.js'
import { MappingsHttpHandler } from './mappings-http.js'
import { hashPassword } from './auth.js'

function tmpConfig(content: string): { file: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-pw-'))
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, content)
  return { file, dir }
}

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'))

test('clearing removes the hash and leaves every other setting alone', () => {
  const { file } = tmpConfig(JSON.stringify({
    qsys: { host: '10.0.0.5', port: 1710 },
    mappings: [{ label: 'x' }],
    uci: { enabled: true, port: 3005, mappingsPasswordHash: hashPassword('showtime') },
  }))
  assert.equal(clearMappingsPassword(file), true)
  const cfg = read(file)
  assert.deepEqual(cfg.uci, { enabled: true, port: 3005 })
  assert.equal(cfg.qsys.host, '10.0.0.5')
  assert.deepEqual(cfg.mappings, [{ label: 'x' }])
})

test('clearing when no password is set changes nothing and says so', () => {
  const original = JSON.stringify({ qsys: { host: 'h', port: 1 }, uci: { port: 3001 } })
  const { file } = tmpConfig(original)
  assert.equal(clearMappingsPassword(file), false)
  assert.equal(fs.readFileSync(file, 'utf-8'), original)
})

test('a config with comments still clears', () => {
  const { file } = tmpConfig(`{
    // the show config
    "qsys": { "host": "h", "port": 1 },
    "uci": { "mappingsPasswordHash": "aa:bb" }
  }`)
  assert.equal(clearMappingsPassword(file), true)
  assert.equal(read(file).uci.mappingsPasswordHash, undefined)
})

test('a config that cannot be parsed is not rewritten', () => {
  const { file } = tmpConfig('{ not json')
  assert.throws(() => clearMappingsPassword(file))
  assert.equal(fs.readFileSync(file, 'utf-8'), '{ not json')
})

test('the server goes from locked to open the moment the password is cleared', async () => {
  const { file, dir } = tmpConfig(JSON.stringify({
    qsys: { host: 'h', port: 1 }, midi: { deviceName: 'm' }, mappings: [], feedback: { enabled: true },
    uci: { mappingsPasswordHash: hashPassword('showtime') },
  }))
  const handler = new MappingsHttpHandler(file, path.join(dir, 'x.html'), undefined, path.join(dir, 'shows'))
  const server = http.createServer((req, res) => { if (!handler.handle(req, res)) { res.writeHead(404); res.end() } })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    assert.equal((await fetch(base + '/api/mappings')).status, 401)
    clearMappingsPassword(file)
    assert.equal((await fetch(base + '/api/mappings')).status, 200)
  } finally {
    server.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
