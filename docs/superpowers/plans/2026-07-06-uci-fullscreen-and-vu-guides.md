# UCI Fullscreen Toggle + VU Meter dB Guides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fullscreen toggle button to the UCI nav bar, and add static dB tick-mark guides to every VU meter (input/bus/output strips get 0/-6/-20/-40dB ticks with "0" labeled; the dense drawer overview gets a 0dB tick only).

**Architecture:** Everything lives in the single file `assets/uci/foh-uci.html` (existing convention — this file is a self-contained page with inline `<style>` and `<script>`, no build step, no test framework). A shared JS helper computes tick position as a fraction of the existing `VU_MIN_DB`/`VU_MAX_DB` scale and appends static tick elements once per VU meter at creation time; segment coloring logic (which runs on every level update) is untouched. The fullscreen button uses the standard Fullscreen API with a Safari-prefixed fallback.

**Tech Stack:** Vanilla JS, inline CSS, no dependencies. No test runner exists in this repo for this file — verification is done via the Preview browser tools (DOM snapshot, `preview_eval`, screenshots), same approach used earlier this session.

## Global Constraints

- Single file: all changes go in `assets/uci/foh-uci.html`.
- Follow existing code style: `const`/`let`, no semicolons-optional inconsistency (file mixes both — match the surrounding block), CSS custom properties from `:root` (e.g. `var(--vu-clip)`, `var(--border)`), text-labeled buttons (not bare icons) matching the existing `#sends-exit` ("Exit sends mode") convention.
- Do not touch QRC control routing, mute logic, or fader behavior — this plan only adds a nav button and static visual overlays.
- `.vu-col` (used by bus and output strips) currently has **no CSS rule at all** — it's an existing bug (bus/output VU meters render invisible, confirmed via screenshot: the BUSES tab shows no VU column next to any fader). Task 3 must add the missing base styling (mirroring `.vu-meter`) before ticks can be added to it, since ticks are positioned relative to the meter's own box.

---

### Task 1: Fullscreen toggle button

**Files:**
- Modify: `assets/uci/foh-uci.html:185-194` (`#tab-bar` CSS, add button style)
- Modify: `assets/uci/foh-uci.html:882-888` (tab bar HTML, add button)
- Modify: `assets/uci/foh-uci.html:1808` (after the tab-switching block, add fullscreen JS)

**Interfaces:**
- Produces: no exports — self-contained click handler + `fullscreenchange` listener. No other task depends on this one.

- [ ] **Step 1: Add the button markup**

In `assets/uci/foh-uci.html`, change lines 882-888 from:

```html
<div id="tab-bar">
  <button class="tab-btn active" data-tab="inputs">Inputs</button>
  <button class="tab-btn"        data-tab="buses">Buses</button>
  <button class="tab-btn"        data-tab="outputs">Outputs</button>
  <button class="tab-btn"        data-tab="routing">Routing</button>
  <button class="tab-btn"        data-tab="patch">Patch</button>
</div>
```

to:

```html
<div id="tab-bar">
  <button class="tab-btn active" data-tab="inputs">Inputs</button>
  <button class="tab-btn"        data-tab="buses">Buses</button>
  <button class="tab-btn"        data-tab="outputs">Outputs</button>
  <button class="tab-btn"        data-tab="routing">Routing</button>
  <button class="tab-btn"        data-tab="patch">Patch</button>
  <button id="fullscreen-btn" class="fullscreen-btn">Full Screen</button>
</div>
```

- [ ] **Step 2: Add the button's CSS**

In `assets/uci/foh-uci.html`, right after the `.tab-btn.stub` rule (line 211: `.tab-btn.stub { opacity: 0.4; cursor: default; }`), add:

```css
  .fullscreen-btn {
    margin-left: auto;
    padding: 6px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: transparent;
    color: var(--subdued);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }
  .fullscreen-btn.active {
    color: var(--text);
    background: var(--bg);
  }
```

- [ ] **Step 3: Add the fullscreen JS logic**

In `assets/uci/foh-uci.html`, right after the tab-switching block (after line 1808, which is the closing `});` of the `.tab-btn` click-handler `forEach`), add:

