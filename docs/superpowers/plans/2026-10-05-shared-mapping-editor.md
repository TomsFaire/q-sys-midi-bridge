# Shared Mapping Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two duplicated mapping-table editors with one shared module that both the browser page and the desktop Configurator load, so a mapping feature lands once.

**Architecture:** A classic (non-module) script at `assets/shared/mapping-editor.js` sets `window.MappingEditor` and owns all editor state, rendering, events and `buildMappings`. Each host passes a six-method transport adapter — IPC for desktop, `fetch` for web — and keeps its own chrome. Network controls stay desktop-only and untouched.

**Tech Stack:** Vanilla JS (no bundler, no framework), TypeScript for the main process only, `node:test` + `node:assert/strict`, Electron 33.

**Spec:** `docs/superpowers/specs/2026-10-05-shared-mapping-editor-design.md`

## Global Constraints

- **No ES modules in shared front-end code.** The desktop renderer loads over `file://` (`BrowserWindow.loadFile`, `nodeIntegration: true`), where Chromium blocks module imports. Use a classic `<script src>` setting one global.
- **No new runtime dependencies and no bundler.** The build is `tsc` only; `npm run build` must stay unchanged.
- **Shared files live under `assets/shared/`.** `package.json` already packages `assets/**/*` and `src/renderer/**/*`; do not change the `files` array.
- **The Network panel is out of scope.** Host, UCI enable/port, mappings password and restart stay inline in `src/renderer/configurator.html`.
- **Tests run via `npm test`**, which is `tsc` then `node --test dist/main/**/*.test.js`. Test files are TypeScript under `src/main/` and compile to `dist/main/`.
- **Baseline before starting: 92 tests passing** (as of `main` at v0.2.11). Any task that reduces that count without deleting a named obsolete test is wrong.

## Review Focus

Five failure modes the spec implies but no task's own tests would naturally exercise. Each line's test is added to the task named in brackets.

1. **A mapping whose MIDI address matches no physical control is dropped on save.** `loadEditorState` matches config entries to `PHYSICAL_CONTROLS` by type/channel/number; a non-matching entry never enters `assignments`, so the next save deletes it. Expected: it survives untouched. [Task 1 pins current behaviour; Task 9 fixes it]
2. **`named_control` and `snapshot` mappings are dropped on save.** They have no `qsys.component`, so `buildMappings` skips them. A config with snapshot buttons loses them the first time anyone opens an editor and saves. Expected: they survive untouched. [Task 1 pins; Task 9 fixes]
3. **A mapping referencing a component absent from Q-SYS discovery renders as "— unassigned —" and is dropped on save.** Happens whenever a component is renamed in Designer, or whenever the Core is offline and discovery returns nothing. Expected: the stored name is kept and shown even when discovery doesn't list it. [Task 3]
4. **Two config entries sharing one MIDI address silently collapse.** `assignments` is keyed by `pc.id`, so the last entry wins and the earlier one is lost on save. Expected: deterministic, and the user can tell it happened. [Task 1 pins current behaviour]
5. **An adapter method rejecting mid-flight must leave a usable editor.** If discovery throws after `loadEditorState` succeeded, the table must still render with free-text control entry rather than a half-built DOM. [Task 4]

---

## File Structure

**Created:**
- `assets/shared/mapping-editor.js` — all editor state, render, events, `buildMappings`. Sets `window.MappingEditor`.
- `assets/shared/mapping-editor.css` — table, badges, row states, link row.
- `src/main/mapping-editor.test.ts` — the single editor test suite.
- `src/main/editor-golden.test.ts` — golden `buildMappings` fixtures (Task 1; deleted in Task 8 only if fully subsumed).

**Modified:**
- `assets/mappings/mappings.html` — keeps login + status line; gains a `fetch` adapter; loses ~250 lines of editor code.
- `src/renderer/configurator.html` — keeps Network panel + overlay + footer; gains an IPC adapter; loses ~250 lines of editor code.

**Deleted:**
- `src/main/mappings-editor-link.test.ts` and `src/main/configurator-link.test.ts` (Task 8) — their coverage moves into `mapping-editor.test.ts`.

---

### Task 1: Golden fixtures for current behaviour

Locks what both editors do *today* before anything moves. Every later task must keep these green.

**Files:**
- Create: `src/main/editor-golden.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GOLDEN_FIXTURES` — exported array of `{ name, pc, assignment }`, reused by Task 6 and Task 7.

- [ ] **Step 1: Write the fixture file and the failing test**

