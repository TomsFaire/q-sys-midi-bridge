# Output Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Output Router section to the FOH UCI's PATCH page that mirrors the existing Input Router, routing the app's 6 processed output signals to 16 physical destinations via the `Output.Router` Q-Sys component.

**Architecture:** Single-file change to `assets/uci/foh-uci.html`. Mirrors the existing Input Router's HTML table, per-row `<select>` construction, crosspoint `Component.set` call, and `Component.GetControls` state-load pattern exactly, with a 6-entry source list instead of 24 and mono-only rows instead of stereo pairs.

**Tech Stack:** Vanilla JS, Q-Sys QRC JS API (`QRC.component.set`, `QRC.call('Component.GetControls', ...)`), no build step, no automated test harness for this file.

## Global Constraints

- Reuse `.router-table` / `.router-select` / `.router-label` / `.router-col-label` / `.router-col-select` CSS classes verbatim — no new styles.
- Crosspoint control naming convention: `output.<N>.input.<M>.select` where `N` = router's own output index, `M` = router's own input index. Setting one crosspoint `true` is sufficient — Q-Sys clears the rest.
- Do not touch the existing Input Router, `OUTPUT_STRIPS` processing chain, or ROUTING tab crosspoint matrices.
- The `Output.Router` Q-Sys component already exists in the design — out of scope to create it.
- No automated test harness exists for `foh-uci.html`; verification is manual, in-browser.

---

### Task 1: Add Output Router HTML section to the PATCH page

**Files:**
- Modify: `assets/uci/foh-uci.html:1248-1254` (insert new `.patch-section` directly after the existing Input Router section, still inside `#patch-scroll`)

**Interfaces:**
- Produces: `<tbody id="output-router-tbody">` — the mount point Task 2's `buildPatchTab()` extension populates.

- [ ] **Step 1: Insert the new section markup**

Change:
```html
    <div class="patch-section">
      <h3 class="patch-section-title">Input Router</h3>
      <table class="router-table">
        <thead><tr><th class="router-col-label">Output</th><th class="router-col-select">Source</th></tr></thead>
        <tbody id="router-tbody"></tbody>
      </table>
    </div>
  </div>
</div>
```
to:
```html
    <div class="patch-section">
      <h3 class="patch-section-title">Input Router</h3>
      <table class="router-table">
        <thead><tr><th class="router-col-label">Output</th><th class="router-col-select">Source</th></tr></thead>
        <tbody id="router-tbody"></tbody>
      </table>
    </div>
    <div class="patch-section">
      <h3 class="patch-section-title">Output Router</h3>
      <table class="router-table">
        <thead><tr><th class="router-col-label">Output</th><th class="router-col-select">Source</th></tr></thead>
        <tbody id="output-router-tbody"></tbody>
      </table>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Verify markup is well-formed**

Run: `python3 -c "import re,sys; s=open('assets/uci/foh-uci.html').read(); print('output-router-tbody' in s, s.count('<div class=\"patch-section\">'))"`
Expected: `True 3` (Phantom Power, Input Router, Output Router sections)

- [ ] **Step 3: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Add Output Router section markup to PATCH page"
```

---

### Task 2: Add Output Router data model, select builder, and buildPatchTab wiring

**Files:**
- Modify: `assets/uci/foh-uci.html:2456-2472` (data model, alongside `INPUT_SOURCE_NAMES` / `ROUTER_ROWS`)
- Modify: `assets/uci/foh-uci.html:2494-2540` (`buildPatchTab()`)

**Interfaces:**
- Consumes: none new (parallels `INPUT_SOURCE_NAMES`, `ROUTER_ROWS`, `makeSourceSelect` already in the file)
- Produces: `OUTPUT_ROUTER_SOURCES` (object, 6 entries), `OUTPUT_ROUTER_ROWS` (array of `{label, out}`), `makeOutputRouterSelect(outputN)` (function returning a configured `<select>`) — consumed by Task 3's `loadPatchState()` extension via the `#output-router-tbody [data-output="N"]` selector it sets on each `<select>`.

- [ ] **Step 1: Add the data model constants**

Insert directly after the `ROUTER_ROWS` array (after line 2472, before `function makeSourceSelect`):

```javascript
// Router's own input indices 1-6 → the 6 signals produced by OUTPUT_STRIPS processing
const OUTPUT_ROUTER_SOURCES = {
  1: 'Mains L',   2: 'Mains R',
  3: 'Zoom TX L', 4: 'Zoom TX R',
  5: 'Rec L',     6: 'Rec R',
};

// Router's own output indices 1-16 → physical destination, in the order given
const OUTPUT_ROUTER_ROWS = [
  { label: 'Line 1',  out: 1 },  { label: 'Line 2',  out: 2 },
  { label: 'Line 3',  out: 3 },  { label: 'Line 4',  out: 4 },
  { label: 'Line 5',  out: 5 },  { label: 'Line 6',  out: 6 },
  { label: 'Line 7',  out: 7 },  { label: 'Line 8',  out: 8 },
  { label: 'Dante 1', out: 9 },  { label: 'Dante 2', out: 10 },
  { label: 'Dante 3', out: 11 }, { label: 'Dante 4', out: 12 },
  { label: 'Dante 5', out: 13 }, { label: 'Dante 6', out: 14 },
  { label: 'Dante 7', out: 15 }, { label: 'Dante 8', out: 16 },
];
```