```js
// ── Fullscreen toggle ──────────────────────────────────────────────────────────
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}
function exitFullscreen() {
  if (document.exitFullscreen) document.exitFullscreen();
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}
const fullscreenBtn = document.getElementById('fullscreen-btn');
fullscreenBtn.addEventListener('click', () => {
  if (isFullscreen()) exitFullscreen();
  else enterFullscreen();
});
function refreshFullscreenBtn() {
  const active = isFullscreen();
  fullscreenBtn.classList.toggle('active', active);
  fullscreenBtn.textContent = active ? 'Exit Full Screen' : 'Full Screen';
}
document.addEventListener('fullscreenchange', refreshFullscreenBtn);
document.addEventListener('webkitfullscreenchange', refreshFullscreenBtn);
```

- [ ] **Step 4: Verify in the Preview browser**

Load `foh-uci.html` in the preview server (see project's existing `.claude/launch.json` config `uci-static-preview`, port 4173). Run via `preview_eval`:

```js
document.getElementById('fullscreen-btn').textContent
```

Expected: `"Full Screen"`.

Then click the button (`preview_click` with selector `#fullscreen-btn`) and check via `preview_eval`:

```js
!!document.fullscreenElement
```

Expected: `true` (or, if the headless preview browser blocks programmatic fullscreen due to lacking a user-gesture context, confirm instead that `enterFullscreen()` was invoked without throwing — check `preview_console_logs` for errors). Take a `preview_screenshot` to visually confirm the button reads "Full Screen" in the nav bar, right-aligned.

- [ ] **Step 5: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Add fullscreen toggle button to UCI nav bar"
```

---

### Task 2: Shared VU tick helper + apply to input strips

**Files:**
- Modify: `assets/uci/foh-uci.html:432-437` (`.vu-seg` CSS block, add tick CSS after it)
- Modify: `assets/uci/foh-uci.html:425-431` (`.vu-meter` CSS, add `position: relative`)
- Modify: `assets/uci/foh-uci.html` near line 1506-1513 (`VU_SEGS`/`dbToSegments` block — add new helper functions after `dbToSegments`)
- Modify: `assets/uci/foh-uci.html:1644-1653` (input strip VU creation — call the new helper)

**Interfaces:**
- Produces: `dbToVuFrac(db)` — returns a 0..1 float (fraction of meter height from the bottom). `addVuTicks(vuEl, dbValues, showZeroLabel)` — appends static tick elements to `vuEl`; the caller's container class must already have `position: relative` in CSS (this function does not set it) so the absolutely-positioned ticks land correctly; `dbValues` is an array of dB numbers to mark; `showZeroLabel` is a boolean controlling whether a "0" text label is added at the 0dB tick. Both are used by Tasks 3 and 4 — do not rename.

- [ ] **Step 1: Add `position: relative` to `.vu-meter`**

In `assets/uci/foh-uci.html`, change (lines 425-431):

```css
  .vu-meter {
    width: 10px;
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    align-self: stretch;
  }
```

to:

```css
  .vu-meter {
    width: 10px;
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    align-self: stretch;
    position: relative;
  }
```

- [ ] **Step 2: Add tick CSS**

Right after the `.vu-seg` rule (line 437: `}` closing `.vu-seg`), add:

```css
  .vu-tick {
    position: absolute;
    left: -3px;
    width: 6px;
    height: 1px;
    background: var(--border);
    pointer-events: none;
  }
  .vu-tick-zero {
    background: var(--vu-clip);
    height: 2px;
  }
  .vu-tick-label {
    position: absolute;
    left: 8px;
    font-size: 7px;
    line-height: 1;
    color: var(--vu-clip);
    font-weight: 700;
    transform: translateY(50%);
    pointer-events: none;
  }
```

- [ ] **Step 3: Add the `dbToVuFrac` and `addVuTicks` helpers**

In `assets/uci/foh-uci.html`, right after the `dbToSegments` function (the block currently reading):

```js
const VU_SEGS   = 20;
const VU_MIN_DB = -60;
const VU_MAX_DB = 10;
const VU_MID_DB = -6;   // amber starts here
const VU_CLIP_DB = 0;   // red starts here
function dbToSegments(db) {
  const clamped = Math.max(VU_MIN_DB, Math.min(VU_MAX_DB, db));
  return Math.round(((clamped - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB)) * VU_SEGS);
}
```

add:

```js
// Fraction (0..1) of meter height for a given dB value, for static tick placement.
function dbToVuFrac(db) {
  const clamped = Math.max(VU_MIN_DB, Math.min(VU_MAX_DB, db));
  return (clamped - VU_MIN_DB) / (VU_MAX_DB - VU_MIN_DB);
}
// Appends static dB tick marks to a VU meter container. dbValues: e.g. [0, -6, -20, -40].
// showZeroLabel: whether to add a "0" text label at the 0dB tick.
function addVuTicks(vuEl, dbValues, showZeroLabel) {
  dbValues.forEach(db => {
    const tick = document.createElement('div');
    tick.className = db === 0 ? 'vu-tick vu-tick-zero' : 'vu-tick';
    tick.style.bottom = (dbToVuFrac(db) * 100) + '%';
    vuEl.appendChild(tick);
  });
  if (showZeroLabel) {
    const label = document.createElement('div');
    label.className = 'vu-tick-label';
    label.style.bottom = (dbToVuFrac(0) * 100) + '%';
    label.textContent = '0';
    vuEl.appendChild(label);
  }
}
```

- [ ] **Step 4: Apply ticks to input strip VU meters**

In `assets/uci/foh-uci.html`, change (lines 1644-1653):

```js
    // VU meter
    const vu = document.createElement('div');
    vu.className = 'vu-meter';
    vu.id = 'vu-' + ch.id;
    for (let s = 0; s < VU_SEGS; s++) {
      const seg = document.createElement('div');
      seg.className = 'vu-seg';
      vu.appendChild(seg);
    }
    faderVuRow.appendChild(vu);