Reuse the vm harness already in `src/main/mappings-editor-link.test.ts` (copy `makeElement`, `makeDocument`, `loadEditor`). Add both hosts.

```ts
export const GOLDEN_FIXTURES = [
  { name: 'plain knob', pc: KNOB_A1,
    assignment: { component: 'Mic.02.Gain', controlName: 'gain', min: -100, max: 20 } },
  { name: 'plain toggle', pc: MUTE_1,
    assignment: { component: 'Mic.02.Gain', controlName: 'mute' } },
  { name: 'ganged knob, component-only link', pc: KNOB_A1,
    assignment: { component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
                  link: { component: 'Dante.In.10.Gain', control: 'gain' } } },
  { name: 'ganged knob, control-only link', pc: KNOB_A1,
    assignment: { component: 'Dante.Pair.Gain', controlName: 'gain.1', min: -100, max: 20,
                  link: { component: 'Dante.Pair.Gain', control: 'gain.2' } } },
  { name: 'ganged knob, both fields differ', pc: KNOB_A1,
    assignment: { component: 'A.Gain', controlName: 'gain.1', min: -100, max: 20,
                  link: { component: 'B.Gain', control: 'gain.2' } } },
  { name: 'ganged toggle', pc: MUTE_1,
    assignment: { component: 'Dante.In.9.Gain', controlName: 'mute',
                  link: { component: 'Dante.In.10.Gain', control: 'mute' } } },
  { name: 'link ticked but unfilled', pc: KNOB_A1,
    assignment: { component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
                  link: { component: '', control: 'gain' } } },
  { name: 'no control name', pc: KNOB_A1,
    assignment: { component: 'Mic.02.Gain', controlName: '' } },
  { name: 'custom label', pc: KNOB_A1,
    assignment: { component: 'Mic.02.Gain', controlName: 'gain', min: -18, max: 18, label: 'Mic 2 Trim' } },
]

test('web and desktop editors agree on every golden fixture', () => {
  for (const f of GOLDEN_FIXTURES) {
    const web = buildViaWeb(f.pc, f.assignment)
    const desktop = buildViaDesktop(f.pc, f.assignment)
    assert.deepEqual(web, desktop, `hosts disagree on: ${f.name}`)
  }
})
```

- [ ] **Step 2: Run it, then freeze the agreed output into the fixtures**

Run: `npm test 2>&1 | grep -E 'golden|tests |pass |fail '`

Expected: it may FAIL. The two editors are not known to agree. Record any disagreement — that is a real finding, not a test bug. If they disagree, treat the web's output as the target (it is the one with the Link UI) and note the difference in the commit message.

Once they agree, print the output and paste it back into each fixture as an `expected` field, so later tasks compare against a frozen literal rather than against the old code:

```bash
node -e "require('./dist/main/editor-golden.test.js')" 2>/dev/null || true
```

Each fixture then reads, for example:

```ts
{ name: 'ganged knob, component-only link', pc: KNOB_A1,
  assignment: { component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
                link: { component: 'Dante.In.10.Gain', control: 'gain' } },
  expected: { label: 'Knob A 1', midi: { type: 'cc', channel: 4, number: 22 },
              qsys: { type: 'component_control', component: 'Dante.In.9.Gain',
                      control: 'gain', min: -100, max: 20,
                      link: { component: 'Dante.In.10.Gain' } } } },
```

Add the assertion that pins it:

```ts
test('each fixture matches its frozen expected output', () => {
  for (const f of GOLDEN_FIXTURES) {
    if (!f.expected) { assert.deepEqual(buildViaWeb(f.pc, f.assignment), [], f.name); continue }
    assert.deepEqual(buildViaWeb(f.pc, f.assignment), [f.expected], f.name)
  }
})
```

The two fixtures that produce nothing — `'link ticked but unfilled'` emits a mapping with no `link`, and `'no control name'` emits nothing at all — carry `expected: null` and `expected: undefined` respectively; the branch above handles the empty case.

- [ ] **Step 3: Pin the two silent-deletion behaviours (Review Focus 1, 2, 4)**

These assert today's *buggy* behaviour deliberately, so Task 9 has something to flip.

