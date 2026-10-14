# Shared mapping editor

**Date:** 2026-10-05
**Status:** approved, pending implementation plan

## Problem

The mapping table exists twice. `assets/mappings/mappings.html` serves the
browser page at `/mappings`; `src/renderer/configurator.html` is the desktop
Configurator window. Each holds its own copy of the same state map, table
render, event delegation, tab/filter logic and `buildMappings`.

They have drifted in both directions:

| | web `/mappings` | desktop Configurator |
|---|---|---|
| stereo Link UI | yes | no |
| password login | yes | n/a |
| `guessRange` — min/max from control name | no | yes |
| `refreshRow` — update one row, not the table | no | yes |
| `setOverlay` — loading states | no | yes |

The cost is not hypothetical. Adding `qsys.link` (v0.2.10) to the web editor
alone meant the desktop Configurator, which rewrites the entire mappings array
on save, silently dropped every gang. That was caught by a test written only
because the duplication was noticed mid-change. The next field will cost the
same tax, and the next reviewer may not notice.

The backend is already shared: `mapping-service.ts` owns the physical-control
list, load/save, validation and Q-SYS discovery, and both `configurator.ts`
(IPC) and `mappings-http.ts` (HTTP) call into it. Only the front end is
duplicated.

## Goal

One editor UI used by both hosts, so a mapping feature lands once. Network
controls stay desktop-only.

Success criteria:

1. The stereo Link UI, `guessRange`, `refreshRow` and overlay/status behaviour
   are available in both hosts.
2. Both hosts produce byte-identical `buildMappings` output to what they
   produce today, for the fixture set in *Verification* below.
3. Adding a field to `QsysRef` requires editing one editor, not two.
4. The editor is testable in Node without loading HTML into a `vm`.

Out of scope: the Network panel, the login flow, anything in
`mapping-service.ts`, and the `qsys.link` feature itself (already shipped).

## Constraint that drives the design

The desktop renderer is loaded with `BrowserWindow.loadFile`, so it runs on
`file://` with `nodeIntegration: true`. Chromium blocks ES module imports over
`file://` (CORS), so the shared code cannot be an ES module. A classic
`<script src>` is unrestricted there and works identically when served over
HTTP, so that is the sharing mechanism.

`package.json` already packages `src/renderer/**/*` and `assets/**/*`, so a
file under `assets/shared/` ships in the app bundle with no build change.

## Architecture

Three files replace the duplicated halves of two.

### `assets/shared/mapping-editor.js`

A classic script setting one global, `window.MappingEditor`, with one entry
point:

```js
const editor = await MappingEditor.mount({ root, adapter, onStatus })
```

It owns: the `assignments` state map, table render, group headers, tabs and
filter, event delegation, `guessRange`, `refreshRow`, the Link checkbox and
linked-leg row, and `buildMappings` including the `withLink` emission rules.

`root` receives the tabs, filter bar and table — the three regions that are
identical in both pages today. Everything around `root` belongs to the host.

The returned handle is small:

```js
editor.save()          // adapter.save(buildMappings())
editor.saveAndApply()  // adapter.saveAndApply(buildMappings())
editor.reload()        // re-run discovery, re-render
editor.getMappings()   // buildMappings(), for hosts that need it directly
```

Hosts keep their own buttons and wire them to these, so the chrome stays local
while the logic stays shared.

### `assets/shared/mapping-editor.css`

The table, badges, row states and link row. Both pages already define an
identical `:root` token set (same names, same hex values), so this lifts
cleanly. Each page keeps its own chrome styles — login card, Network panel,
header, footer — in its own `<style>`.

### The adapter

The only thing each host supplies. Six async methods:

```js
{
  loadEditorState(),            // → { physicalControls, mappings }
  getQsysStatus(),              // → { connected, message }
  discoverComponents(),         // → [{ name, type }]
  getComponentControls(name),   // → [{ name, isBoolean }]
  save(mappings),               // → { count }
  saveAndApply(mappings),       // → { count }
}
```

Desktop wraps `ipcRenderer.invoke`; web wraps `fetch`.

Two deliberate shaping decisions:

- `loadEditorState` collapses the desktop's current two calls
  (`cfg:get-physical-controls` + `cfg:load-config`) into the single shape the
  web endpoint already returns. One fewer round trip, one less thing to keep in
  step.
- `getQsysStatus` is the one method added rather than moved. The desktop has
  `cfg:get-qsys-status`; the web has no equivalent and infers connectivity from
  whether discovery threw. The web adapter synthesises it, which lets the
  shared editor render one consistent "Q-SYS not connected" state in both
  hosts.