```

to:

```js
    // VU meter
    const vu = document.createElement('div');
    vu.className = 'vu-meter';
    vu.id = 'vu-' + ch.id;
    for (let s = 0; s < VU_SEGS; s++) {
      const seg = document.createElement('div');
      seg.className = 'vu-seg';
      vu.appendChild(seg);
    }
    addVuTicks(vu, [0, -6, -20, -40], true);
    faderVuRow.appendChild(vu);
```

- [ ] **Step 5: Verify in the Preview browser**

Reload `foh-uci.html` in the preview, switch to the INPUTS tab (default), then via `preview_eval`:

```js
document.querySelectorAll('#vu-mic1 .vu-tick').length
```

Expected: `4` (0, -6, -20, -40).

```js
document.querySelector('#vu-mic1 .vu-tick-zero').style.bottom
```

Expected: `"85.71428571428571%"` (i.e. `(0 - (-60)) / (10 - (-60))`).

Take a `preview_screenshot` of the INPUTS tab and visually confirm small tick lines are visible to the left of each channel's VU meter, with a "0" label at the topmost tick.

- [ ] **Step 6: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Add dB tick guides to input strip VU meters"
```

---

### Task 3: Fix `.vu-col` styling and apply ticks to bus + output strips

**Files:**
- Modify: `assets/uci/foh-uci.html` near line 425 (add new `.vu-col` CSS rule alongside `.vu-meter`)
- Modify: `assets/uci/foh-uci.html:2059-2067` (bus strip VU creation)
- Modify: `assets/uci/foh-uci.html:2307-2310` (output strip VU creation)

**Interfaces:**
- Consumes: `addVuTicks(vuEl, dbValues, showZeroLabel)` from Task 2 — must already exist in the file.
- Produces: nothing new — no later task depends on this one.

- [ ] **Step 1: Add missing `.vu-col` base styling**

`.vu-col` (used by bus and output strips) currently has zero CSS rules, so those VU meters render with no size and are invisible (confirmed via screenshot — the BUSES tab shows no meter next to any fader). Add a rule mirroring `.vu-meter`. Right after the `.vu-meter` rule (after the closing `}` at line 431, before `.vu-seg` at line 432), add:

```css
  .vu-col {
    width: 10px;
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    align-self: stretch;
    position: relative;
  }
```

- [ ] **Step 2: Apply ticks to bus strip VU meters**

In `assets/uci/foh-uci.html`, change (lines 2059-2067):

```js
    const vu = document.createElement('div');
    vu.className = 'vu-col';
    vu.id = 'busVU-' + bus.id;
    for (let s = 0; s < VU_SEGS; s++) {
      const seg = document.createElement('div');
      seg.className = 'vu-seg';
      vu.appendChild(seg);
    }
```

to:

```js
    const vu = document.createElement('div');
    vu.className = 'vu-col';
    vu.id = 'busVU-' + bus.id;
    for (let s = 0; s < VU_SEGS; s++) {
      const seg = document.createElement('div');
      seg.className = 'vu-seg';
      vu.appendChild(seg);
    }
    addVuTicks(vu, [0, -6, -20, -40], true);
```