```ts
test('TODAY: a mapping with no matching physical control is dropped on save', async () => {
  const saved = [{ label: 'Ghost', midi: { type: 'cc', channel: 9, number: 99 },
                   qsys: { type: 'component_control', component: 'X.Gain', control: 'gain' } }]
  const out = await roundTripWeb(KNOB_A1, saved)
  assert.deepEqual(out, [], 'documents the data-loss Task 9 fixes')
})

test('TODAY: a snapshot mapping is dropped on save', async () => {
  const saved = [{ label: 'Snap', midi: { type: 'note_on', channel: 1, number: 25 },
                   qsys: { type: 'snapshot', bank: 1, slot: 3 } }]
  const out = await roundTripWeb(BANKL, saved)
  assert.deepEqual(out, [], 'documents the data-loss Task 9 fixes')
})

test('TODAY: two mappings on one MIDI address collapse to the last', async () => {
  const a = { label: 'First', midi: { type: 'cc', channel: 4, number: 22 },
              qsys: { type: 'component_control', component: 'A.Gain', control: 'gain', min: -100, max: 10 } }
  const b = { ...a, label: 'Second', qsys: { ...a.qsys, component: 'B.Gain' } }
  const out = await roundTripWeb(KNOB_A1, [a, b])
  assert.equal(out.length, 1)
  assert.equal(out[0].qsys.component, 'B.Gain')
})
```

- [ ] **Step 4: Run and confirm all pass**

Run: `npm test 2>&1 | tail -8`
Expected: PASS, total 83 + new count.

- [ ] **Step 5: Commit**

```bash
git add src/main/editor-golden.test.ts
git commit -m "Pin both editors' current save output with golden fixtures"
```

---

### Task 2: Shared module — state and pure logic

**Files:**
- Create: `assets/shared/mapping-editor.js`
- Create: `src/main/mapping-editor.test.ts`

**Interfaces:**
- Consumes: `GOLDEN_FIXTURES` from Task 1.
- Produces:
  - `MappingEditor.__internals` — `{ buildMappings, guessRange, withLink, repointPrimary }`, exposed for tests only.
  - `buildMappings(physicalControls, assignments)` → `Mapping[]`
  - `guessRange(controlName)` → `[min, max]`
  - `withLink(assignment, qsys)` → `qsys` (mutated, returned)
  - `repointPrimary(assignments, id, componentName)` → void

- [ ] **Step 1: Write the failing test**

```ts
import { loadSharedEditor } from './helpers/load-shared-editor.js'
import { GOLDEN_FIXTURES } from './editor-golden.test.js'

test('buildMappings reproduces every golden fixture', () => {
  const { buildMappings } = loadSharedEditor().__internals
  for (const f of GOLDEN_FIXTURES) {
    const assignments = new Map([[f.pc.id, f.assignment]])
    const out = JSON.parse(JSON.stringify(buildMappings([f.pc], assignments)))
    assert.deepEqual(out, f.expected ? [f.expected] : [], f.name)
  }
})

test('guessRange suggests a frequency span for a frequency control', () => {
  const { guessRange } = loadSharedEditor().__internals
  assert.deepEqual(guessRange('frequency'), [20, 20000])
})

test('guessRange falls back to a unit span for an unrecognised name', () => {
  const { guessRange } = loadSharedEditor().__internals
  assert.deepEqual(guessRange('wibble'), [0, 1])
})
```

`loadSharedEditor` is a new helper reading `assets/shared/mapping-editor.js` and running it in a `vm` with a stub `window`. It is far simpler than the old harness because there is no HTML and no `<script>` extraction:

```ts
export function loadSharedEditor(): any {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'assets', 'shared', 'mapping-editor.js'), 'utf-8')
  const sandbox: any = { console, document: makeDocument() }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox)
  return sandbox.MappingEditor
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E 'buildMappings reproduces|guessRange'`
Expected: FAIL — `ENOENT` on `assets/shared/mapping-editor.js`.

- [ ] **Step 3: Create the module with pure logic only**

