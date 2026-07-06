# Configurable UCI Port + Browser-Based MIDI Mappings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the UCI web server's port be set from the Configurator UI (for firewall planning), and make the MIDI-to-Q-Sys mapping table manageable from any browser on the LAN, password-protected.

**Architecture:** Extract the mapping data/read/write/discovery logic that today lives only inside the desktop Configurator's IPC handlers into a shared `mapping-service.ts` module. A new password + session-cookie layer (`auth.ts`) gates a new set of HTTP routes (`mappings-http.ts`) mounted into the existing `UciServer`, serving a new static browser page (`assets/mappings/mappings.html`) that mirrors the desktop Configurator's table UI over `fetch` instead of Electron IPC. The UCI port itself gets a plain editable field + restart flow in the existing Configurator Network panel — no new infrastructure needed there.

**Tech Stack:** TypeScript, Electron (main process only — no renderer framework), Node's built-in `http`/`crypto`/`node:test` modules. No new npm dependencies.

## Global Constraints

- No new npm dependencies — use only Node/Electron built-ins (`node:crypto` for password hashing, `node:test` for unit tests).
- This project has no existing automated test suite for HTTP/Electron integration — only pure logic (validation, hashing, session expiry) gets unit tests; everything that needs a live Q-Sys Core, a live Electron app, or a live HTTP server gets a manual test added to `TESTING-PLAN.md`, matching the project's existing convention (see `TESTING-PLAN.md`).
- Port values: integer `1–65535`.
- Session TTL for the mappings page: 24 hours.
- Config file is JSONC (comments + trailing commas allowed) — always read/write it through `stripComments()` from `src/main/config.ts`, never `JSON.parse` directly on the raw file.
- Follow the existing code style: no semicolons are used inconsistently in this codebase (mixed), match whatever the file you're editing already does line-by-line — when in doubt, match `src/main/configurator.ts`'s style (no trailing semicolons on statements, `const`/single quotes).

---

### Task 1: Configurable UCI port in the Configurator

**Files:**
- Modify: `src/main/config.ts`
- Create: `src/main/config.test.ts`
- Modify: `src/main/configurator.ts`
- Modify: `src/renderer/configurator.html`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `TESTING-PLAN.md`

**Interfaces:**
- Produces: `isValidPort(value: unknown): value is number` exported from `src/main/config.ts`, reused by later tasks' validation code if needed.
- Produces IPC channels: `cfg:set-uci-port` (payload: `number`, throws on invalid), `cfg:restart-app` (no payload).

- [ ] **Step 1: Add the test runner script**

Modify `package.json` — add a `test` script (uses only Node's built-in test runner, no new dependency):

```json
  "scripts": {
    "start": "npm run build && electron .",
    "build": "tsc",
    "watch": "tsc --watch",
    "test": "npm run build && node --test dist/main",
    "rebuild-midi": "electron-rebuild -f -w @julusian/midi",
    "sync-uci": "node -e \"const fs=require('fs'),p=require('path');const root=process.cwd();const src=process.env.FOH_UCI_SRC||p.join(root,'../../Q-SYS/General/foh-uci.html');const dest=p.join(root,'assets/uci/foh-uci.html');fs.mkdirSync(p.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);console.log('Synced UCI from '+src+' -> '+dest)\"",
    "package": "npm run build && electron-builder --mac --publish never"
  },
```

- [ ] **Step 2: Write the failing test for `isValidPort`**

Create `src/main/config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isValidPort } from './config.js'

test('isValidPort accepts valid ports', () => {
  assert.equal(isValidPort(1), true)
  assert.equal(isValidPort(3001), true)
  assert.equal(isValidPort(65535), true)
})

test('isValidPort rejects out-of-range and non-integer values', () => {
  assert.equal(isValidPort(0), false)
  assert.equal(isValidPort(65536), false)
  assert.equal(isValidPort(-1), false)
  assert.equal(isValidPort(3001.5), false)
})

test('isValidPort rejects non-number types', () => {
  assert.equal(isValidPort('3001'), false)
  assert.equal(isValidPort(null), false)
  assert.equal(isValidPort(undefined), false)
})
```

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npm test`
Expected: build fails (or test fails) with `isValidPort is not a function` / `isValidPort is not exported` — `isValidPort` doesn't exist yet in `config.ts`.

- [ ] **Step 4: Implement `isValidPort`**

In `src/main/config.ts`, add this exported function right after the `Config` interface (after line 46, before `function stripComments`):

```ts
export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}
```

- [ ] **Step 5: Run the test and confirm it passes**

Run: `npm test`
Expected: all `config.test.ts` cases PASS.

- [ ] **Step 6: Add the IPC handlers**

In `src/main/configurator.ts`, change the import on line 13 from:

```ts
import { stripComments } from './config.js'
```

to:

```ts
import { isValidPort, stripComments } from './config.js'
```

Then, inside `registerIpc()`, immediately after the existing `cfg:set-uci-enabled` handler (after the closing `})` that currently ends the file's `registerIpc` block, i.e. right before the final `}` that closes `registerIpc()`), add:

```ts

    // ── Set the UCI web server port (restart required to apply) ────────────
    ipcMain.handle('cfg:set-uci-port', (_event, port: number) => {
      if (!isValidPort(port)) {
        throw new Error('Port must be a whole number between 1 and 65535')
      }
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      uci.port = port
      config.uci = uci
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
    })

    // ── Relaunch the app (used after a port change) ─────────────────────────
    ipcMain.handle('cfg:restart-app', () => {
      app.relaunch()
      app.exit(0)
    })
```

- [ ] **Step 7: Add the Network panel UI**

In `src/renderer/configurator.html`, replace the "UCI Server" row (currently):

```html
    <div class="net-row">
      <span class="net-label">UCI Server</span>
      <label class="switch-label">
        <input type="checkbox" id="uci-enabled-toggle">
        Enabled
      </label>
    </div>
```

with:

```html
    <div class="net-row">
      <span class="net-label">UCI Server</span>
      <label class="switch-label">
        <input type="checkbox" id="uci-enabled-toggle">
        Enabled
      </label>
      <span class="net-label" style="width:auto;margin-left:14px">Port</span>
      <input type="number" id="uci-port-input" min="1" max="65535" step="1" style="width:80px">
      <button class="btn btn-ghost" id="uci-port-save-btn">Save</button>
      <button class="btn btn-warn hidden" id="uci-restart-btn">Restart Now</button>
    </div>
```

In the `initNetwork()` function, after the line `toggle.checked = info.uciEnabled`, add:

```js
    document.getElementById('uci-port-input').value = info.uciPort
```

After the existing `uci-enabled-toggle` `change` listener (the block ending `})` right before the `// ── Helpers ──` comment), add:

```js
document.getElementById('uci-port-save-btn').addEventListener('click', async () => {
  const hint = document.getElementById('net-hint')
  const portInput = document.getElementById('uci-port-input')
  const restartBtn = document.getElementById('uci-restart-btn')
  const port = parseInt(portInput.value, 10)
  try {
    await ipcRenderer.invoke('cfg:set-uci-port', port)
    hint.textContent = 'Port saved — restart required to apply'
    hint.style.color = 'var(--text-dim)'
    restartBtn.classList.remove('hidden')
  } catch (err) {
    hint.textContent = 'Error: ' + err.message
    hint.style.color = 'var(--red)'
  }
})

document.getElementById('uci-restart-btn').addEventListener('click', () => {
  ipcRenderer.invoke('cfg:restart-app')
})
```

- [ ] **Step 8: Manually verify**

Run: `npm start`
1. Open **Tray → Configure Mappings…**, expand the **Network** panel.
2. Confirm the Port field shows the current port (default `3001`).
3. Type `70000` and click Save — confirm an inline error appears and `config.json` is unchanged (`cat ~/Library/Application\ Support/midi-qsys-bridge/config.json | grep port`).
4. Type `3005` and click Save — confirm the hint says a restart is required and a **Restart Now** button appears.
5. Click **Restart Now** — confirm the app relaunches and the tray/Network panel now show port `3005`.
6. Set the port back to `3001` and restart again, to leave your dev config in its default state.

- [ ] **Step 9: Update docs**

In `README.md`, replace this sentence in the `## UCI / FOH mixer` section:

