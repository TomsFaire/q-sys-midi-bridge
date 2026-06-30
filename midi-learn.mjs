/**
 * midi-learn.mjs — Akai MIDImix control discovery
 *
 * Walks every physical control in layout order, captures the real
 * MIDI channel + CC/note for each, then outputs a ready-to-paste
 * config.json mappings block.
 *
 * Usage:
 *   node midi-learn.mjs
 *
 * Controls:
 *   Enter  — accept captured value and advance
 *   r      — retry (clear capture, try again)
 *   s      — skip this control
 *   q      — quit and print results so far
 */

import midi from '@julusian/midi'
import readline from 'readline'

// ── Device layout reference ───────────────────────────────────────────────────
//
//  MIDImix — viewed from front (landscape orientation)
//
//  ┌─────────────────────────────────────────────────────────────┐
//  │  CH:    1     2     3     4     5     6     7     8         │
//  │       [Ka1] [Ka2] [Ka3] [Ka4] [Ka5] [Ka6] [Ka7] [Ka8]     │ ← Knob col A (top)
//  │       [Kb1] [Kb2] [Kb3] [Kb4] [Kb5] [Kb6] [Kb7] [Kb8]     │ ← Knob col B (mid)
//  │       [Kc1] [Kc2] [Kc3] [Kc4] [Kc5] [Kc6] [Kc7] [Kc8]     │ ← Knob col C (bot)
//  │       [RA1] [RA2] [RA3] [RA4] [RA5] [RA6] [RA7] [RA8]     │ ← Rec Arm buttons
//  │       [M1 ] [M2 ] [M3 ] [M4 ] [M5 ] [M6 ] [M7 ] [M8 ]     │ ← Mute buttons
//  │  [F1 ] [F2 ] [F3 ] [F4 ] [F5 ] [F6 ] [F7 ] [F8 ] [MSTR]  │ ← Faders
//  │              [SOLO] [BANK R] [BANK L]      [SEND ALL]       │ ← Bottom buttons
//  └─────────────────────────────────────────────────────────────┘

// ── MIDI setup ────────────────────────────────────────────────────────────────

const midiIn = new midi.Input()
midiIn.ignoreTypes(false, false, false)

const portCount = midiIn.getPortCount()
if (portCount === 0) {
  console.error('No MIDI ports found. Plug in the MIDImix and try again.')
  process.exit(1)
}

let portIdx = null
for (let i = 0; i < portCount; i++) {
  if (midiIn.getPortName(i).includes('MIDI Mix') && portIdx === null) portIdx = i
}

if (portIdx === null) {
  console.error('MIDI Mix not found. Available ports:')
  for (let i = 0; i < portCount; i++) console.error(`  ${i}: ${midiIn.getPortName(i)}`)
  process.exit(1)
}

midiIn.openPort(portIdx)

// ── Control definitions ───────────────────────────────────────────────────────