```js
;(function (global) {
  'use strict'

  function guessRange(ctrlName) {
    const n = String(ctrlName).toLowerCase()
    if (n.includes('gain') || n.includes('level') || n.includes('volume')) return [-100, 10]
    if (n.includes('freq') || n.includes('hz')) return [20, 20000]
    if (n.includes('threshold')) return [-40, 0]
    if (n.includes('ratio')) return [1, 20]
    if (n.includes('attack') || n.includes('release')) return [0, 500]
    return [0, 1]
  }

  // Emits qsys.link only when it names a second target. Fields matching the
  // primary are omitted and inherited back on load.
  function withLink(a, qsys) {
    if (!a.link) return qsys
    const link = {}
    if (a.link.component && a.link.component !== a.component) link.component = a.link.component
    if (a.link.control && a.link.control !== a.controlName) link.control = a.link.control
    if (link.component || link.control) qsys.link = link
    return qsys
  }

  function buildMappings(physicalControls, assignments) {
    const mappings = []
    for (const pc of physicalControls) {
      const a = assignments.get(pc.id)
      if (!a || !a.component || !a.controlName) continue
      const isToggle = pc.controlType === 'toggle'
      const qsys = isToggle
        ? { type: 'toggle', component: a.component, control: a.controlName }
        : { type: 'component_control', component: a.component, control: a.controlName,
            min: a.min ?? -100, max: a.max ?? 10 }
      mappings.push({ label: a.label || pc.label, midi: { ...pc.midi }, qsys: withLink(a, qsys) })
    }
    return mappings
  }

  // Repointing the primary drops any gang — the old partner is unrelated to
  // the new primary, and silently ganging two unrelated controls is worse
  // than making the user tick Link again.
  function repointPrimary(assignments, id, componentName) {
    const a = assignments.get(id) || {}
    assignments.set(id, { ...a, component: componentName, controlName: '',
                          min: -100, max: 10, link: null })
  }

  global.MappingEditor = {
    __internals: { buildMappings, guessRange, withLink, repointPrimary },
  }
})(typeof window !== 'undefined' ? window : globalThis)
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/shared/mapping-editor.js src/main/mapping-editor.test.ts src/main/helpers/load-shared-editor.ts
git commit -m "Extract mapping-editor pure logic into a shared module"
```

---

### Task 3: Shared module — rendering

**Files:**
- Modify: `assets/shared/mapping-editor.js`
- Modify: `src/main/mapping-editor.test.ts`

**Interfaces:**
- Consumes: `__internals` from Task 2.
- Produces: `renderTable()`, `renderRow(id)`, `renderLinkRow(tbody, pc, a)`, `populateDatalist(dl, controls)` on the internal editor instance.

Move the render code from `assets/mappings/mappings.html` (the `renderTable`, `renderLinkRow`, `populateDatalist` functions) rather than the desktop's — the web version already draws the Link column and the linked-leg row. Carry across from the desktop version only its `esc()` usage, which is byte-identical in both.

Replace the web's full-table rebuild with a real per-row render. Note the desktop's existing `refreshRow` only *clears* a row; this is a genuine new function, better than either:

```js
// Re-renders one row from current state, leaving the rest of the table and
// the user's focus alone. Replaces both the web's full-table rebuild and the
// desktop's clear-only refreshRow.
function renderRow(id) {
  const old = root.querySelector(`tr.ctrl-row[data-id="${id}"]`)
  if (!old) return renderTable()
  const link = root.querySelector(`tr.link-row[data-id="${id}"]`)
  if (link) link.remove()
  const pc = physicalControls.find(p => p.id === id)
  const fresh = buildRowElement(pc, assignments.get(id))
  old.replaceWith(fresh)
  const a = assignments.get(id)
  if (a && a.link) fresh.after(buildLinkRowElement(pc, a))
}
```

- [ ] **Step 1: Write the failing test (includes Review Focus 3)**

```ts
test('a component absent from discovery is still shown as the row value', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'Renamed.Gain',
                         control: 'gain', min: -100, max: 10 } }],
    components: [{ name: 'Other.Gain', type: '' }],   // discovery lacks it
  })
  const sel = ed.root.querySelector('tr.ctrl-row[data-id="Ka1"] .comp-sel')
  assert.equal(sel.value, 'Renamed.Gain',
    'a renamed or offline component must not silently blank the row')
})

test('renderRow replaces only its own row', () => {
  const ed = mountForTest({ physicalControls: [KNOB_A1, KNOB_A2], mappings: [] })
  const before = ed.root.querySelector('tr.ctrl-row[data-id="Ka2"]')
  ed.__internals.assignments.set('Ka1', { component: 'Mic.02.Gain', controlName: 'gain', min: -100, max: 10 })
  ed.__internals.renderRow('Ka1')
  const after = ed.root.querySelector('tr.ctrl-row[data-id="Ka2"]')
  assert.equal(before, after, 'the untouched row must be the same node, so focus survives')
})

test('a ganged row renders a linked-leg row directly beneath it', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'A.Gain', control: 'gain',
                         min: -100, max: 10, link: { component: 'B.Gain' } } }],
    components: [{ name: 'A.Gain', type: '' }, { name: 'B.Gain', type: '' }],
  })
  const rows = [...ed.root.querySelectorAll('tr')]
  const primary = rows.findIndex(r => r.className === 'ctrl-row')
  assert.equal(rows[primary + 1].className, 'link-row')
  assert.equal(rows[primary + 1].querySelector('.lnk-comp-sel').value, 'B.Gain')
})

test('an unganged row renders no linked-leg row', () => {
  const ed = mountForTest({
    physicalControls: [KNOB_A1],
    mappings: [{ label: 'K', midi: KNOB_A1.midi,
                 qsys: { type: 'component_control', component: 'A.Gain', control: 'gain', min: -100, max: 10 } }],
    components: [{ name: 'A.Gain', type: '' }],
  })
  assert.equal(ed.root.querySelector('tr.link-row'), null)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E 'absent from discovery|renderRow replaces'`