### What each host keeps

`mappings.html`: login card, session handling, fetch adapter, status line.

`configurator.html`: Network panel (host, UCI enable/port, mappings password,
restart), `setOverlay`, footer, IPC adapter. Untouched by this work — it has
one consumer and moving it is scope we do not need.

## Data flow

1. Host builds its adapter and calls `MappingEditor.mount`.
2. `mount` calls `adapter.loadEditorState()`, then `adapter.getQsysStatus()`,
   then `adapter.discoverComponents()` if connected.
3. Editor renders tabs, filter and table into `root`.
4. User edits mutate `assignments`; the touched row is re-rendered via
   `refreshRow` rather than rebuilding the table.
5. Host's Save / Save & Apply buttons call `editor.save()` /
   `editor.saveAndApply()`, which run `buildMappings()` and hand the result to
   the adapter.

## Error handling

Adapter methods throw. The editor catches at its boundary and reports through
one `onStatus({ kind, text })` callback rather than touching DOM it does not
own. Web maps that to `#save-status`; desktop maps it to its status line and
`setOverlay`, so the desktop keeps its loading overlay without the editor
knowing overlays exist.

Q-SYS being unreachable is not an error state. Both pages already fall back to
free-text entry for control names, and the shared editor preserves that — the
mappings must stay editable with the Core offline, which is the normal case
when configuring before the rack is up.

## Testing

Today both editors are tested by reading the HTML, regexing out the `<script>`,
running it in a `vm` against a hand-rolled fake DOM, and reaching inside via an
injected shim. That harness produced three bugs of its own during the v0.2.10
work: cross-realm `deepStrictEqual` failures, a missing `cells` stub, and a
`fetch` stub whose shape did not match the real server's.

A module with an injected fake adapter removes all of it. `mapping-editor.test.ts`
covers:

- load → render → save round-trip, for both adapters' shapes
- Link emission: component-only, control-only, both, and ticked-but-unfilled
- stale-link clearing when the primary component is repointed
- `guessRange` suggestions per control-name pattern
- `save` vs `saveAndApply` dispatching to the right adapter method
- adapter rejection surfacing through `onStatus`
- Q-SYS offline still rendering an editable table

`mappings-editor-link.test.ts` and `configurator-link.test.ts` collapse into it.

A minimal DOM stub is still needed, but it belongs to one test file instead of
two and is no longer entangled with script extraction.

## Verification that this is a true refactor

The real risk is a silent behaviour change reaching a live `config.json`.
Before either page is modified, capture the exact `buildMappings` output of
both current editors across a fixture set:

- plain knob, plain fader, plain toggle
- ganged knob: component-only link, control-only link, both fields
- ganged toggle
- link ticked but unfilled
- assignment with no control name (skipped entirely)
- label present and label absent

The shared editor must reproduce both hosts' output exactly for every fixture.
These become golden tests, not throwaway scaffolding.

Note this does not conflict with the `guessRange` change below. The fixtures
feed a *fixed assignment* through `buildMappings`; `guessRange` runs earlier,
when the user first sets a control name on a row, and only mutates the
suggested min/max in `assignments`. Same assignment in, same mapping out —
what changes is only what the UI proposes before the user commits.

## Deliberate behaviour changes

Two, flagged rather than smuggled:

1. **The web page gains `guessRange`.** Setting a control name for the first
   time auto-suggests min/max from the name — `freq`/`hz` → 20/20000,
   `threshold` → −40/0, `ratio` → 1/20, and so on — instead of always
   defaulting to −100/10. This is today's desktop behaviour and is better, but
   the web page will propose different numbers than it used to. It only fires
   on a row with no control name yet, and never on a toggle row, whose min/max
   inputs are disabled.
2. **The web page gains targeted row refresh.** It currently rebuilds the whole
   table on every change, which drops input focus mid-edit. It will adopt the
   desktop's `refreshRow`.

Both were raised and accepted during design.

## Risks

- **Scope creep into the Network panel.** Mitigation: it is explicitly out of
  scope and stays inline in `configurator.html`.
- **The desktop window silently breaking**, since it has no automated
  end-to-end coverage and is only exercised by launching the app. Mitigation:
  the golden `buildMappings` tests cover the data path; the render path needs a
  manual smoke test of the Configurator window before merge.
- **`file://` script loading path differences** between dev (`app.getAppPath()`)
  and a packaged bundle. Mitigation: verify the relative `<script src>` resolves
  in a packaged build, not only in `npm start`.