```
**Config:** controlled by the `uci.enabled` and `uci.port` keys in `config.json` (see `src/main/config.ts`) — `enabled` defaults to `true`, `port` defaults to `3001`. As with other config changes, restart the app to apply changes to these keys.
```

with:

```
**Config:** controlled by the `uci.enabled` and `uci.port` keys in `config.json` (see `src/main/config.ts`) — `enabled` defaults to `true`, `port` defaults to `3001`. Both can also be set from the Configurator's **Network** panel (**Configure Mappings… → Network — Q-SYS & UCI**) — after changing the port, click **Restart Now** to apply it. If you're opening a firewall rule for this app, the UCI port is the one to allow.
```

In `TESTING-PLAN.md`, add this new test right after "Test 10" (its three lettered parts (a)/(b)/(c)) and before the `---` / `## Troubleshooting` section:

```markdown
### Test 11 — Change the UCI port from the Configurator

**What:** Confirms the Network panel's port field validates input, saves it
to `config.json`, and the app actually listens on the new port after a
restart.

**How to test:**
1. Open **Tray → Configure Mappings…** and expand the **Network** panel.
2. Change the **Port** field to an unused port (e.g. `3005`) and click **Save**.
3. Confirm the hint reads "Port saved — restart required to apply" and a
   **Restart Now** button appears.
4. Try an invalid value (e.g. `70000` or `abc`) — confirm it's rejected with
   an inline error and `config.json` is unchanged.
5. Click **Restart Now** (or quit and relaunch manually).
6. After relaunch, confirm the tray's `UCI:` line and the Network panel's
   Local/LAN URLs now show the new port, and `http://localhost:3005/foh-uci`
   loads the mixer page.

**Pass:** Valid ports save and apply after restart; invalid ports are
rejected without touching `config.json`.
```

- [ ] **Step 10: Commit**

```bash
git add package.json src/main/config.ts src/main/config.test.ts src/main/configurator.ts src/renderer/configurator.html README.md TESTING-PLAN.md
git commit -m "Add configurable UCI port to the Configurator's Network panel"
```

---

### Task 2: Extract shared mapping-service module

**Files:**
- Create: `src/main/mapping-service.ts`
- Create: `src/main/mapping-service.test.ts`
- Modify: `src/main/configurator.ts`

**Interfaces:**
- Consumes: `stripComments` from `src/main/config.ts` (existing), `QrcClient` from `src/main/qrc-client.ts` (existing, methods `.isConnected`, `.call(method, params)`).
- Produces (all from `src/main/mapping-service.ts`, used by Task 4's HTTP layer and this task's updated `configurator.ts`):
  - `PHYSICAL_CONTROLS: PhysicalControl[]`, `type PhysicalControl`, `type ControlType`
  - `loadMappings(configFilePath: string): Mapping[]`
  - `saveMappings(configFilePath: string, mappings: Mapping[]): void`
  - `saveAndApplyMappings(configFilePath: string, mappings: Mapping[], onReload?: () => Promise<void>): Promise<void>`
  - `discoverComponents(qrc: QrcClient | null): Promise<Array<{ name: string; type: string }>>`
  - `getComponentControls(qrc: QrcClient | null, componentName: string): Promise<Array<{ name: string; isBoolean: boolean }>>`
  - `validateMappings(input: unknown): { valid: true; mappings: Mapping[] } | { valid: false; errors: Array<{ index: number; reason: string }> }`

- [ ] **Step 1: Write the failing tests**

Create `src/main/mapping-service.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateMappings, loadMappings, saveMappings } from './mapping-service.js'

test('validateMappings accepts a well-formed mappings array', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 22 }, qsys: { type: 'toggle', component: 'Input.Mixer', control: 'input.1.mute' } },
  ])
  assert.equal(result.valid, true)
})

test('validateMappings rejects a non-array payload', () => {
  const result = validateMappings({ not: 'an array' })
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.errors[0].reason, 'mappings must be an array')
})

test('validateMappings rejects an unknown qsys.type', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 1, number: 22 }, qsys: { type: 'not_a_real_type' } },
  ])
  assert.equal(result.valid, false)
  if (!result.valid) assert.equal(result.errors.length, 1)
})

test('validateMappings rejects a malformed midi block', () => {
  const result = validateMappings([
    { midi: { type: 'cc', channel: 'one', number: 22 }, qsys: { type: 'toggle', component: 'X', control: 'y' } },
  ])
  assert.equal(result.valid, false)
})

test('saveMappings then loadMappings round-trips through a real config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqb-test-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    qsys: { host: '', port: 1710 },
    midi: { deviceName: '' },
    mappings: [],
    feedback: { enabled: false, mute_leds: [] },
  }))

  const mappings = [{ midi: { type: 'cc' as const, channel: 1, number: 22 }, qsys: { type: 'toggle' as const, component: 'X', control: 'y' } }]
  saveMappings(configPath, mappings)

  const loaded = loadMappings(configPath)
  assert.deepEqual(loaded, mappings)

  fs.rmSync(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test`
Expected: FAIL — `src/main/mapping-service.ts` doesn't exist yet.

- [ ] **Step 3: Create `mapping-service.ts`**

Create `src/main/mapping-service.ts` with the full `PHYSICAL_CONTROLS` list moved verbatim from `configurator.ts` (lines 16–92 of the current file), plus the new load/save/validate/discovery functions:

```ts
/**
 * mapping-service — shared mapping data/read/write/discovery logic used by
 * both the desktop Configurator (IPC) and the browser-based mappings page
 * (HTTP). Neither caller owns this data; both call into these functions so
 * validation and file I/O aren't duplicated between the two.
 */

import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { stripComments } from './config.js'
import type { Mapping } from './config.js'

// ── Physical controls ─────────────────────────────────────────────────────────
// Hardcoded from the midi-learn session. All 51 controls, in layout order.

export type ControlType = 'fader' | 'knob' | 'toggle'

export interface PhysicalControl {
  id: string
  label: string
  group: string
  controlType: ControlType
  midi: { type: 'cc' | 'note_on'; channel: number; number: number }
}

const m = (type: 'cc' | 'note_on', channel: number, number: number) =>
  ({ type, channel, number } as const)

export const PHYSICAL_CONTROLS: PhysicalControl[] = [
  // ── Faders ────────────────────────────────────────────────────────────────
  { id: 'F1', label: 'Fader 1', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 22) },
  { id: 'F2', label: 'Fader 2', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 23) },
  { id: 'F3', label: 'Fader 3', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 24) },
  { id: 'F4', label: 'Fader 4', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 25) },
  { id: 'F5', label: 'Fader 5', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 26) },
  { id: 'F6', label: 'Fader 6', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 27) },
  { id: 'F7', label: 'Fader 7', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 28) },
  { id: 'F8', label: 'Fader 8', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 29) },
  { id: 'FM', label: 'Master Fader', group: 'Faders', controlType: 'fader', midi: m('cc', 7, 30) },
  // ── Knobs A (top row) ────────────────────────────────────────────────────
  { id: 'Ka1', label: 'Knob A 1', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 22) },
  { id: 'Ka2', label: 'Knob A 2', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 23) },
  { id: 'Ka3', label: 'Knob A 3', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 24) },
  { id: 'Ka4', label: 'Knob A 4', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 25) },
  { id: 'Ka5', label: 'Knob A 5', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 26) },
  { id: 'Ka6', label: 'Knob A 6', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 27) },
  { id: 'Ka7', label: 'Knob A 7', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 28) },
  { id: 'Ka8', label: 'Knob A 8', group: 'Knobs A', controlType: 'knob', midi: m('cc', 4, 29) },
  // ── Knobs B (middle row) ─────────────────────────────────────────────────
  { id: 'Kb1', label: 'Knob B 1', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 22) },
  { id: 'Kb2', label: 'Knob B 2', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 23) },
  { id: 'Kb3', label: 'Knob B 3', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 24) },
  { id: 'Kb4', label: 'Knob B 4', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 25) },
  { id: 'Kb5', label: 'Knob B 5', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 26) },
  { id: 'Kb6', label: 'Knob B 6', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 27) },
  { id: 'Kb7', label: 'Knob B 7', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 28) },
  { id: 'Kb8', label: 'Knob B 8', group: 'Knobs B', controlType: 'knob', midi: m('cc', 5, 29) },
  // ── Knobs C (bottom row) ─────────────────────────────────────────────────
  { id: 'Kc1', label: 'Knob C 1', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 22) },
  { id: 'Kc2', label: 'Knob C 2', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 23) },
  { id: 'Kc3', label: 'Knob C 3', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 24) },
  { id: 'Kc4', label: 'Knob C 4', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 25) },
  { id: 'Kc5', label: 'Knob C 5', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 26) },
  { id: 'Kc6', label: 'Knob C 6', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 27) },
  { id: 'Kc7', label: 'Knob C 7', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 28) },
  { id: 'Kc8', label: 'Knob C 8', group: 'Knobs C', controlType: 'knob', midi: m('cc', 6, 29) },
  // ── Mutes ────────────────────────────────────────────────────────────────
  { id: 'M1', label: 'Mute 1', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 22) },
  { id: 'M2', label: 'Mute 2', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 23) },
  { id: 'M3', label: 'Mute 3', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 24) },
  { id: 'M4', label: 'Mute 4', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 25) },
  { id: 'M5', label: 'Mute 5', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 26) },
  { id: 'M6', label: 'Mute 6', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 27) },
  { id: 'M7', label: 'Mute 7', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 28) },
  { id: 'M8', label: 'Mute 8', group: 'Mutes', controlType: 'toggle', midi: m('cc', 1, 29) },
  // ── Rec Arms ─────────────────────────────────────────────────────────────
  { id: 'RA1', label: 'Rec Arm 1', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 22) },
  { id: 'RA2', label: 'Rec Arm 2', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 23) },
  { id: 'RA3', label: 'Rec Arm 3', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 24) },
  { id: 'RA4', label: 'Rec Arm 4', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 25) },
  { id: 'RA5', label: 'Rec Arm 5', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 26) },
  { id: 'RA6', label: 'Rec Arm 6', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 27) },
  { id: 'RA7', label: 'Rec Arm 7', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 28) },
  { id: 'RA8', label: 'Rec Arm 8', group: 'Rec Arms', controlType: 'toggle', midi: m('cc', 3, 29) },
  // ── Bottom buttons ────────────────────────────────────────────────────────
  { id: 'BANKL',   label: 'Bank Left',  group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 25) },
  { id: 'BANKR',   label: 'Bank Right', group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 26) },
  { id: 'SOLO',    label: 'Solo',       group: 'Buttons', controlType: 'toggle', midi: m('note_on', 1, 27) },
]

