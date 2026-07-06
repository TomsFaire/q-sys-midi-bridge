# Configurable UCI Port + Browser-Based MIDI Mappings

## Context

Two independent gaps in the app today:
1. The UCI web server's port (`config.uci.port`, default `3001`) can only be changed by hand-editing `config.json`. There's no UI field for it, which makes it awkward to know/track what port to open in a firewall.
2. MIDI-to-Q-Sys mappings can only be viewed/edited in the desktop Configurator (an Electron `BrowserWindow`). There's no way to manage them from a browser, so remapping requires physical/remote-desktop access to the machine running the bridge.

Both features build on the existing `UciServer` (`src/main/uci-server.ts`) and Configurator (`src/main/configurator.ts`) code.

## 1. Configurable UCI port

- Add an editable port number field to the Configurator's Network panel (`src/renderer/configurator.html`), next to the existing UCI enable/disable toggle.
- New IPC handler `cfg:set-uci-port` (mirrors the existing `cfg:set-uci-enabled` pattern):
  - Validates the value is an integer in `1–65535`.
  - Writes it to `config.uci.port` in `config.json`.
  - Returns a validation error (shown inline in the panel) for out-of-range or non-numeric input.
- The server does **not** rebind live. After a successful save, show "Restart required for the new port to take effect" with a **Restart Now** button that calls `app.relaunch()` followed by `app.exit()`.
- No other behavior changes — LAN URL display, "Copy UCI Link", etc. continue to read from `config.uci.port` as they do today.

## 2. Browser-based MIDI mappings page

New route `/mappings` served by the existing `UciServer`, on the same host/port as the FOH UCI. Full edit parity with the desktop Configurator: view, edit, save, and save-and-apply mappings from any browser on the LAN.

### Shared mapping service (refactor)

Mapping data (`PHYSICAL_CONTROLS`, `config.mappings` read/write, and the save-and-apply logic) currently lives only inside `configurator.ts`'s IPC handlers. Extract this into a new `src/main/mapping-service.ts` with plain functions (e.g. `getPhysicalControls()`, `getMappings()`, `saveMappings(mappings)`, `saveAndApplyMappings(mappings)`, `discoverComponents()`, `getComponentControls(name)`). Both the existing IPC handlers and the new HTTP routes call into this shared module — no logic duplicated between the desktop and web paths.

### Auth

Mapping edits affect live Q-Sys control, so the page is password-gated:
- A "Mappings page password" field is added to the Configurator's Network panel. On save, it's hashed with Node's built-in `crypto.scrypt` (no new dependency) and the hash stored in `config.json` (e.g. `config.uci.mappingsPasswordHash`). The plaintext is never persisted.
- `/mappings` serves a login form when there's no valid session. `POST /api/mappings/login` checks the submitted password against the stored hash (constant-time compare) and, on success, issues a random session token (`crypto.randomBytes`) stored server-side in an in-memory `Map` with a 24-hour TTL, set as an `HttpOnly` cookie.
- All other `/api/mappings/*` and `/api/qsys/*` routes require a valid session cookie; missing/invalid/expired → `401`.
- Wrong password → generic `401` ("Incorrect password"), no distinguishing detail.
- If no password has been configured yet, `/mappings` shows a setup notice directing the user to set one in the Configurator, rather than allowing unauthenticated access.

### HTTP API (all under session auth except login)

- `POST /api/mappings/login` — `{ password }` → sets session cookie.
- `GET /api/mappings` — returns `{ physicalControls, mappings }` for rendering the table.
- `POST /api/mappings` — body: updated mappings array → validates shape, writes to `config.json` (save only, no live apply).
- `POST /api/mappings/apply` — save + re-run the mapping engine live (equivalent to desktop "Save & Apply").
- `GET /api/qsys/components` — proxies `discoverComponents()`.
- `GET /api/qsys/components/:name/controls` — proxies `getComponentControls()`.

### Frontend

New static page `assets/mappings/mappings.html`: same tab-by-group / table layout as the desktop Configurator, plain HTML/CSS/JS using `fetch` against the API above instead of Electron IPC. Reuses the visual structure of `configurator.html` but is a separate file (no Electron APIs available in a browser context).

### Error handling

- Q-Sys unreachable during component discovery: inline error in the page; manual text entry for component/control names still works (matches existing Configurator fallback).
- Concurrent edits from multiple browsers/desktop Configurator: last write to `config.json` wins. No locking — same single-file model as today.

## Explicitly out of scope

- No live rebinding of the UCI server when the port changes — restart required.
- No per-user accounts or role-based permissions for the mappings page — single shared password.
- No changes to the FOH mixer UI (`/foh-uci`) itself.
- No rate-limiting or lockout on login attempts (LAN-only threat model, consistent with the FOH UCI's existing no-auth trust model).