const CONTROLS = [
  // Knob column A — top row, left to right
  { id: 'Ka1', label: 'Knob A — Ch 1 (top-left knob)',     type: 'knob',   group: 'knob_a' },
  { id: 'Ka2', label: 'Knob A — Ch 2',                      type: 'knob',   group: 'knob_a' },
  { id: 'Ka3', label: 'Knob A — Ch 3',                      type: 'knob',   group: 'knob_a' },
  { id: 'Ka4', label: 'Knob A — Ch 4',                      type: 'knob',   group: 'knob_a' },
  { id: 'Ka5', label: 'Knob A — Ch 5',                      type: 'knob',   group: 'knob_a' },
  { id: 'Ka6', label: 'Knob A — Ch 6',                      type: 'knob',   group: 'knob_a' },
  { id: 'Ka7', label: 'Knob A — Ch 7',                      type: 'knob',   group: 'knob_a' },
  { id: 'Ka8', label: 'Knob A — Ch 8 (top-right knob)',     type: 'knob',   group: 'knob_a' },

  // Knob column B — middle row
  { id: 'Kb1', label: 'Knob B — Ch 1 (middle-left knob)',  type: 'knob',   group: 'knob_b' },
  { id: 'Kb2', label: 'Knob B — Ch 2',                      type: 'knob',   group: 'knob_b' },
  { id: 'Kb3', label: 'Knob B — Ch 3',                      type: 'knob',   group: 'knob_b' },
  { id: 'Kb4', label: 'Knob B — Ch 4',                      type: 'knob',   group: 'knob_b' },
  { id: 'Kb5', label: 'Knob B — Ch 5',                      type: 'knob',   group: 'knob_b' },
  { id: 'Kb6', label: 'Knob B — Ch 6',                      type: 'knob',   group: 'knob_b' },
  { id: 'Kb7', label: 'Knob B — Ch 7',                      type: 'knob',   group: 'knob_b' },
  { id: 'Kb8', label: 'Knob B — Ch 8',                      type: 'knob',   group: 'knob_b' },

  // Knob column C — bottom row of knobs
  { id: 'Kc1', label: 'Knob C — Ch 1 (bottom-left knob)', type: 'knob',   group: 'knob_c' },
  { id: 'Kc2', label: 'Knob C — Ch 2',                      type: 'knob',   group: 'knob_c' },
  { id: 'Kc3', label: 'Knob C — Ch 3',                      type: 'knob',   group: 'knob_c' },
  { id: 'Kc4', label: 'Knob C — Ch 4',                      type: 'knob',   group: 'knob_c' },
  { id: 'Kc5', label: 'Knob C — Ch 5',                      type: 'knob',   group: 'knob_c' },
  { id: 'Kc6', label: 'Knob C — Ch 6',                      type: 'knob',   group: 'knob_c' },
  { id: 'Kc7', label: 'Knob C — Ch 7',                      type: 'knob',   group: 'knob_c' },
  { id: 'Kc8', label: 'Knob C — Ch 8',                      type: 'knob',   group: 'knob_c' },

  // Rec Arm buttons (top button per channel)
  { id: 'RA1', label: 'Rec Arm — Ch 1',                     type: 'button', group: 'rec_arm' },
  { id: 'RA2', label: 'Rec Arm — Ch 2',                     type: 'button', group: 'rec_arm' },
  { id: 'RA3', label: 'Rec Arm — Ch 3',                     type: 'button', group: 'rec_arm' },
  { id: 'RA4', label: 'Rec Arm — Ch 4',                     type: 'button', group: 'rec_arm' },
  { id: 'RA5', label: 'Rec Arm — Ch 5',                     type: 'button', group: 'rec_arm' },
  { id: 'RA6', label: 'Rec Arm — Ch 6',                     type: 'button', group: 'rec_arm' },
  { id: 'RA7', label: 'Rec Arm — Ch 7',                     type: 'button', group: 'rec_arm' },
  { id: 'RA8', label: 'Rec Arm — Ch 8',                     type: 'button', group: 'rec_arm' },

  // Mute buttons (bottom button per channel)
  { id: 'M1',  label: 'Mute — Ch 1',                        type: 'button', group: 'mute' },
  { id: 'M2',  label: 'Mute — Ch 2',                        type: 'button', group: 'mute' },
  { id: 'M3',  label: 'Mute — Ch 3',                        type: 'button', group: 'mute' },
  { id: 'M4',  label: 'Mute — Ch 4',                        type: 'button', group: 'mute' },
  { id: 'M5',  label: 'Mute — Ch 5',                        type: 'button', group: 'mute' },
  { id: 'M6',  label: 'Mute — Ch 6',                        type: 'button', group: 'mute' },
  { id: 'M7',  label: 'Mute — Ch 7',                        type: 'button', group: 'mute' },
  { id: 'M8',  label: 'Mute — Ch 8',                        type: 'button', group: 'mute' },

  // Channel faders
  { id: 'F1',  label: 'Fader — Ch 1 (leftmost)',            type: 'fader',  group: 'fader' },
  { id: 'F2',  label: 'Fader — Ch 2',                       type: 'fader',  group: 'fader' },
  { id: 'F3',  label: 'Fader — Ch 3',                       type: 'fader',  group: 'fader' },
  { id: 'F4',  label: 'Fader — Ch 4',                       type: 'fader',  group: 'fader' },
  { id: 'F5',  label: 'Fader — Ch 5',                       type: 'fader',  group: 'fader' },
  { id: 'F6',  label: 'Fader — Ch 6',                       type: 'fader',  group: 'fader' },
  { id: 'F7',  label: 'Fader — Ch 7',                       type: 'fader',  group: 'fader' },
  { id: 'F8',  label: 'Fader — Ch 8',                       type: 'fader',  group: 'fader' },
  { id: 'FM',  label: 'Master fader (rightmost, taller)',   type: 'fader',  group: 'fader' },

  // Bottom buttons
  { id: 'SOLO',     label: 'SOLO button (bottom row)',       type: 'button', group: 'bottom' },
  { id: 'BANKR',    label: 'BANK RIGHT button',              type: 'button', group: 'bottom' },
  { id: 'BANKL',    label: 'BANK LEFT button',               type: 'button', group: 'bottom' },
  { id: 'SENDALL',  label: 'SEND ALL button',                type: 'button', group: 'bottom' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const ask = (q) => new Promise(resolve => rl.question(q, resolve))

function instructions(type) {
  if (type === 'button') return 'Press it ONCE, then press Enter'
  return 'Slowly turn/move full range (min → max → min), then press Enter'
}

function sectionHeader(group) {
  const headers = {
    knob_a:  '── Knob column A (top row of knobs) ─────────────────────────',
    knob_b:  '── Knob column B (middle row of knobs) ──────────────────────',
    knob_c:  '── Knob column C (bottom row of knobs) ──────────────────────',
    rec_arm: '── REC ARM buttons (top button per channel strip) ────────────',
    mute:    '── MUTE buttons (bottom button per channel strip) ────────────',
    fader:   '── Faders ────────────────────────────────────────────────────',
    bottom:  '── Bottom buttons ────────────────────────────────────────────',
  }
  return headers[group] ?? ''
}

function startCapture() {
  const counts = new Map()
  const handler = (_delta, msg) => {
    if (msg.length < 2) return
    const status = msg[0]
    const type = status & 0xf0
    const ch = (status & 0x0f) + 1
    const num = msg[1]
    const val = msg[2] ?? 0
    if (type === 0xb0) {
      counts.set(`cc:${ch}:${num}`, (counts.get(`cc:${ch}:${num}`) ?? 0) + 1)
    } else if (type === 0x90 && val > 0) {
      counts.set(`note:${ch}:${num}`, (counts.get(`note:${ch}:${num}`) ?? 0) + 1)
    }
  }
  midiIn.on('message', handler)
  return { counts, handler }
}

function stopCapture({ counts, handler }) {
  midiIn.removeListener('message', handler)
  if (counts.size === 0) return null
  let best = null, bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; best = key }
  }
  if (!best) return null
  const [type, ch, num] = best.split(':')
  return { type, channel: parseInt(ch), number: parseInt(num), eventCount: bestCount }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.clear()
console.log(`
╔══════════════════════════════════════════════════════════════╗
║            Akai MIDImix — Control Discovery                  ║
╠══════════════════════════════════════════════════════════════╣
║  Layout reference (landscape orientation):                   ║
║                                                              ║
║  [Ka][Ka][Ka][Ka][Ka][Ka][Ka][Ka]  ← Knob row A (top)       ║
║  [Kb][Kb][Kb][Kb][Kb][Kb][Kb][Kb]  ← Knob row B (middle)   ║
║  [Kc][Kc][Kc][Kc][Kc][Kc][Kc][Kc]  ← Knob row C (bottom)  ║
║  [RA][RA][RA][RA][RA][RA][RA][RA]  ← Rec Arm buttons        ║
║  [M ][M ][M ][M ][M ][M ][M ][M ]  ← Mute buttons           ║
║  [F1][F2][F3][F4][F5][F6][F7][F8][FM] ← Faders + Master     ║
║       [SOLO] [BANK R] [BANK L] [SEND ALL]  ← Bottom row     ║
║                                                              ║
║  Connected: ${midiIn.getPortName(portIdx).padEnd(48)}║
╠══════════════════════════════════════════════════════════════╣
║  Enter  accept   r  retry   s  skip   q  quit & save         ║
╚══════════════════════════════════════════════════════════════╝
`)

await ask('Press Enter to begin...')
console.log()

const results = []
let lastGroup = null

for (const control of CONTROLS) {
  if (control.group !== lastGroup) {
    console.log('\n' + sectionHeader(control.group))
    lastGroup = control.group
  }

  let captured = null
  let retrying = false

  while (true) {
    if (!retrying) {
      console.log(`\n  ${control.label}`)
      console.log(`  ${instructions(control.type)}`)
    } else {
      console.log(`  Cleared — try again: ${control.label}`)
    }

    const capture = startCapture()
    const answer = await ask('  → ')
    captured = stopCapture(capture)

    const cmd = answer.trim().toLowerCase()

    if (cmd === 'q') {
      console.log('\n  Quitting early — saving results so far.\n')
      results.push({ ...control, skipped: true })
      goto_output = true
      break
    }
    if (cmd === 's') {
      console.log('  Skipped.')
      results.push({ ...control, skipped: true })
      break
    }
    if (cmd === 'r') {
      retrying = true
      continue
    }

    if (!captured) {
      console.log('  ⚠ No MIDI received — try again (or press s to skip).')
      retrying = true
      continue
    }

    const emoji = captured.type === 'note' ? '🎹' : '🎛 '
    console.log(`  ✓ ${emoji} ${captured.type.toUpperCase()} ch=${captured.channel} num=${captured.number} (${captured.eventCount} events)`)
    results.push({ ...control, ...captured })
    break
  }

  if (typeof goto_output !== 'undefined') break
}

rl.close()
midiIn.closePort()

// ── Results table ─────────────────────────────────────────────────────────────

console.log('\n\n' + '═'.repeat(62))
console.log('  DISCOVERED MIDI MAP')
console.log('═'.repeat(62))
console.log('  ID       Label                        Type   Ch  Num')
console.log('  ' + '─'.repeat(58))
for (const r of results) {
  if (r.skipped) {
    console.log(`  ${r.id.padEnd(8)} ${r.label.substring(0,28).padEnd(29)} SKIPPED`)
  } else {
    const t = r.type.toUpperCase().padEnd(6)
    console.log(`  ${r.id.padEnd(8)} ${r.label.substring(0,28).padEnd(29)} ${t} ${String(r.channel).padEnd(3)} ${r.number}`)
  }
}

// ── Config snippet ────────────────────────────────────────────────────────────

console.log('\n\n' + '═'.repeat(62))
console.log('  CONFIG.JSON MAPPINGS SNIPPET')
console.log('  (copy into the mappings[] array)')
console.log('═'.repeat(62) + '\n')

const byId = Object.fromEntries(results.map(r => [r.id, r]))

function cc(id, label, component, control, min, max) {
  const r = byId[id]
  if (!r || r.skipped) return `    // ${label}: not captured`
  return `    { "label": "${label}", "midi": {"type":"cc","channel":${r.channel},"number":${r.number}},\n      "qsys": {"type":"component_control","component":"${component}","control":"${control}","min":${min},"max":${max}} },`
}

function toggle(id, label, component, control) {
  const r = byId[id]
  if (!r || r.skipped) return `    // ${label}: not captured`
  return `    { "label": "${label}", "midi": {"type":"${r.type}","channel":${r.channel},"number":${r.number}},\n      "qsys": {"type":"toggle","component":"${component}","control":"${control}"} },`
}

function commented(id, label, component, control, min, max, note) {
  const r = byId[id]
  if (!r || r.skipped) return `    // ${label}: not captured`
  return `    // ${note}\n    // { "label": "${label}", "midi": {"type":"cc","channel":${r.channel},"number":${r.number}},\n    //   "qsys": {"type":"component_control","component":"${component}","control":"${control}","min":${min},"max":${max}} },`
}

const lines = [
  '    // ── Channel faders ─────────────────────────────────────────────',
  cc('F1','Mic 1 Fader','Input.Mixer','input.1.gain',-100,10),
  cc('F2','Mic 2 Fader','Input.Mixer','input.2.gain',-100,10),
  cc('F3','Mic 3 Fader','Input.Mixer','input.3.gain',-100,10),
  cc('F4','Mic 4 Fader','Input.Mixer','input.4.gain',-100,10),
  cc('F5','Mic 5 Fader','Input.Mixer','input.5.gain',-100,10),
  cc('F6','Mic 6 Fader','Input.Mixer','input.6.gain',-100,10),
  cc('F7','Mic 7 Fader','Input.Mixer','input.7.gain',-100,10),
  cc('F8','Mic 8 Fader','Input.Mixer','input.8.gain',-100,10),
  '',
  '    // ── Master fader ────────────────────────────────────────────────',
  cc('FM','Mains Master','Bus.Mixer','output.1.gain',-100,10),
  '',
  '    // ── Mute buttons (toggle) ───────────────────────────────────────',
  toggle('M1','Mic 1 Mute','Input.Mixer','input.1.mute'),
  toggle('M2','Mic 2 Mute','Input.Mixer','input.2.mute'),
  toggle('M3','Mic 3 Mute','Input.Mixer','input.3.mute'),
  toggle('M4','Mic 4 Mute','Input.Mixer','input.4.mute'),
  toggle('M5','Mic 5 Mute','Input.Mixer','input.5.mute'),
  toggle('M6','Mic 6 Mute','Input.Mixer','input.6.mute'),
  toggle('M7','Mic 7 Mute','Input.Mixer','input.7.mute'),
  toggle('M8','Mic 8 Mute','Input.Mixer','input.8.mute'),
  '',
  '    // ── Bank buttons (toggle) ───────────────────────────────────────',
  toggle('BANKL','Mains Mute','Bus.Mixer','output.1.mute'),
  toggle('BANKR','ZoomTX Mute','Bus.Mixer','output.2.mute'),
  '',
  '    // ── Rec Arm buttons — unassigned (toggle candidates) ───────────',
  ...['RA1','RA2','RA3','RA4','RA5','RA6','RA7','RA8'].map((id,i) => {
    const r = byId[id]; if (!r || r.skipped) return `    // Rec Arm Ch${i+1}: not captured`
    return `    // Rec Arm Ch${i+1}: ${r.type} ch=${r.channel} num=${r.number} — unassigned`
  }),
  '',
  '    // ── Solo + Send All — unassigned ────────────────────────────────',
  ...['SOLO','SENDALL'].map(id => {
    const r = byId[id]; if (!r || r.skipped) return `    // ${id}: not captured`
    return `    // ${id}: ${r.type} ch=${r.channel} num=${r.number} — unassigned`
  }),
  '',
  '    // ── Knob A — BLOCKED until Designer rebuild (Mic.0n.Gain) ──────',
  ...['Ka1','Ka2','Ka3','Ka4','Ka5','Ka6','Ka7','Ka8'].map((id,i) =>
    commented(id,`Mic ${i+1} Trim (Knob A Ch${i+1})`,`Mic.0${i+1}.Gain`,'gain',-18,18,'Needs Designer rebuild')
  ),
  '',
  '    // ── Knob B — BLOCKED until Designer rebuild (Mic.0n.HPF) ───────',
  ...['Kb1','Kb2','Kb3','Kb4','Kb5','Kb6','Kb7','Kb8'].map((id,i) =>
    commented(id,`Mic ${i+1} HPF (Knob B Ch${i+1})`,`Mic.0${i+1}.HPF`,'frequency',80,300,'Needs Designer rebuild')
  ),
  '',
  '    // ── Knob C — BLOCKED until Designer rebuild (compressor) ────────',
  ...['Kc1','Kc2','Kc3','Kc4','Kc5','Kc6','Kc7','Kc8'].map((id,i) => {
    const r = byId[id]; if (!r || r.skipped) return `    // Knob C Ch${i+1}: not captured`
    return `    // Knob C Ch${i+1}: ${r.type} ch=${r.channel} num=${r.number} — unassigned (post-rebuild: compressor/gate)`
  }),
]

console.log(lines.join('\n'))
console.log('\n' + '═'.repeat(62))
console.log('  Done. Paste the snippet above into config.json mappings[].')
console.log('  Uncomment Knob A/B entries after the Q-SYS Designer rebuild.')
console.log('═'.repeat(62) + '\n')