// ── Config file read/write ───────────────────────────────────────────────────

function parseConfigFile(raw: string): Record<string, unknown> {
  return JSON.parse(stripComments(raw)) as Record<string, unknown>
}

export function loadMappings(configFilePath: string): Mapping[] {
  const raw = fs.readFileSync(configFilePath, 'utf-8')
  const config = parseConfigFile(raw)
  return (config.mappings as Mapping[] | undefined) ?? []
}

export function saveMappings(configFilePath: string, mappings: Mapping[]): void {
  const raw = fs.readFileSync(configFilePath, 'utf-8')
  const config = parseConfigFile(raw)
  config.mappings = mappings
  fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8')
}

export async function saveAndApplyMappings(
  configFilePath: string,
  mappings: Mapping[],
  onReload?: () => Promise<void>,
): Promise<void> {
  saveMappings(configFilePath, mappings)
  if (onReload) await onReload()
}

// ── Q-Sys discovery ───────────────────────────────────────────────────────────

export async function discoverComponents(qrc: QrcClient | null): Promise<Array<{ name: string; type: string }>> {
  if (!qrc?.isConnected) {
    throw new Error('Q-SYS not connected — check host in config.json')
  }
  const result = await qrc.call('Component.GetComponents', {})
  const list: Array<{ Name: string; Type?: string }> =
    Array.isArray(result) ? result :
    (result as Record<string, unknown>)?.Components as Array<{ Name: string; Type?: string }> ?? []
  return list
    .map(c => ({ name: c.Name, type: c.Type ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function getComponentControls(qrc: QrcClient | null, componentName: string): Promise<Array<{ name: string; isBoolean: boolean }>> {
  if (!qrc?.isConnected) return []
  try {
    const result = await qrc.call('Component.GetControls', { Name: componentName }) as Record<string, unknown>
    const controls = (result?.Controls ?? []) as Array<{ Name: string; Value: unknown }>
    return controls.map(c => ({
      name: c.Name,
      // Infer whether this is a boolean/toggle control vs continuous
      isBoolean: typeof c.Value === 'boolean' || c.Value === 0 || c.Value === 1
        ? c.Name.match(/mute|bypass|enable|power|solo|on$/i) !== null
        : false,
    }))
  } catch {
    // GetControls may not exist on all Q-SYS versions — caller falls back to text input
    return []
  }
}

// ── Validation (used by the HTTP save/apply endpoints before writing) ──────

export interface MappingValidationError { index: number; reason: string }

export function validateMappings(
  mappings: unknown,
): { valid: true; mappings: Mapping[] } | { valid: false; errors: MappingValidationError[] } {
  if (!Array.isArray(mappings)) {
    return { valid: false, errors: [{ index: -1, reason: 'mappings must be an array' }] }
  }
  const errors: MappingValidationError[] = []
  const validTypes = new Set(['component_control', 'toggle', 'named_control', 'snapshot'])
  mappings.forEach((entry, index) => {
    const e = entry as Record<string, unknown>
    const midi = e?.midi as Record<string, unknown> | undefined
    const qsys = e?.qsys as Record<string, unknown> | undefined
    if (!midi || (midi.type !== 'cc' && midi.type !== 'note_on')) {
      errors.push({ index, reason: 'midi.type must be "cc" or "note_on"' })
    } else if (typeof midi.channel !== 'number' || typeof midi.number !== 'number') {
      errors.push({ index, reason: 'midi.channel and midi.number must be numbers' })
    }
    if (!qsys || typeof qsys.type !== 'string' || !validTypes.has(qsys.type as string)) {
      errors.push({ index, reason: `qsys.type must be one of ${[...validTypes].join(', ')}` })
    }
  })
  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, mappings: mappings as Mapping[] }
}
```

- [ ] **Step 4: Run and confirm the new tests pass**

Run: `npm test`
Expected: all `mapping-service.test.ts` cases PASS (existing `config.test.ts` cases still PASS too).

- [ ] **Step 5: Update `configurator.ts` to use the shared module**

In `src/main/configurator.ts`:

1. Delete the `PHYSICAL_CONTROLS`/`ControlType`/`PhysicalControl`/`m` block (lines 16–92 of the current file — everything between the `// ── Physical controls ──` comment and the `// ── Configurator class ──` comment).

2. Replace the import block at the top of the file:

```ts
import { BrowserWindow, ipcMain, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { isValidPort, stripComments } from './config.js'
import { getLanIPv4 } from './network.js'
```

with:

```ts
import { BrowserWindow, ipcMain, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { isValidPort, stripComments } from './config.js'
import type { Mapping } from './config.js'
import { getLanIPv4 } from './network.js'
import {
  PHYSICAL_CONTROLS,
  discoverComponents,
  getComponentControls,
  saveMappings,
  saveAndApplyMappings,
} from './mapping-service.js'
```

3. Replace the `cfg:discover-components` handler:

```ts
    // ── Discover all components ─────────────────────────────────────────────
    ipcMain.handle('cfg:discover-components', async () => {
      if (!this.qrc?.isConnected) {
        throw new Error('Q-SYS not connected — check host in config.json')
      }
      const result = await this.qrc.call('Component.GetComponents', {})
      const list: Array<{ Name: string; Type?: string }> =
        Array.isArray(result) ? result :
        (result as Record<string, unknown>)?.Components as Array<{ Name: string; Type?: string }> ?? []
      return list
        .map(c => ({ name: c.Name, type: c.Type ?? '' }))
        .sort((a, b) => a.name.localeCompare(b.name))
    })

    // ── Get controls for a specific component ───────────────────────────────
    ipcMain.handle('cfg:get-component-controls', async (_event, componentName: string) => {
      if (!this.qrc?.isConnected) return []
      try {
        const result = await this.qrc.call('Component.GetControls', { Name: componentName }) as Record<string, unknown>
        const controls = (result?.Controls ?? []) as Array<{ Name: string; Value: unknown }>
        return controls.map(c => ({
          name: c.Name,
          // Infer whether this is a boolean/toggle control vs continuous
          isBoolean: typeof c.Value === 'boolean' || c.Value === 0 || c.Value === 1
            ? c.Name.match(/mute|bypass|enable|power|solo|on$/i) !== null
            : false,
        }))
      } catch {
        // GetControls may not exist on all Q-SYS versions — caller falls back to text input
        return []
      }
    })
```

with:

```ts
    // ── Discover all components ─────────────────────────────────────────────
    ipcMain.handle('cfg:discover-components', () => discoverComponents(this.qrc))

    // ── Get controls for a specific component ───────────────────────────────
    ipcMain.handle('cfg:get-component-controls', (_event, componentName: string) =>
      getComponentControls(this.qrc, componentName))
```

4. Replace the `cfg:save-config` and `cfg:save-and-apply` handlers:

```ts
    // ── Save new mappings (preserves everything else in config) ─────────────
    ipcMain.handle('cfg:save-config', (_event, mappings: unknown[]) => {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      config.mappings = mappings
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
    })

    // ── Save + hot-reload (no restart needed) ───────────────────────────────
    ipcMain.handle('cfg:save-and-apply', async (_event, mappings: unknown[]) => {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      config.mappings = mappings
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
      if (this.onReload) {
        await this.onReload()
      }
    })
```

with:

```ts
    // ── Save new mappings (preserves everything else in config) ─────────────
    ipcMain.handle('cfg:save-config', (_event, mappings: Mapping[]) =>
      saveMappings(this.configFilePath, mappings))

    // ── Save + hot-reload (no restart needed) ───────────────────────────────
    ipcMain.handle('cfg:save-and-apply', (_event, mappings: Mapping[]) =>
      saveAndApplyMappings(this.configFilePath, mappings, this.onReload))
```

5. Leave `cfg:get-physical-controls` as-is (`ipcMain.handle('cfg:get-physical-controls', () => PHYSICAL_CONTROLS)`) — it now refers to the imported constant instead of the local one, which is correct since it's imported by name.

- [ ] **Step 6: Rebuild and manually verify no regression**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `npm start`, open **Configure Mappings…**, confirm the table still loads existing assignments, Q-Sys components still populate the dropdowns, and both **Save** and **Save & Apply** still work exactly as before (this task must not change desktop Configurator behavior — it's a pure refactor).

- [ ] **Step 7: Commit**

```bash
git add src/main/mapping-service.ts src/main/mapping-service.test.ts src/main/configurator.ts
git commit -m "Extract mapping-service module shared by the desktop Configurator and future HTTP API"
```

---

### Task 3: Password hashing, session store, and Configurator password field

**Files:**
- Create: `src/main/auth.ts`
- Create: `src/main/auth.test.ts`
- Modify: `src/main/config.ts`
- Modify: `src/main/configurator.ts`
- Modify: `src/renderer/configurator.html`

**Interfaces:**
- Produces (from `src/main/auth.ts`, used by Task 4's HTTP layer):
  - `hashPassword(password: string): string`
  - `verifyPassword(password: string, stored: string): boolean`
  - `class SessionStore { constructor(ttlMs?: number, now?: () => number); create(): string; isValid(token: string | null | undefined): boolean }`
- Produces config field: `Config['uci'].mappingsPasswordHash?: string`.
- Produces IPC channels: `cfg:set-mappings-password` (payload: `string`, throws if too short), `cfg:has-mappings-password` (returns `boolean`).

- [ ] **Step 1: Write the failing tests**

Create `src/main/auth.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, SessionStore } from './auth.js'

test('verifyPassword accepts the correct password against its own hash', () => {
  const hash = hashPassword('correct horse battery staple')
  assert.equal(verifyPassword('correct horse battery staple', hash), true)
})

test('verifyPassword rejects a wrong password', () => {
  const hash = hashPassword('correct horse battery staple')
  assert.equal(verifyPassword('wrong password', hash), false)
})

test('hashPassword salts each call differently but both verify', () => {
  const a = hashPassword('same password')
  const b = hashPassword('same password')
  assert.notEqual(a, b)
  assert.equal(verifyPassword('same password', a), true)
  assert.equal(verifyPassword('same password', b), true)
})

test('verifyPassword rejects a malformed stored hash', () => {
  assert.equal(verifyPassword('anything', 'not-a-valid-hash'), false)
})

test('SessionStore.isValid is true for a fresh token and false for an unknown one', () => {
  const store = new SessionStore()
  const token = store.create()
  assert.equal(store.isValid(token), true)
  assert.equal(store.isValid('nonexistent-token'), false)
  assert.equal(store.isValid(undefined), false)
})

test('SessionStore.isValid expires tokens after the TTL using an injected clock', () => {
  let now = 0
  const store = new SessionStore(1000, () => now)
  const token = store.create()
  now = 500
  assert.equal(store.isValid(token), true)
  now = 1500
  assert.equal(store.isValid(token), false)
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test`
Expected: FAIL — `src/main/auth.ts` doesn't exist yet.

- [ ] **Step 3: Implement `auth.ts`**

Create `src/main/auth.ts`:

```ts
/**
 * auth — password hashing and session tokens for the browser-based
 * mappings page. Sessions are held in memory (process lifetime only —
 * restarting the app signs everyone out, which is fine for this use case).
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEYLEN = 64
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

/** Hashes a password as `salt:hash` (both hex). Never store the plaintext. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `${salt}:${hash}`
}

/** Constant-time comparison against a `salt:hash` value from hashPassword(). */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

export class SessionStore {
  private sessions = new Map<string, number>() // token → expiresAt (ms epoch)

  constructor(
    private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  create(): string {
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, this.now() + this.ttlMs)
    return token
  }

  isValid(token: string | null | undefined): boolean {
    if (!token) return false
    const expiresAt = this.sessions.get(token)
    if (expiresAt === undefined) return false
    if (this.now() > expiresAt) {
      this.sessions.delete(token)
      return false
    }
    return true
  }
}
```

- [ ] **Step 4: Run and confirm the tests pass**

Run: `npm test`
Expected: all `auth.test.ts` cases PASS.

- [ ] **Step 5: Add the config field**

In `src/main/config.ts`, change the `uci` field on the `Config` interface from:

```ts
  uci?: { enabled?: boolean; port?: number }
```

to:

```ts
  uci?: { enabled?: boolean; port?: number; mappingsPasswordHash?: string }
```

- [ ] **Step 6: Add the IPC handlers**

In `src/main/configurator.ts`, add `hashPassword` to the imports (change the `./auth.js` import — this is a new import line, add it near the top with the others):

```ts
import { hashPassword } from './auth.js'
```

Update `readUciConfig()`'s return type from:

```ts
  private readUciConfig(): { enabled?: boolean; port?: number } {
```

to:

```ts
  private readUciConfig(): { enabled?: boolean; port?: number; mappingsPasswordHash?: string } {
```

Then, inside `registerIpc()`, after the `cfg:restart-app` handler added in Task 1, add:

```ts

    // ── Set the browser mappings-page password (hashed, plaintext never stored) ─
    ipcMain.handle('cfg:set-mappings-password', (_event, password: string) => {
      const trimmed = password.trim()
      if (trimmed.length < 4) {
        throw new Error('Password must be at least 4 characters')
      }
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = this.parseConfig(raw)
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      uci.mappingsPasswordHash = hashPassword(trimmed)
      config.uci = uci
      fs.writeFileSync(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
    })

    // ── Whether a mappings-page password has been set yet ───────────────────
    ipcMain.handle('cfg:has-mappings-password', () => !!this.readUciConfig().mappingsPasswordHash)
```

- [ ] **Step 7: Add the Network panel UI**

In `src/renderer/configurator.html`, add a new row right after the "UCI Server" row (the one modified in Task 1):

```html
    <div class="net-row">
      <span class="net-label">Mappings Page</span>
      <input type="password" id="mappings-password-input" placeholder="Set a password to enable /mappings" style="flex:1;max-width:200px">
      <button class="btn btn-ghost" id="mappings-password-save-btn">Save</button>
      <span id="mappings-password-status" style="font-size:11px;color:var(--text-dim)"></span>
    </div>
```

In `initNetwork()`, at the end of the function (right before its closing `}`), add:

```js
  try {
    const hasPassword = await ipcRenderer.invoke('cfg:has-mappings-password')
    document.getElementById('mappings-password-input').placeholder =
      hasPassword ? 'Password set — enter a new one to change it' : 'Set a password to enable /mappings'
  } catch { /* leave default placeholder */ }
```

After the `uci-restart-btn` listener added in Task 1, add:

```js
document.getElementById('mappings-password-save-btn').addEventListener('click', async () => {
  const input = document.getElementById('mappings-password-input')
  const status = document.getElementById('mappings-password-status')
  try {
    await ipcRenderer.invoke('cfg:set-mappings-password', input.value)
    status.textContent = '✓ Saved'
    status.style.color = 'var(--green)'
    input.value = ''
    input.placeholder = 'Password set — enter a new one to change it'
  } catch (err) {
    status.textContent = '✗ ' + err.message
    status.style.color = 'var(--red)'
  }
})
```

- [ ] **Step 8: Manually verify**

Run: `npm start`, open **Configure Mappings… → Network** panel.
1. Type a 2-character password and click Save — confirm it's rejected ("at least 4 characters").
2. Type a real password and click Save — confirm "✓ Saved" appears and the placeholder changes to "Password set…".
3. Check `config.json` — confirm `uci.mappingsPasswordHash` is a `salt:hash` string, not the plaintext password.

- [ ] **Step 9: Commit**

```bash
git add src/main/auth.ts src/main/auth.test.ts src/main/config.ts src/main/configurator.ts src/renderer/configurator.html
git commit -m "Add password hashing, session store, and a mappings-page password field"
```

---

### Task 4: Mappings HTTP API mounted on the UCI server

**Files:**
- Create: `src/main/mappings-http.ts`
- Modify: `src/main/uci-server.ts`
- Modify: `src/main/index.ts`
- Modify: `TESTING-PLAN.md`

**Interfaces:**
- Consumes: `PHYSICAL_CONTROLS`, `loadMappings`, `saveMappings`, `saveAndApplyMappings`, `validateMappings`, `discoverComponents`, `getComponentControls` from `src/main/mapping-service.ts` (Task 2); `verifyPassword`, `SessionStore` from `src/main/auth.ts` (Task 3); `stripComments` from `src/main/config.ts`; `QrcClient` from `src/main/qrc-client.ts`.
- Produces: `class MappingsHttpHandler { constructor(configFilePath: string, mappingsHtmlPath: string, onReload?: () => Promise<void>); connect(coreHost: string, corePort: number): void; disconnect(): void; handle(req, res): boolean }` from `src/main/mappings-http.ts`, consumed by `UciServer.start()`.
- HTTP routes: `GET /mappings`, `POST /api/mappings/login`, `GET /api/mappings/session`, `GET /api/mappings`, `POST /api/mappings`, `POST /api/mappings/apply`, `GET /api/qsys/components`, `GET /api/qsys/components/:name/controls`.

- [ ] **Step 1: Implement `mappings-http.ts`**

Create `src/main/mappings-http.ts`:

```ts
/**
 * mappings-http — HTTP routes for the browser-based MIDI mappings page:
 * password login, session cookies, and a JSON API mirroring the desktop
 * Configurator's IPC handlers (list/save/apply mappings, discover Q-Sys
 * components). Mounted into UciServer's request handler.
 */

import http from 'node:http'
import fs from 'node:fs'
import { QrcClient } from './qrc-client.js'
import { stripComments } from './config.js'
import { verifyPassword, SessionStore } from './auth.js'
import {
  PHYSICAL_CONTROLS,
  loadMappings,
  saveMappings,
  saveAndApplyMappings,
  validateMappings,
  discoverComponents,
  getComponentControls,
} from './mapping-service.js'

const SESSION_COOKIE = 'mqb_mappings_session'

export class MappingsHttpHandler {
  private qrc: QrcClient | null = null
  private sessions = new SessionStore()

  constructor(
    private readonly configFilePath: string,
    private readonly mappingsHtmlPath: string,
    private readonly onReload?: () => Promise<void>,
  ) {}

  /** Opens the discovery QRC connection. Call once, alongside UciServer.start(). */
  connect(coreHost: string, corePort: number): void {
    this.qrc = new QrcClient(coreHost, corePort)
    this.qrc.connect().catch(() => { /* discovery calls surface the error */ })
  }

  /** Tears down the discovery QRC connection. Call alongside UciServer.stop(). */
  disconnect(): void {
    this.qrc?.disconnect().catch(() => {})
    this.qrc = null
  }

  private readPasswordHash(): string | null {
    try {
      const raw = fs.readFileSync(this.configFilePath, 'utf-8')
      const config = JSON.parse(stripComments(raw)) as Record<string, unknown>
      const uci = (config.uci as Record<string, unknown> | undefined) ?? {}
      return (uci.mappingsPasswordHash as string | undefined) ?? null
    } catch {
      return null
    }
  }

  private getSessionToken(req: http.IncomingMessage): string | null {
    const cookieHeader = req.headers.cookie
    if (!cookieHeader) return null
    for (const part of cookieHeader.split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key === SESSION_COOKIE) return rest.join('=')
    }
    return null
  }

  private isAuthenticated(req: http.IncomingMessage): boolean {
    return this.sessions.isValid(this.getSessionToken(req))
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => {
        if (!data) { resolve(undefined); return }
        try { resolve(JSON.parse(data)) } catch (err) { reject(err) }
      })
      req.on('error', reject)
    })
  }

  /**
   * Handles the request if its URL matches a route this module owns.
   * Returns true if handled (caller should stop routing), false otherwise.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://internal')
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === '/mappings') {
      fs.readFile(this.mappingsHtmlPath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end(`Mappings page not found at: ${this.mappingsHtmlPath}`)
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(data)
      })
      return true
    }

    if (pathname === '/api/mappings/login' && req.method === 'POST') {
      this.readJsonBody(req).then((body) => {
        const password = (body as Record<string, unknown> | undefined)?.password
        const storedHash = this.readPasswordHash()
        if (!storedHash) {
          this.sendJson(res, 409, { error: 'No mappings password has been set yet — set one in the Configurator Network panel.' })
          return
        }
        if (typeof password !== 'string' || !verifyPassword(password, storedHash)) {
          this.sendJson(res, 401, { error: 'Incorrect password' })
          return
        }
        const token = this.sessions.create()
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=86400`)
        this.sendJson(res, 200, { ok: true })
      }).catch(() => this.sendJson(res, 400, { error: 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/mappings/session' && req.method === 'GET') {
      this.sendJson(res, 200, { authenticated: this.isAuthenticated(req), passwordSet: !!this.readPasswordHash() })
      return true
    }

    if (!pathname.startsWith('/api/mappings') && !pathname.startsWith('/api/qsys')) {
      return false
    }

    if (!this.isAuthenticated(req)) {
      this.sendJson(res, 401, { error: 'Not authenticated' })
      return true
    }

    if (pathname === '/api/mappings' && req.method === 'GET') {
      try {
        const mappings = loadMappings(this.configFilePath)
        this.sendJson(res, 200, { physicalControls: PHYSICAL_CONTROLS, mappings })
      } catch (err) {
        this.sendJson(res, 500, { error: (err as Error).message })
      }
      return true
    }

    if (pathname === '/api/mappings' && req.method === 'POST') {
      this.readJsonBody(req).then((body) => {
        const result = validateMappings(body)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        saveMappings(this.configFilePath, result.mappings)
        this.sendJson(res, 200, { ok: true, count: result.mappings.length })
      }).catch(() => this.sendJson(res, 400, { error: 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/mappings/apply' && req.method === 'POST') {
      this.readJsonBody(req).then(async (body) => {
        const result = validateMappings(body)
        if (!result.valid) { this.sendJson(res, 400, { error: 'Invalid mappings', details: result.errors }); return }
        await saveAndApplyMappings(this.configFilePath, result.mappings, this.onReload)
        this.sendJson(res, 200, { ok: true, count: result.mappings.length })
      }).catch((err) => this.sendJson(res, 400, { error: (err as Error).message ?? 'Invalid request body' }))
      return true
    }

    if (pathname === '/api/qsys/components' && req.method === 'GET') {
      discoverComponents(this.qrc)
        .then((components) => this.sendJson(res, 200, { components }))
        .catch((err) => this.sendJson(res, 503, { error: (err as Error).message }))
      return true
    }

    const controlsMatch = pathname.match(/^\/api\/qsys\/components\/([^/]+)\/controls$/)
    if (controlsMatch && req.method === 'GET') {
      const componentName = decodeURIComponent(controlsMatch[1])
      getComponentControls(this.qrc, componentName)
        .then((controls) => this.sendJson(res, 200, { controls }))
        .catch((err) => this.sendJson(res, 503, { error: (err as Error).message }))
      return true
    }

    this.sendJson(res, 404, { error: 'Not found' })
    return true
  }
}
```

- [ ] **Step 2: Wire it into `UciServer`**

In `src/main/uci-server.ts`, add this import near the top (with the others):

```ts
import type { MappingsHttpHandler } from './mappings-http.js'
```

Add a new private field alongside the existing ones (after `private _lastError: string | null = null`):

```ts
  private mappingsHandler: MappingsHttpHandler | null = null
```

Change the `start()` signature and body. Replace:

```ts
  start(host: string, port: number, coreHost: string, corePort: number): void {
    if (this.server) return  // already started
```

with:

```ts
  start(host: string, port: number, coreHost: string, corePort: number, mappingsHandler?: MappingsHttpHandler): void {
    if (this.server) return  // already started

    this.mappingsHandler = mappingsHandler ?? null
    this.mappingsHandler?.connect(coreHost, corePort)
```

Inside the `http.createServer((req, res) => { ... })` callback, add a new check as the very first line of the callback body (before the existing `if (req.method === 'GET' && ...)` check for `/foh-uci`):

```ts
    const server = http.createServer((req, res) => {
      if (this.mappingsHandler?.handle(req, res)) return

      if (req.method === 'GET' && (req.url === '/foh-uci' || req.url?.startsWith('/foh-uci?'))) {
```

(Only the first two lines are new — the rest of the callback is unchanged.)

Finally, in `stop()`, add a line to tear down the mappings handler. Replace:

```ts
  stop(): void {
    for (const { ws, tcp } of this.relays) {
```

with:

```ts
  stop(): void {
    this.mappingsHandler?.disconnect()

    for (const { ws, tcp } of this.relays) {
```

- [ ] **Step 3: Wire it into `index.ts`**

In `src/main/index.ts`, add the import:

```ts
import { MappingsHttpHandler } from './mappings-http.js'
```

Replace the UCI server construction block:

```ts
  let uciServer: UciServer | null = null
  if (config && uciEnabled) {
    uciServer = new UciServer()
    uciServer.on('error', (err: Error) => {
      console.error(`[UCI] Server error: ${err.message}`)
    })
    // Bind 0.0.0.0 so LAN devices (iPad) can reach it; relay target is the
    // same Core the MIDI bridge talks to.
    uciServer.start('0.0.0.0', uciPort, config.qsys.host, config.qsys.port)
  }
```

with:

```ts
  let uciServer: UciServer | null = null
  if (config && uciEnabled) {
    const mappingsHtmlPath = path.join(app.getAppPath(), 'assets', 'mappings', 'mappings.html')
    const mappingsHandler = new MappingsHttpHandler(
      findConfigPath(),
      mappingsHtmlPath,
      async () => { await bridge?.reloadConfig() },
    )
    uciServer = new UciServer()
    uciServer.on('error', (err: Error) => {
      console.error(`[UCI] Server error: ${err.message}`)
    })
    // Bind 0.0.0.0 so LAN devices (iPad) can reach it; relay target is the
    // same Core the MIDI bridge talks to.
    uciServer.start('0.0.0.0', uciPort, config.qsys.host, config.qsys.port, mappingsHandler)
  }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: no TypeScript errors. Note `assets/mappings/mappings.html` doesn't exist yet (Task 5) — that's fine, it's only read at request time, not at build time.

- [ ] **Step 5: Manually verify with curl**

In `TESTING-PLAN.md`, add this new test right after "Test 9 — Concurrency check" and before "Test 10 — Manual-only":

```markdown
### Test 12 — Mappings API smoke test (curl)

**What:** Confirms the new `/api/mappings/*` and `/api/qsys/*` routes are
wired up correctly before the browser page (Test 13) exists to exercise them.

**How to test** (run with the app started and a mappings password already
set via Configurator → Network → Mappings Page):
1. Confirm unauthenticated access is rejected:
   ```bash
   curl -i http://localhost:3001/api/mappings
   ```
   Expect `401` and `{"error":"Not authenticated"}`.
2. Log in and save the session cookie:
   ```bash
   curl -i -c /tmp/mqb-cookies.txt -X POST http://localhost:3001/api/mappings/login \
     -H 'Content-Type: application/json' -d '{"password":"<your password>"}'
   ```
   Expect `200` and a `Set-Cookie` header.
3. Fetch mappings using the saved cookie:
   ```bash
   curl -i -b /tmp/mqb-cookies.txt http://localhost:3001/api/mappings
   ```
   Expect `200` with `{"physicalControls": [...], "mappings": [...]}`.
4. Try a wrong password:
   ```bash
   curl -i -X POST http://localhost:3001/api/mappings/login \
     -H 'Content-Type: application/json' -d '{"password":"definitely-wrong"}'
   ```
   Expect `401` and `{"error":"Incorrect password"}`.

**Pass:** All four responses match the expected status/body shown above.
```

Then actually run those four `curl` commands against `npm start` and confirm the responses match.

- [ ] **Step 6: Commit**

```bash
git add src/main/mappings-http.ts src/main/uci-server.ts src/main/index.ts TESTING-PLAN.md
git commit -m "Add password-gated HTTP API for MIDI mappings on the UCI server"
```

---

### Task 5: Browser mappings page

**Files:**
- Create: `assets/mappings/mappings.html`
- Modify: `README.md`
- Modify: `TESTING-PLAN.md`

**Interfaces:**
- Consumes: the HTTP API from Task 4 (`/api/mappings/login`, `/api/mappings/session`, `/api/mappings`, `/api/mappings/apply`, `/api/qsys/components`, `/api/qsys/components/:name/controls`).

- [ ] **Step 1: Create the mappings page**

Create `assets/mappings/mappings.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MIDI Mappings</title>
<style>
  :root {
    --bg: #f5f5f7; --surface: #ffffff; --border: #d1d1d6; --text: #1c1c1e;
    --text-dim: #6e6e73; --accent: #007aff; --red: #ff3b30; --green: #34c759;
    --orange: #ff9500; --group-bg: #e9e9ee;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; color: var(--text);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); min-height: 100vh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--border); }
  header h1 { font-size: 16px; font-weight: 600; flex: 1; }
  button { cursor: pointer; border: none; font-size: 12px; font-family: inherit; }
  .btn { padding: 6px 14px; border-radius: 6px; font-weight: 500; }
  .btn-ghost { background: var(--bg); color: var(--text); border: 1px solid var(--border); }
  .btn-ghost:hover { background: var(--border); }
  .btn-primary { background: var(--accent); color: white; }
  .btn-primary:hover { background: #005ecb; }
  .btn-warn { background: var(--orange); color: white; }
  .btn-warn:hover { background: #cc7800; }
  .hidden { display: none !important; }

  #login-view { flex: 1; display: flex; align-items: center; justify-content: center; }
  .login-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 28px; width: 300px; display: flex; flex-direction: column; gap: 12px; }
  .login-card h2 { font-size: 15px; font-weight: 600; }
  .login-card input[type=password] { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 13px; }
  .login-card p.hint { font-size: 12px; color: var(--text-dim); }
  .login-card p.err { font-size: 12px; color: var(--red); min-height: 14px; }

  .tabs { display: flex; gap: 2px; padding: 0 16px; background: var(--surface); border-bottom: 1px solid var(--border); overflow-x: auto; }
  .tab { padding: 8px 12px; background: none; color: var(--text-dim); border-bottom: 2px solid transparent; margin-bottom: -1px; font-size: 12px; font-weight: 500; white-space: nowrap; }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }

  .filterbar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; background: var(--bg); border-bottom: 1px solid var(--border); }
  .filterbar input[type=search] { padding: 5px 9px; border: 1px solid var(--border); border-radius: 5px; width: 180px; font-size: 12px; background: var(--surface); }
  #count-label { font-size: 11px; color: var(--text-dim); margin-left: auto; }

  .table-wrap { flex: 1; overflow-x: auto; }
  table { width: 100%; min-width: 780px; border-collapse: collapse; }
  thead tr { background: var(--surface); }
  th { padding: 7px 10px; text-align: left; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-dim); border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); }
  td { padding: 5px 6px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr.group-row { background: var(--group-bg); }
  tr.group-row td { padding: 4px 10px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-dim); }
  tr.ctrl-row.assigned { background: #f0fff4; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
  .badge-fader { background: #d1f0d1; color: #1a6b1a; }
  .badge-knob  { background: #d4e5ff; color: #003fa8; }
  .badge-toggle{ background: #ffe5d4; color: #a83000; }
  select, input[type=text], input[type=number] { width: 100%; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font-size: 12px; color: var(--text); font-family: inherit; }
  select:disabled, input:disabled { background: var(--bg); color: var(--text-dim); }
  .td-label { font-size: 12px; font-weight: 500; padding-left: 10px; white-space: nowrap; }
  .td-clear { text-align: center; }
  .clear-btn { background: none; color: var(--text-dim); font-size: 13px; padding: 2px 5px; border-radius: 3px; }
  .clear-btn:hover { background: #ffe5e5; color: var(--red); }

  footer { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: var(--surface); border-top: 1px solid var(--border); }
  #save-status { font-size: 12px; color: var(--text-dim); }
  #save-status.ok  { color: var(--green); }
  #save-status.err { color: var(--red); }
  footer span.spacer { flex: 1; }
</style>
</head>
<body>

<div id="login-view">
  <div class="login-card">
    <h2>MIDI Mappings — Sign in</h2>
    <input type="password" id="login-password" placeholder="Password">
    <button class="btn btn-primary" id="login-btn">Sign in</button>
    <p class="err" id="login-error"></p>
    <p class="hint" id="login-setup-hint"></p>
  </div>
</div>

<div id="app-view" class="hidden" style="display:flex;flex-direction:column;flex:1;min-height:0">
  <header>
    <h1>MIDI Mappings</h1>
    <button class="btn btn-ghost" id="refresh-btn">↺ Refresh Q-Sys</button>
  </header>

  <div class="tabs" id="tabs">
    <button class="tab active" data-group="all">All</button>
    <button class="tab" data-group="Faders">Faders</button>
    <button class="tab" data-group="Knobs A">Knobs A</button>
    <button class="tab" data-group="Knobs B">Knobs B</button>
    <button class="tab" data-group="Knobs C">Knobs C</button>
    <button class="tab" data-group="Mutes">Mutes</button>
    <button class="tab" data-group="Rec Arms">Rec Arms</button>
    <button class="tab" data-group="Buttons">Buttons</button>
  </div>

  <div class="filterbar">
    <input type="search" id="filter-input" placeholder="Filter e.g. Fader 1, Mute…">
    <span id="count-label"></span>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Control</th><th>Type</th><th>Q-Sys Component</th><th>Control Name</th><th>Min</th><th>Max</th><th></th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

  <footer>
    <button class="btn btn-primary" id="save-btn">Save</button>
    <button class="btn btn-warn" id="save-apply-btn">Save &amp; Apply</button>
    <span id="save-status"></span>
    <span class="spacer"></span>
  </footer>
</div>

<script>
let physicalControls = []
let components = []
const ctrlCache = new Map()
const assignments = new Map()
let activeGroup = 'all'
let filterText = ''

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

async function api(path, opts) {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts })
  if (res.status === 401) { showLogin(); throw new Error('Session expired — please sign in again') }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status))
  return body
}

function showLogin() {
  document.getElementById('app-view').classList.add('hidden')
  document.getElementById('login-view').classList.remove('hidden')
}

function showApp() {
  document.getElementById('login-view').classList.add('hidden')
  document.getElementById('app-view').classList.remove('hidden')
}

async function checkSession() {
  const info = await api('/api/mappings/session')
  if (!info.passwordSet) {
    document.getElementById('login-setup-hint').textContent =
      'No password set yet — open the Configurator on the bridge Mac (Network panel) to set one.'
    document.getElementById('login-btn').disabled = true
  }
  if (info.authenticated) { await loadApp(); showApp() } else { showLogin() }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const password = document.getElementById('login-password').value
  const err = document.getElementById('login-error')
  err.textContent = ''
  try {
    await api('/api/mappings/login', { method: 'POST', body: JSON.stringify({ password }) })
    document.getElementById('login-password').value = ''
    await loadApp()
    showApp()
  } catch (e) {
    err.textContent = e.message
  }
})

async function loadApp() {
  const data = await api('/api/mappings')
  physicalControls = data.physicalControls
  assignments.clear()
  for (const mObj of data.mappings) {
    const pc = physicalControls.find(p =>
      p.midi.type === mObj.midi.type && p.midi.channel === mObj.midi.channel && p.midi.number === mObj.midi.number)
    if (pc) {
      assignments.set(pc.id, {
        component: mObj.qsys.component ?? '',
        controlName: mObj.qsys.control ?? '',
        min: mObj.qsys.min ?? -100,
        max: mObj.qsys.max ?? 10,
        label: mObj.label ?? pc.label,
      })
    }
  }
  await refreshComponents()
  renderTable()
}

async function refreshComponents() {
  try {
    const data = await api('/api/qsys/components')
    components = data.components
    ctrlCache.clear()
  } catch (e) {
    components = []
    const status = document.getElementById('save-status')
    status.textContent = 'Q-Sys: ' + e.message
    status.className = 'err'
  }
}

async function getControlsFor(componentName) {
  if (ctrlCache.has(componentName)) return ctrlCache.get(componentName)
  let controls = []
  try {
    const data = await api('/api/qsys/components/' + encodeURIComponent(componentName) + '/controls')
    controls = data.controls
    controls.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  } catch { /* manual entry fallback */ }
  ctrlCache.set(componentName, controls)
  return controls
}

function renderTable() {
  const tbody = document.getElementById('tbody')
  tbody.innerHTML = ''
  const lf = filterText.toLowerCase()
  let shown = 0
  let lastGroup = null

  for (const pc of physicalControls) {
    if (activeGroup !== 'all' && pc.group !== activeGroup) continue
    if (lf && !pc.label.toLowerCase().includes(lf) && !pc.id.toLowerCase().includes(lf)) continue

    if (pc.group !== lastGroup) {
      const gr = tbody.insertRow()
      gr.className = 'group-row'
      gr.insertCell().colSpan = 7
      gr.cells[0].textContent = pc.group
      lastGroup = pc.group
    }

    const a = assignments.get(pc.id)
    const isToggle = pc.controlType === 'toggle'
    const row = tbody.insertRow()
    row.className = 'ctrl-row' + (a?.component ? ' assigned' : '')
    row.dataset.id = pc.id

    const tdLabel = row.insertCell()
    tdLabel.className = 'td-label'
    tdLabel.textContent = pc.label

    const tdType = row.insertCell()
    tdType.innerHTML = '<span class="badge badge-' + pc.controlType + '">' + pc.controlType + '</span>'

    const tdComp = row.insertCell()
    const compSel = document.createElement('select')
    compSel.dataset.id = pc.id
    compSel.className = 'comp-sel'
    compSel.innerHTML = '<option value="">— unassigned —</option>' +
      components.map(c => '<option value="' + esc(c.name) + '"' + (a?.component === c.name ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('')
    tdComp.appendChild(compSel)

    const tdCtrl = row.insertCell()
    const dlId = 'dl-' + pc.id
    const ctrlInput = document.createElement('input')
    ctrlInput.type = 'text'
    ctrlInput.dataset.id = pc.id
    ctrlInput.className = 'ctrl-input'
    ctrlInput.placeholder = a?.component ? 'type or pick…' : '—'
    ctrlInput.value = a?.controlName ?? ''
    ctrlInput.disabled = !a?.component
    ctrlInput.setAttribute('list', dlId)
    const dl = document.createElement('datalist')
    dl.id = dlId
    tdCtrl.appendChild(ctrlInput)
    tdCtrl.appendChild(dl)

    const tdMin = row.insertCell()
    const minInp = document.createElement('input')
    minInp.type = 'number'; minInp.step = 'any'
    minInp.dataset.id = pc.id; minInp.className = 'min-inp'
    minInp.value = String(a?.min ?? -100)
    minInp.disabled = isToggle || !a?.component
    if (isToggle) minInp.style.visibility = 'hidden'
    tdMin.appendChild(minInp)

    const tdMax = row.insertCell()
    const maxInp = document.createElement('input')
    maxInp.type = 'number'; maxInp.step = 'any'
    maxInp.dataset.id = pc.id; maxInp.className = 'max-inp'
    maxInp.value = String(a?.max ?? 10)
    maxInp.disabled = isToggle || !a?.component
    if (isToggle) maxInp.style.visibility = 'hidden'
    tdMax.appendChild(maxInp)

    const tdClear = row.insertCell()
    tdClear.className = 'td-clear'
    const clearBtn = document.createElement('button')
    clearBtn.className = 'clear-btn'
    clearBtn.dataset.id = pc.id
    clearBtn.textContent = '✕'
    clearBtn.disabled = !a?.component
    tdClear.appendChild(clearBtn)

    if (a?.component && ctrlCache.has(a.component)) {
      populateDatalist(dl, ctrlCache.get(a.component))
    } else if (a?.component) {
      getControlsFor(a.component).then(ctrls => populateDatalist(dl, ctrls))
    }

    shown++
  }

  document.getElementById('count-label').textContent = shown + ' of ' + physicalControls.length + ' controls'
}

function populateDatalist(dl, controls) {
  dl.innerHTML = controls.map(c => '<option value="' + esc(c.name) + '">').join('')
}

document.getElementById('tbody').addEventListener('change', async e => {
  const el = e.target
  const id = el.dataset.id
  if (!id) return
  if (el.classList.contains('comp-sel')) {
    const componentName = el.value
    const a = assignments.get(id) ?? {}
    if (!componentName) { assignments.delete(id); renderTable(); return }
    assignments.set(id, { ...a, component: componentName, controlName: '', min: -100, max: 10 })
    await getControlsFor(componentName)
    renderTable()
  }
})

document.getElementById('tbody').addEventListener('input', e => {
  const el = e.target
  const id = el.dataset.id
  if (!id) return
  const a = assignments.get(id) ?? {}
  if (el.classList.contains('ctrl-input')) {
    assignments.set(id, { ...a, controlName: el.value.trim() })
  } else if (el.classList.contains('min-inp')) {
    assignments.set(id, { ...a, min: parseFloat(el.value) || 0 })
  } else if (el.classList.contains('max-inp')) {
    assignments.set(id, { ...a, max: parseFloat(el.value) || 1 })
  }
})

document.getElementById('tbody').addEventListener('click', e => {
  const btn = e.target.closest('.clear-btn')
  if (!btn) return
  assignments.delete(btn.dataset.id)
  renderTable()
})

document.getElementById('tabs').addEventListener('click', e => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
  tab.classList.add('active')
  activeGroup = tab.dataset.group
  renderTable()
})

document.getElementById('filter-input').addEventListener('input', e => {
  filterText = e.target.value
  renderTable()
})

document.getElementById('refresh-btn').addEventListener('click', async () => {
  await refreshComponents()
  renderTable()
})

function buildMappings() {
  const mappings = []
  for (const pc of physicalControls) {
    const a = assignments.get(pc.id)
    if (!a?.component || !a?.controlName) continue
    const isToggle = pc.controlType === 'toggle'
    mappings.push({
      label: a.label || pc.label,
      midi: { ...pc.midi },
      qsys: isToggle
        ? { type: 'toggle', component: a.component, control: a.controlName }
        : { type: 'component_control', component: a.component, control: a.controlName, min: a.min ?? -100, max: a.max ?? 10 },
    })
  }
  return mappings
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const status = document.getElementById('save-status')
  status.className = ''; status.textContent = 'Saving…'
  try {
    const mappings = buildMappings()
    const result = await api('/api/mappings', { method: 'POST', body: JSON.stringify(mappings) })
    status.className = 'ok'; status.textContent = '✓ Saved — ' + result.count + ' mappings'
  } catch (e) {
    status.className = 'err'; status.textContent = '✗ ' + e.message
  }
})

document.getElementById('save-apply-btn').addEventListener('click', async () => {
  const status = document.getElementById('save-status')
  status.className = ''; status.textContent = 'Applying…'
  try {
    const mappings = buildMappings()
    const result = await api('/api/mappings/apply', { method: 'POST', body: JSON.stringify(mappings) })
    status.className = 'ok'; status.textContent = '✓ Applied — ' + result.count + ' mappings'
  } catch (e) {
    status.className = 'err'; status.textContent = '✗ ' + e.message
  }
})

checkSession().catch(e => {
  document.getElementById('login-error').textContent = 'Error: ' + e.message
})
</script>
</body>
</html>
```

- [ ] **Step 2: Ensure the file ships with the packaged app**

`package.json`'s `build.files` array already includes `"assets/**/*"` (see the existing `build` config) — no change needed there. Confirm this by checking `package.json`'s `build.files` includes that glob.

- [ ] **Step 3: Manually verify end-to-end**

Run: `npm start`.
1. On the bridge Mac, visit `http://localhost:<port>/mappings` — confirm the login form appears (or the "no password set" notice, if Task 3's password hasn't been set on this machine yet — set one first).
2. Enter the wrong password — confirm an inline error, no page navigation.
3. Enter the correct password — confirm the table loads with the same assignments as the desktop Configurator.
4. Assign an unassigned control to a Q-Sys component/control, click **Save & Apply**, and confirm `config.json`'s `mappings` array reflects the change and the bridge picks it up live (move the physical MIDI control and confirm it now maps correctly, or check Q-Sys Designer).
5. Reload the page — confirm the session persists (no login prompt) and the new assignment is still shown.
6. From a second device on the same WiFi, open the LAN URL version (`http://<lan-ip>:<port>/mappings`) and repeat steps 2–3.

- [ ] **Step 4: Update docs**

In `README.md`, add this new section immediately after the `## UCI / FOH mixer` section (before `## Tray menu`):

```markdown
## Browser-based MIDI mappings

The MIDI-to-Q-Sys mapping table (the same data the desktop **Configure
Mappings** window edits) is also reachable from any browser on the LAN, so
you don't need physical or remote-desktop access to the Mac to remap a
control.

**First-time setup:** open **Configure Mappings… → Network** panel and set
a **Mappings Page** password — the page won't allow access until one is
set.

**Access it at:** `http://<lan-ip-or-localhost>:<port>/mappings` (same host
and port as the FOH UCI). Enter the password to sign in; the session lasts
24 hours per browser.

The page has the same capabilities as the desktop Configurator: assign
Q-Sys components/controls to physical MIDImix controls, and **Save** or
**Save & Apply** (applies live, no restart). Component/control lists are
fetched live from Q-Sys, same as the desktop version.

---
```

In `TESTING-PLAN.md`, add this new test right after "Test 12 — Mappings API smoke test (curl)" and before "Test 10 — Manual-only" (note: Test 10 already comes before Test 12 in the file at this point — insert Test 13 directly after Test 12's content, still ahead of the final `## Troubleshooting` section):

```markdown
### Test 13 — Manage MIDI mappings from a browser

**What:** End-to-end check of the browser-based mappings page — confirms it
can be reached from another device, requires the password, and edits
actually reach Q-Sys the same way the desktop Configurator's Save & Apply
does.

**How to test:**
1. In the Configurator's Network panel, set a Mappings Page password if you
   haven't already (Test 12 setup).
2. From a phone/tablet/laptop on the same WiFi as the bridge Mac, open
   `http://<lan-ip>:<port>/mappings` (same LAN IP shown in Tray → UCI).
3. Confirm a login form appears; try a wrong password (rejected with an
   inline error), then the correct one (table loads).
4. Assign a component/control to an unassigned physical control, click
   **Save & Apply**, and confirm the change actually reaches Q-Sys (e.g.
   move the mapped MIDImix control and watch it respond, or check the value
   in Q-Sys Designer).
5. Reload the page — confirm you're still signed in (session cookie
   persists) and the new assignment is still shown.
6. Open the same URL in a private/incognito window — confirm it asks for
   the password again (no shared session across browser profiles).

**Pass:** Login gate works, edits save and apply live, and the session
persists across reloads but not across separate browser profiles.
```

- [ ] **Step 5: Commit**

```bash
git add assets/mappings/mappings.html README.md TESTING-PLAN.md
git commit -m "Add browser-based MIDI mappings page"
```
