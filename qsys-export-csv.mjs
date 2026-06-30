/**
 * qsys-export-csv.mjs — dump every named component + all its controls to CSV
 *
 * Usage:
 *   node qsys-export-csv.mjs                → prints to stdout
 *   node qsys-export-csv.mjs > controls.csv → saves to file
 */

import net from 'net'

const HOST = '10.4.84.20'
const PORT = 1710

let buffer = ''
let nextId = 1
const pending = new Map()
const socket = net.createConnection(PORT, HOST)

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
      if (p) {
        pending.delete(id)
        msg.error ? p.reject(new Error(`QRC ${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result)
      }
    } catch {}
  }
})

socket.on('error', err => { process.stderr.write('Socket error: ' + err.message + '\n'); process.exit(1) })

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\0')
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }
    }, 8000)
  })
}

function csvRow(...fields) {
  return fields.map(s => {
    s = String(s ?? '')
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }).join(',')
}

socket.on('connect', async () => {
  try {
    const r = await call('Component.GetComponents', {})
    const components = Array.isArray(r) ? r
      : (r?.Components ?? Object.values(r)[0] ?? [])

    process.stderr.write(`Found ${components.length} components\n`)

    const lines = []
    lines.push(csvRow('Component', 'Component Type', 'Control Name', 'Value', 'String', 'Position'))

    for (const comp of components) {
      const name = comp.Name
      const type = comp.Type ?? ''
      try {
        const cr = await call('Component.GetControls', { Name: name }) as Record<string, unknown>
        const controls = (cr?.Controls ?? []) as Array<Record<string, unknown>>
        if (controls.length === 0) {
          lines.push(csvRow(name, type, '', '', '', ''))
        } else {
          for (const ctrl of controls) {
            lines.push(csvRow(name, type, ctrl.Name, ctrl.Value, ctrl.String, ctrl.Position))
          }
        }
      } catch {
        // Channel Group or non-addressable component
        lines.push(csvRow(name, type, '(not QRC-addressable)', '', '', ''))
      }
    }

    process.stdout.write(lines.join('\n') + '\n')
    process.stderr.write(`Done — ${lines.length - 1} rows written\n`)
  } catch (e) {
    process.stderr.write('Error: ' + e.message + '\n')
  }
  socket.end()
})

socket.on('close', () => process.exit(0))