Expected: FAIL — `renderTable is not a function`.

- [ ] **Step 3: Implement render**

Port `renderTable`/`renderLinkRow` from `assets/mappings/mappings.html`, changing: `document.getElementById('tbody')` → `root.querySelector('tbody')`; group-row `colSpan` stays 8; and in the component `<select>`, when `a.component` is set but not present in `components`, prepend it as a selected option so the stored value survives:

```js
const known = components.some(c => c.name === a?.component)
const extra = (a?.component && !known)
  ? `<option value="${esc(a.component)}" selected>${esc(a.component)} (not on Core)</option>`
  : ''
compSel.innerHTML = '<option value="">— unassigned —</option>' + extra +
  components.map(/* … as today … */).join('')
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/shared/mapping-editor.js src/main/mapping-editor.test.ts
git commit -m "Move table rendering into the shared editor, per-row"
```

---

### Task 4: Shared module — events, adapter and mount

**Files:**
- Modify: `assets/shared/mapping-editor.js`
- Modify: `src/main/mapping-editor.test.ts`

**Interfaces:**
- Produces:
  - `MappingEditor.mount({ root, adapter, onStatus })` → `Promise<handle>`
  - handle: `{ save(), saveAndApply(), reload(), getMappings() }`
  - adapter: `{ loadEditorState(), getQsysStatus(), discoverComponents(), getComponentControls(name), save(mappings), saveAndApply(mappings) }`
  - `onStatus({ kind, text })` where `kind` is `'info' | 'ok' | 'err'`

- [ ] **Step 1: Write the failing test (includes Review Focus 5)**

```ts
function fakeAdapter(over = {}) {
  return {
    loadEditorState: async () => ({ physicalControls: [KNOB_A1], mappings: [] }),
    getQsysStatus: async () => ({ connected: true }),
    discoverComponents: async () => [{ name: 'Mic.02.Gain', type: 'gain' }],
    getComponentControls: async () => [{ name: 'gain', isBoolean: false }],
    save: async () => ({ count: 0 }),
    saveAndApply: async () => ({ count: 0 }),
    ...over,
  }
}

test('discovery failing still leaves an editable table', async () => {
  const statuses = []
  const ed = await MappingEditor.mount({
    root: makeRoot(),
    adapter: fakeAdapter({ discoverComponents: async () => { throw new Error('Core unreachable') } }),
    onStatus: s => statuses.push(s),
  })
  assert.ok(ed.root.querySelector('tr.ctrl-row'), 'table must still render')
  assert.ok(statuses.some(s => s.kind === 'err' && /unreachable/.test(s.text)))
})

test('saveAndApply dispatches to the adapter, not save', async () => {
  const calls = []
  const ed = await MappingEditor.mount({ root: makeRoot(), adapter: fakeAdapter({
    save: async () => { calls.push('save'); return { count: 0 } },
    saveAndApply: async () => { calls.push('apply'); return { count: 0 } },
  }), onStatus: () => {} })
  await ed.saveAndApply()
  assert.deepEqual(calls, ['apply'])
})

test('a rejected save reports through onStatus and does not throw', async () => {
  const statuses = []
  const ed = await MappingEditor.mount({ root: makeRoot(),
    adapter: fakeAdapter({ save: async () => { throw new Error('disk full') } }),
    onStatus: s => statuses.push(s) })
  await ed.save()
  assert.ok(statuses.some(s => s.kind === 'err' && /disk full/.test(s.text)))
})

test('ticking Link seeds the control name from the primary', async () => {
  const ed = await mountWith({ physicalControls: [KNOB_A1] })
  ed.__internals.assignments.set('Ka1', { component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20 })
  ed.__internals.renderRow('Ka1')
  const chk = ed.root.querySelector('tr.ctrl-row[data-id="Ka1"] .lnk-chk')
  chk.checked = true
  chk.dispatchEvent(new FakeEvent('change', chk))
  assert.deepEqual(ed.__internals.assignments.get('Ka1').link, { component: '', control: 'gain' },
    'the common case is the same control on the neighbouring component')
})

test('repointing the primary component clears the link', async () => {
  const ed = await mountWith({ physicalControls: [KNOB_A1] })
  ed.__internals.assignments.set('Ka1', {
    component: 'Dante.In.9.Gain', controlName: 'gain', min: -100, max: 20,
    link: { component: 'Dante.In.10.Gain', control: 'gain' },
  })
  ed.__internals.repointPrimary(ed.__internals.assignments, 'Ka1', 'Mic.03.Gain')
  assert.equal(ed.__internals.assignments.get('Ka1').link, null,
    'a stale partner must not silently gang two unrelated controls')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test 2>&1 | grep -E 'discovery failing|saveAndApply dispatches'`