- [ ] **Step 2: Add `makeOutputRouterSelect`**

Insert directly after the existing `makeSourceSelect` function (after line 2492, before `function buildPatchTab`):

```javascript
function makeOutputRouterSelect(outputN) {
  const select = document.createElement('select');
  select.className = 'router-select';
  select.dataset.output = outputN;
  for (let inp = 1; inp <= 6; inp++) {
    const opt = document.createElement('option');
    opt.value = inp;
    opt.textContent = OUTPUT_ROUTER_SOURCES[inp];
    select.appendChild(opt);
  }
  select.addEventListener('change', function() {
    const outN = this.dataset.output;
    const newInN = parseInt(this.value);
    QRC.component.set('Output.Router', [{ Name: `output.${outN}.input.${newInN}.select`, Value: true }]);
  });
  return select;
}
```

- [ ] **Step 3: Extend `buildPatchTab()` to populate the Output Router table**

Insert directly before the closing `}` of `buildPatchTab()` (after the existing Router table `ROUTER_ROWS.forEach(...)` block ends, i.e. after line 2539's closing `});`):

```javascript

  // Output Router table
  const outputTbody = document.getElementById('output-router-tbody');
  outputTbody.innerHTML = '';
  OUTPUT_ROUTER_ROWS.forEach(function(row) {
    const tr = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.className = 'router-label';
    labelCell.textContent = row.label;
    tr.appendChild(labelCell);

    const selectCell = document.createElement('td');
    selectCell.appendChild(makeOutputRouterSelect(row.out));
    tr.appendChild(selectCell);
    outputTbody.appendChild(tr);
  });
```

- [ ] **Step 4: Verify the file still parses as valid JS**

Run: `node --check <(sed -n '/^<script>$/,/^<\/script>$/p' assets/uci/foh-uci.html | sed '1d;$d')` for the PATCH tab's `<script>` block specifically:
```bash
awk '/<!-- ── PATCH tab/{f=1} f{print} /^<\/script>$/{if(f){exit}}' assets/uci/foh-uci.html | sed '1d;$d' | node --check
```
Expected: no output (exit code 0)

- [ ] **Step 5: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Add Output Router data model and buildPatchTab wiring"
```

---

### Task 3: Extend loadPatchState() to read back Output.Router state

**Files:**
- Modify: `assets/uci/foh-uci.html:2542-2565` (`loadPatchState()`)

**Interfaces:**
- Consumes: `#output-router-tbody [data-output="N"]` selects created by Task 2's `buildPatchTab()` extension.
- Produces: nothing new consumed downstream — this is the terminal task.

- [ ] **Step 1: Add the independent Output.Router GetControls call**

Insert directly after the existing `Input.Router` block's `.catch(...)` line (after line 2564, before the closing `}` of `loadPatchState()`):

```javascript

  QRC.call('Component.GetControls', { Name: 'Output.Router' })
    .then(function(r) {
      const controls = r?.Controls ?? [];
      controls.forEach(function(c) {
        if (!c.Value) return;
        const match = c.Name.match(/^output\.(\d+)\.input\.(\d+)\.select$/);
        if (!match) return;
        const select = document.querySelector(`#output-router-tbody [data-output="${match[1]}"]`);
        if (select) select.value = match[2];
      });
    })
    .catch(e => console.error('[OutputRouter] loadPatchState error:', e.message));
```

- [ ] **Step 2: Verify the PATCH tab script still parses**

Run:
```bash
awk '/<!-- ── PATCH tab/{f=1} f{print} /^<\/script>$/{if(f){exit}}' assets/uci/foh-uci.html | sed '1d;$d' | node --check
```
Expected: no output (exit code 0)

- [ ] **Step 3: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Read back Output.Router state in loadPatchState"
```

---

### Task 4: Manual in-browser verification

**Files:** none (verification only)

- [ ] **Step 1: Open `foh-uci.html` in a browser (or via the project's normal preview method) and navigate to the Patch tab**

Confirm "Output Router" renders below "Input Router" with 16 rows in this exact order: Line 1–8, Dante 1–8, each with a single `<select>` offering exactly 6 options (Mains L, Mains R, Zoom TX L, Zoom TX R, Rec L, Rec R).

- [ ] **Step 2: Change a dropdown and inspect the network/console call**

Confirm a `Component.Set` call fires with `Name: "output.<N>.input.<M>.select"` and `Value: true`, where `N` matches the row's `out` index and `M` matches the selected option's value.

- [ ] **Step 3: Reload the page**

Confirm each Output Router row's dropdown reflects the live state read back from `Output.Router` via `Component.GetControls`, independently of whatever the Input Router section shows.