(Verify the exact surrounding lines with `grep -n "busVU-" assets/uci/foh-uci.html` before editing — this task follows Task 2's edits, which may have shifted line numbers earlier in the file, though this block is well after them so line numbers should be unaffected.)

- [ ] **Step 3: Apply ticks to output strip VU meters**

In `assets/uci/foh-uci.html`, change (lines 2307-2310):

```js
    const vu = document.createElement('div');
    vu.className = 'vu-col'; vu.id = 'out-vu-' + stripDef.id;
    for (let s = 0; s < VU_SEGS; s++) { const seg = document.createElement('div'); seg.className = 'vu-seg'; vu.appendChild(seg); }
    faderVuRow.appendChild(vu);
```

to:

```js
    const vu = document.createElement('div');
    vu.className = 'vu-col'; vu.id = 'out-vu-' + stripDef.id;
    for (let s = 0; s < VU_SEGS; s++) { const seg = document.createElement('div'); seg.className = 'vu-seg'; vu.appendChild(seg); }
    addVuTicks(vu, [0, -6, -20, -40], true);
    faderVuRow.appendChild(vu);
```

- [ ] **Step 4: Verify in the Preview browser**

Reload, click the BUSES tab (`preview_click` with selector `[data-tab="buses"]`), then `preview_screenshot` to confirm VU meters are now visible next to each bus fader with tick guides. Repeat for OUTPUTS tab (`[data-tab="outputs"]`).

Via `preview_eval`, confirm no console errors:

```js
document.querySelectorAll('.vu-col .vu-tick').length
```

Expected: a positive number matching `4 ticks × (number of bus strips + number of output strips)`.

- [ ] **Step 5: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Fix invisible .vu-col styling and add dB tick guides to bus/output VU meters"
```

---

### Task 4: Apply 0dB-only tick to the drawer overview meters

**Files:**
- Modify: `assets/uci/foh-uci.html:3133-3143` (drawer VU creation, inside `buildDrawerContent`)
- Modify: `assets/uci/foh-uci.html` near line 854-861 (`.meter-col-vu` CSS, add `position: relative`)

**Interfaces:**
- Consumes: `addVuTicks(vuEl, dbValues, showZeroLabel)` from Task 2.
- Produces: nothing new — this is the last task.

- [ ] **Step 1: Add `position: relative` to `.meter-col-vu`**

In `assets/uci/foh-uci.html`, change (lines 854-861):

```css
  .meter-col-vu {
    width: 5px;
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    flex: 1 1 0;
    min-height: 0;
  }
```

to:

```css
  .meter-col-vu {
    width: 5px;
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    flex: 1 1 0;
    min-height: 0;
    position: relative;
  }
```

- [ ] **Step 2: Apply a 0dB-only tick, no label, to drawer meters**

In `assets/uci/foh-uci.html`, inside `buildDrawerContent`, change (lines 3133-3143):

```js
      ch.meterCh.forEach(function(chIdx) {
        const vu = document.createElement('div');
        vu.className = 'meter-col-vu';
        vu.id = 'drawer-vu-' + chIdx;
        for (var s = 0; s < VU_SEGS_DRAWER; s++) {
          const seg = document.createElement('div');
          seg.className = 'vu-seg';
          vu.appendChild(seg);
        }
        barsDiv.appendChild(vu);
      });
```

to:

```js
      ch.meterCh.forEach(function(chIdx) {
        const vu = document.createElement('div');
        vu.className = 'meter-col-vu';
        vu.id = 'drawer-vu-' + chIdx;
        for (var s = 0; s < VU_SEGS_DRAWER; s++) {
          const seg = document.createElement('div');
          seg.className = 'vu-seg';
          vu.appendChild(seg);
        }
        addVuTicks(vu, [0], false);
        barsDiv.appendChild(vu);
      });
```

- [ ] **Step 3: Verify in the Preview browser**

The drawer overview is opened via whatever UI trigger calls `buildDrawerContent()` — confirm with `grep -n "buildDrawerContent()" assets/uci/foh-uci.html` to find the open trigger (likely a button in the status bar) and click it via `preview_click`. Then via `preview_eval`:

```js
document.querySelectorAll('.meter-col-vu .vu-tick').length
```

Expected: one tick per drawer channel-meter (`DRAWER_CHANNELS` entries × meters per entry — mono channels have 1, stereo have 2).

```js
document.querySelectorAll('.meter-col-vu .vu-tick-label').length
```

Expected: `0` (no labels in the drawer).

Take a `preview_screenshot` to visually confirm the drawer shows a small 0dB line on each meter without clutter.

- [ ] **Step 4: Commit**

```bash
git add assets/uci/foh-uci.html
git commit -m "Add 0dB tick to drawer overview VU meters"
```
