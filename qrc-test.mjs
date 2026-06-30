/**
 * QRC connectivity + component discovery — run with: node qrc-test.mjs
 * Pass --list to dump all component names on the Core.
 */

import net from 'net'

const HOST = '10.4.84.20'
const PORT = 1710
const LIST_ALL = process.argv.includes('--list')

let buffer = ''
let nextId = 1
const pending = new Map()

const socket = net.createConnection(PORT, HOST)

socket.on('connect', () => {
  console.log(`✓ Connected to ${HOST}:${PORT}\n`)
  runTests()
})

socket.on('data', chunk => {
  buffer += chunk.toString('utf-8')
  let idx
  while ((idx = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (!raw.trim()) continue
    try {
      const msg = JSON.parse(raw)
      const id = typeof msg.id === 'string' ? parseInt(msg.id) : msg.id
      const p = pending.get(id)
      if (p) { pending.delete(id); msg.error ? p.reject(new Error(`QRC ${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result) }
    } catch { }
  }
})

socket.on('error', err => { console.error('Socket error:', err.message); process.exit(1) })
socket.on('close', () => process.exit(0))

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\0')
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)) } }, 5000)
  })
}

async function probe(name, control) {
  try {
    const r = await call('Component.Get', { Name: name, Controls: [{ Name: control }] })
    console.log(`  ✓ ${name} → ${control} = ${r.Controls[0].Value}`)
    return true
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`)
    return false
  }
}

async function runTests() {
  try {
    const status = await call('StatusGet', {})
    console.log(`Core: ${status.Platform} — ${status.DesignName} — ${status.State}\n`)

    if (LIST_ALL) {
      console.log('=== All components ===')
      const r = await call('Component.GetComponents', {})
      // Response may be an array directly or wrapped in a Components key
      const list = Array.isArray(r) ? r : (r?.Components ?? Object.values(r)[0] ?? [])
      if (!Array.isArray(list) || list.length === 0) {
        console.log('Raw response:', JSON.stringify(r, null, 2))
      } else {
        for (const c of list) console.log(`  ${c.Name}  (${c.Type})`)
      }
      console.log()
    }

    // Test Input.Mixer read/write
    console.log('--- Input.Mixer write test ---')
    const before = await call('Component.Get', { Name: 'Input.Mixer', Controls: [{ Name: 'input.1.gain' }] })
    const orig = before.Controls[0].Value
    console.log(`  input.1.gain before: ${orig.toFixed(1)} dB`)
    await call('Component.Set', { Name: 'Input.Mixer', Controls: [{ Name: 'input.1.gain', Value: -20.0 }] })
    const after = await call('Component.Get', { Name: 'Input.Mixer', Controls: [{ Name: 'input.1.gain' }] })
    console.log(`  input.1.gain after:  ${after.Controls[0].Value.toFixed(1)} dB`)
    await call('Component.Set', { Name: 'Input.Mixer', Controls: [{ Name: 'input.1.gain', Value: orig }] })
    console.log(`  Restored. Write path: ${Math.abs(after.Controls[0].Value + 20) < 0.1 ? '✓ OK' : '✗ FAILED'}\n`)

    // Probe matrix output candidates
    console.log('--- Matrix output component names ---')
    const candidates = [
      ['Matrix.Mains', 'gain'], ['Matrix.Mains.Gain', 'gain'],
      ['Matrix.ZoomTX', 'gain'], ['Matrix.ZoomTX.Gain', 'gain'],
      ['Matrix.Out', 'output.1.gain'], ['Matrix.Out', 'gain'],
      ['Output.Router', 'output.1.gain'],
    ]
    for (const [name, ctrl] of candidates) await probe(name, ctrl)

    // Probe Bus.Mixer output controls (interim master fader / mute candidates)
    console.log('\n--- Bus.Mixer output controls (interim matrix control) ---')
    const busOutputCandidates = [
      ['Bus.Mixer', 'output.1.gain'],
      ['Bus.Mixer', 'output.1.mute'],
      ['Bus.Mixer', 'output.2.gain'],
      ['Bus.Mixer', 'output.2.mute'],
      ['Bus.Mixer', 'output.3.gain'],
      ['Bus.Mixer', 'output.3.mute'],
    ]
    for (const [name, ctrl] of busOutputCandidates) await probe(name, ctrl)

  } catch (err) {
    console.error('Error:', err.message)
  }
  socket.end()
}