Expected: FAIL — `MappingEditor.mount is not a function`.

- [ ] **Step 3: Implement mount, events and the handle**

Move the three `tbody` listeners from `assets/mappings/mappings.html` (`change`, `input`, `click`) onto `root`, replacing every `renderTable()` call with `renderRow(id)` except where the component select is cleared (which removes the row's assignment and still needs a full redraw of that row — `renderRow` handles it). Wrap `loadEditorState` / `getQsysStatus` / `discoverComponents` each in try/catch reporting via `onStatus`, and let the table render regardless.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/shared/mapping-editor.js src/main/mapping-editor.test.ts
git commit -m "Add mount, adapter contract and event handling to the shared editor"
```

---

### Task 5: Shared stylesheet

**Files:**
- Create: `assets/shared/mapping-editor.css`
- Modify: `assets/mappings/mappings.html`, `src/renderer/configurator.html`

- [ ] **Step 1: Create the stylesheet**

Move from `assets/mappings/mappings.html`'s `<style>`: `.table-wrap`, `table`, `thead tr`, `th`, `td`, `tr.group-row`, `tr.ctrl-row.assigned`, `.badge*`, `select`/`input` rules, `.td-label`, `.td-clear`, `.clear-btn`, `.td-link`, `.leg`, `tr.link-row`, `.shared-hint`, `.tabs`, `.tab`, `.filterbar`, `#count-label`. Leave the `:root` token block in each page — both already define identical tokens and the stylesheet consumes them.

- [ ] **Step 2: Link it from both pages**

`assets/mappings/mappings.html`: `<link rel="stylesheet" href="/shared/mapping-editor.css">`
`src/renderer/configurator.html`: `<link rel="stylesheet" href="../../assets/shared/mapping-editor.css">`

The web path requires a route — see Task 6 Step 1.

- [ ] **Step 3: Verify both pages still render**

Run: `npm run build && npx electron .` then open Tray → Configure Mappings.
Expected: table looks unchanged.

- [ ] **Step 4: Commit**

```bash
git add assets/shared/mapping-editor.css assets/mappings/mappings.html src/renderer/configurator.html
git commit -m "Share the mapping-editor stylesheet between both hosts"
```

---

### Task 6: Migrate the web page

**Files:**
- Modify: `assets/mappings/mappings.html`
- Modify: `src/main/uci-server.ts` (serve `/shared/*`)
- Modify: `src/main/mapping-editor.test.ts`

- [ ] **Step 1: Serve `assets/shared/` from the UCI server**

Add a route in `uci-server.ts` alongside the existing `/mappings` and `/foh-uci` handlers, mapping `GET /shared/<file>` to `assets/shared/<file>` with `text/css` or `text/javascript`. Reject any path containing `..`.

- [ ] **Step 2: Write the failing test**

Follow the existing `uci-server` test style in `src/main/uci-state-sync.test.ts`:
start the real server on port 0, read the assigned port, and use `fetch`.

```ts
async function startServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = new UciServer({ port: 0, /* … as uci-state-sync.test.ts does … */ })
  await server.start()
  return { port: server.address().port, stop: () => server.stop() }
}

test('the UCI server serves the shared editor script', async () => {
  const { port, stop } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/shared/mapping-editor.js`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /javascript/)
  await stop()
})

test('the shared route refuses path traversal', async () => {
  const { port, stop } = await startServer()
  // Encoded so fetch does not normalise the .. away before it reaches us.
  const res = await fetch(`http://127.0.0.1:${port}/shared/%2E%2E%2F%2E%2E%2Fpackage.json`)
  assert.equal(res.status, 404)
  await stop()
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test 2>&1 | grep 'shared editor script'`
Expected: FAIL — 404.

- [ ] **Step 4: Implement the route, then replace the page's editor code**

Delete from `mappings.html`: `renderTable`, `renderLinkRow`, `populateDatalist`, `repointPrimary`, `buildMappings`, `getControlsFor`, `refreshComponents`, the three `tbody` listeners, the tab and filter listeners, and the `assignments`/`components`/`ctrlCache`/`activeGroup`/`filterText` state. Keep `esc`, `api`, `showLogin`, `showApp`, `checkSession` and the login handler.

Replace `loadApp` with:

```js
const adapter = {
  loadEditorState: () => api('/api/mappings'),
  getQsysStatus: async () => {
    try { await api('/api/qsys/components'); return { connected: true } }
    catch (e) { return { connected: false, message: e.message } }
  },
  discoverComponents: async () => (await api('/api/qsys/components')).components,
  getComponentControls: async (name) =>
    (await api('/api/qsys/components/' + encodeURIComponent(name) + '/controls')).controls,
  save: (m) => api('/api/mappings', { method: 'POST', body: JSON.stringify(m) }),
  saveAndApply: (m) => api('/api/mappings/apply', { method: 'POST', body: JSON.stringify(m) }),
}

async function loadApp() {
  editor = await MappingEditor.mount({
    root: document.getElementById('editor-root'),
    adapter,
    onStatus: ({ kind, text }) => {
      const el = document.getElementById('save-status')
      el.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''
      el.textContent = text
    },
  })
}
```

Wire the two footer buttons to `editor.save()` and `editor.saveAndApply()`.

- [ ] **Step 5: Run the golden fixtures against the migrated page**

Run: `npm test 2>&1 | tail -8`
Expected: PASS, Task 1's golden fixtures included.

- [ ] **Step 6: Commit**

```bash
git add assets/mappings/mappings.html src/main/uci-server.ts src/main/mapping-editor.test.ts
git commit -m "Move the web mappings page onto the shared editor"
```

---

### Task 7: Migrate the desktop Configurator

**Files:**
- Modify: `src/renderer/configurator.html`

- [ ] **Step 1: Add the script tags**

```html
<link rel="stylesheet" href="../../assets/shared/mapping-editor.css">
<script src="../../assets/shared/mapping-editor.js"></script>
```

Both resolve relative to `src/renderer/` under `file://`, and `assets/**` is packaged.

- [ ] **Step 2: Write the failing test**

```ts
test('the desktop adapter maps every method to an IPC channel', () => {
  const channels = []
  const html = fs.readFileSync(CONFIGURATOR_HTML, 'utf-8')
  for (const ch of ['cfg:load-config', 'cfg:get-physical-controls', 'cfg:get-qsys-status',
                    'cfg:discover-components', 'cfg:get-component-controls',
                    'cfg:save-config', 'cfg:save-and-apply']) {
    assert.ok(html.includes(ch), `configurator must still invoke ${ch}`)
  }
})
```

- [ ] **Step 3: Replace the editor code with an IPC adapter**

Delete the same function set as Task 6 Step 4, plus `guessRange` and `refreshRow` (now shared). Keep `initNetwork` and everything it calls, `setOverlay`, `hideOverlay`, `esc`.

```js
const adapter = {
  loadEditorState: async () => ({
    physicalControls: await ipcRenderer.invoke('cfg:get-physical-controls'),
    mappings: (await ipcRenderer.invoke('cfg:load-config')).mappings ?? [],
  }),
  getQsysStatus: () => ipcRenderer.invoke('cfg:get-qsys-status'),
  discoverComponents: () => ipcRenderer.invoke('cfg:discover-components'),
  getComponentControls: (name) => ipcRenderer.invoke('cfg:get-component-controls', name),
  save: (m) => ipcRenderer.invoke('cfg:save-config', m),
  saveAndApply: (m) => ipcRenderer.invoke('cfg:save-and-apply', m),
}
```

Map `onStatus` to the existing status line, and call `setOverlay`/`hideOverlay` around `mount`.

- [ ] **Step 4: Run tests and smoke-test the window**

Run: `npm test 2>&1 | tail -8` → PASS.
Then `npm run build && npx electron .`, Tray → Configure Mappings. Verify: table draws, tabs filter, assigning a component populates controls, **the Link checkbox now appears**, Save & Apply works, and the Network panel is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/configurator.html src/main/mapping-editor.test.ts
git commit -m "Move the desktop Configurator onto the shared editor"
```

---

### Task 8: Collapse the old tests and verify the packaged build

**Files:**
- Delete: `src/main/mappings-editor-link.test.ts`, `src/main/configurator-link.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Confirm coverage moved, then delete**

Check every test name in both files has an equivalent in `mapping-editor.test.ts`. Only then:

```bash
git rm src/main/mappings-editor-link.test.ts src/main/configurator-link.test.ts
```

- [ ] **Step 2: Run the suite**

Run: `npm test 2>&1 | tail -8`
Expected: PASS. Count drops by the deleted tests' count and must not drop further.

- [ ] **Step 3: Verify the packaged build resolves the shared script**

This is the risk the spec names: `file://` paths differ between `npm start` and a packaged bundle.

```bash
npm run package
```

Then launch `release/mac-arm64/MIDI Q-Sys Bridge.app`, open Configure Mappings, and confirm the table renders. A blank table means the `<script src>` did not resolve in the bundle.

- [ ] **Step 4: Document the shared editor in README.md**

Add a short subsection under the mappings docs noting that both editors share `assets/shared/mapping-editor.js`, that a new `qsys.*` field needs changing in one place now, and that Network controls remain desktop-only.

- [ ] **Step 5: Commit**

```bash
# Explicit paths, never `git add -A`: editor work leaves sed/backup artifacts
# such as `src/main/mapping-editor.test.ts-E` lying untracked in the worktree,
# and -A would commit them.
git add README.md src/main/mapping-editor.test.ts
git rm src/main/mappings-editor-link.test.ts src/main/configurator-link.test.ts
git commit -m "Collapse the duplicated editor tests into one suite"
```

Before committing, run `git status --short` and confirm nothing unexpected is
staged.

---

### Task 9 (OPTIONAL — behaviour change, confirm before starting)

Stop the editors deleting mappings they cannot represent. **This is not part of the refactor.** It fixes Review Focus 1 and 2, which are pre-existing bugs in both editors. It flips the three `TODAY:` tests from Task 1 Step 3, which must be rewritten, not deleted.

**Files:**
- Modify: `assets/shared/mapping-editor.js`
- Modify: `src/main/editor-golden.test.ts`

- [ ] **Step 1: Rewrite the pinning tests to assert the fixed behaviour**

```ts
test('a mapping with no matching physical control survives a save', async () => {
  const ghost = { label: 'Ghost', midi: { type: 'cc', channel: 9, number: 99 },
                  qsys: { type: 'component_control', component: 'X.Gain', control: 'gain' } }
  const out = await roundTrip(KNOB_A1, [ghost])
  assert.deepEqual(out, [ghost], 'unrepresentable mappings must be preserved verbatim')
})

test('a snapshot mapping survives a save', async () => {
  const snap = { label: 'Snap', midi: { type: 'note_on', channel: 1, number: 25 },
                 qsys: { type: 'snapshot', bank: 1, slot: 3 } }
  assert.deepEqual(await roundTrip(BANKL, [snap]), [snap])
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | grep 'survives a save'`
Expected: FAIL — output is `[]`.

- [ ] **Step 3: Implement passthrough**

`buildMappings` gains a third parameter rather than reading module state, so it
stays pure and directly testable. Update the Task 2 signature and both its call
sites (`editor.getMappings()` and `editor.save()`):

```js
// `unrepresented` holds mappings this editor cannot show — snapshots, named
// controls, and entries whose MIDI address matches no physical control. The
// editor rewrites the whole array on save, so anything missing from its output
// is deleted from the user's config. Carry them through untouched, after the
// represented ones so ordering stays stable.
function buildMappings(physicalControls, assignments, unrepresented = []) {
  const mappings = []
  for (const pc of physicalControls) {
    // … unchanged from Task 2 …
  }
  return mappings.concat(unrepresented)
}
```

In `mount`, capture them as the assignments are built:

```js
const matched = new Set()
for (const m of loaded.mappings) {
  const pc = physicalControls.find(p =>
    p.midi.type === m.midi.type &&
    p.midi.channel === m.midi.channel &&
    p.midi.number === m.midi.number)
  // Only component-bearing types can be represented by a row.
  if (pc && (m.qsys.type === 'component_control' || m.qsys.type === 'toggle')) {
    matched.add(m)
    assignments.set(pc.id, /* … as today … */)
  }
}
unrepresented = loaded.mappings.filter(m => !matched.has(m))
```

Note the duplicate-MIDI case (Review Focus 4) still collapses: both entries
match a physical control, so the second overwrites the first in `assignments`
and the first is *not* carried over. That is unchanged from today and out of
scope here — leave the Task 1 test asserting it.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add assets/shared/mapping-editor.js src/main/editor-golden.test.ts
git commit -m "Stop the editors deleting mappings they cannot represent"
```
