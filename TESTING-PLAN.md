# MIDI Q-SYS Bridge — Testing Plan
*Session date: 2026-06-30 · Core IP: 10.4.84.20*

---

## What's testable today vs. what's blocked

**Testable now** — Input.Mixer faders, mutes, LED feedback, Matrix.Mains and Matrix.ZoomTX gain/mute.

**Blocked until Designer rebuild** — Row A trim knobs (Mic.01.Gain–Mic.08.Gain), Row B HPF knobs (Mic.01.HPF–Mic.08.HPF), Row C compressor knobs (BusMicRoom.Comp / BusMicZoom.Comp). These components live inside Channel Groups and aren't QRC-addressable yet. Config entries are already correct and commented out — just uncomment after rebuild.

---

## Part 1 — Environment setup

Do these before running any tests.

**1. Mac on the right network**
The Core is at `10.4.84.20`. Make sure the Mac running the bridge is on the same subnet. Quick check:
```bash
ping 10.4.84.20
```
Should reply in <5ms. If not, check WiFi — you need to be on the same VLAN as the Core.

**2. Connect the MIDImix via USB**
Plug it in before launching the app. The bridge detects MIDI devices at startup (it does not hot-reload on device plug).

**3. Launch the bridge**
```bash
cd ~/Documents/Claude/midi-qsys-bridge
npm run rebuild-midi    # only needed first run, or after Electron updates
npm start
```
The tray icon appears in the menu bar. Click it to see connection status.

**4. Confirm both connections**
Tray should show:
- ✓ Q-SYS: Connected to 10.4.84.20:1710
- ✓ MIDI: MIDI Mix connected

If either shows disconnected, see Troubleshooting at the bottom.

---

## Part 2 — Tests (run in order)

### Test 1 — Channel faders 1–8

**What:** MIDImix faders → `Input.Mixer` `input.{n}.gain`

**How to test:**
1. In Q-SYS Designer, open the running design and double-click `Input.Mixer` to open its controls panel
2. Move fader 1 on the MIDImix (leftmost fader)
3. Watch `input.1.gain` update in the Designer panel
4. Repeat for faders 2–8

**Pass:** Each fader movement causes the matching gain control to update. The range is −100 dB (fader bottom) to +10 dB (fader top).

**Note:** Unity (0 dB) is at approximately CC 116 of 127 — the fader will feel like it's "almost at the top" at unity. This is correct; the range is asymmetric to allow fine control in the normal operating range.

---

### Test 2 — Channel mutes 1–8

**What:** MIDImix mute buttons → `Input.Mixer` `input.{n}.mute` toggle

**How to test:**
1. Press mute button for channel 1 (bottom row of buttons, leftmost)
2. Confirm `input.1.mute` goes to 1 in Designer
3. Press again — should toggle back to 0
4. LED on the MIDImix should light when muted, off when unmuted

**Pass:** Toggle works; LED state matches Q-SYS mute state.

---

### Test 3 — LED feedback sync (bidirectional)

**What:** Q-SYS pushes mute state back to MIDImix LEDs via ChangeGroup poll

**How to test:**
1. In Q-SYS Designer, manually click `input.1.mute` to mute channel 1 (not from MIDI)
2. Within ~50ms, the MIDImix mute LED for channel 1 should light
3. Unmute in Designer — LED goes off

**Pass:** LED tracks Q-SYS state changes that originate outside the controller (Designer, UCI, Lua scripts).

**Why this matters:** If a presenter accidentally knocks a fader muted from the UCI, the engineer can see it on the physical controller immediately.

---

### Test 4 — Master fader (Mains gain)

**What:** MIDImix master fader (rightmost, CC 62) → `Matrix.Mains` `gain`

**How to test:**
1. In Designer, open `Matrix.Mains` controls
2. Move the master fader
3. Watch `gain` change

**Pass:** Smooth gain control from −100 to +10 dB.

---

### Test 5 — Bank L: Mains mute

**What:** BANK L button (note 25) → `Matrix.Mains` `mute` toggle

**How to test:**
1. Press BANK L button on MIDImix
2. `Matrix.Mains` `mute` should toggle in Designer
3. Physically: room speakers should cut (if signal is flowing)

**Pass:** Mute toggles cleanly. Press twice to confirm it returns to unmuted.

---

### Test 6 — Bank R: ZoomTX mute

**What:** BANK R button (note 26) → `Matrix.ZoomTX` `mute` toggle

**How to test:**
1. Press BANK R button
2. `Matrix.ZoomTX` `mute` toggles in Designer

**Pass:** Mute toggles. If Zoom is connected, the far end should cut when muted.

---

### Test 7 — Tray activity log

**What:** Confirm the tray's recent-action log is updating correctly

**How to test:**
1. Make a few fader moves and button presses
2. Click the tray icon
3. "Recent activity" should show the last 5 actions with labels (e.g., "Mic 1 Fader", "Mic 3 Mute")

**Pass:** Actions appear in the log with correct labels.

---

## Part 3 — After Designer rebuild (not today)

Once the Channel Group rebuild is done in Q-SYS Designer (see `HANDOFF.md` — "Required Designer rebuild"), test these additional controls.

**Designer rebuild adds these components:**
`Mic.01.Gain` through `Mic.08.Gain`, `Mic.01.HPF` through `Mic.08.HPF`, `BusMicRoom.Comp`, `BusMicZoom.Comp` (plus all stereo chain and matrix chain blocks).

**To enable post-rebuild:**
Open `config/config.json` and uncomment the three blocked sections (Row A, Row B, Row C knobs). Restart the app.

### Post-rebuild Test A — Trim knobs (Row A)

**What:** Top-row knobs → `Mic.0n.Gain` `gain` (±18 dB, center = 0 dB)

**How to test:** Turn knob 1 center-to-left, confirm gain goes negative in Designer. Center position (CC 64) should be approximately 0 dB.

### Post-rebuild Test B — HPF frequency (Row B)

**What:** Middle-row knobs → `Mic.0n.HPF` `frequency` (80–300 Hz)

**How to test:** Turn knob 1 from min to max, confirm frequency sweeps 80–300 Hz in Designer.

### Post-rebuild Test C — Compressor threshold (Row C)

**What:** Bottom-row knobs 1–2 → `BusMicRoom.Comp` and `BusMicZoom.Comp` `threshold` (−40 to 0 dB)

**How to test:** Turn knob, confirm threshold changes in Designer. Verify control name is `threshold` via `Component.GetControls` first (see below).

**Control name verification (do this before testing Row C):**
```
# In Q-SYS Designer → Tools → QRC API Reference, or via TCP:
echo '{"jsonrpc":"2.0","id":1,"method":"Component.GetControls","params":{"Name":"BusMicRoom.Comp"}}' | nc 10.4.84.20 1710
```
Confirm the compressor threshold control name and update config if it differs from `threshold`.

---

## Part 4 — Designer rebuild guide (human task)

Reference: `HANDOFF.md` section "Required Designer rebuild — individual blocks"

**Root cause:** Q-SYS Channel Group (BETA) components aren't addressable via QRC from any external context — confirmed exhaustively in Phase 3. The design needs 5 Channel Groups replaced with individually named components.

**What to do in Q-SYS Designer:**

| Replace Channel Group | With | Components to place |
|---|---|---|
| `Mic.Chain` | 8 × (Gain → HPF → EQ) | 24 blocks: `Mic.01.Gain`, `Mic.01.HPF`, `Mic.01.EQ` × 8 |
| `Stereo.Chain` | 4 × (Gain → HPF → EQ) | 12 blocks: `Spotify.Gain/.HPF/.EQ`, `SoundTrack.*`, `ZoomIn.*`, `Slides.*` |
| `Bus.Mic.Chain` | 2 × (Gain→HPF→Comp→EQ→NFC→Gate→AEC) | 13 blocks: `BusMicRoom.*` and `BusMicZoom.*` |
| `Bus.Stereo.Chain` | 5 × (Gain → HPF → EQ) | 15 blocks: `BusMusicRoom.*`, `BusMusicZoom.*`, `BusZoomRx.*`, `BusSlidesRoom.*`, `BusSlidesZoom.*` |
| `Matrix.Out` | 3 × (Gain → HPF → EQ [+ Delay]) | 10 blocks: `Matrix.Mains.*`, `Matrix.ZoomTX.*`, `Matrix.Rec.*` |

After rebuild, push to Core and verify by looking for the new components in Q-SYS Designer → Status. You can also use the `ComponentValidator.lua` script component to check all components are visible.

---

## Part 5 — UCI over LAN

Covers the browser-based FOH mixer UI (`UciServer` in `src/main/uci-server.ts`)
added alongside the MIDI bridge: serving `/foh-uci` and relaying browser
WebSocket traffic to the Core over `/qrc`. Run these after Parts 1–2 pass
(app launched, Q-Sys + MIDI both connected).

### Test 8 — Local UCI verification

**What:** Confirms the UCI HTTP server is up, serves the mixer page, and
relays live QRC traffic when opened from this Mac.

**How to test:**
1. Launch the app (`npm start`, or `npx electron .` from a built `dist/`).
2. Check the tray menu: it should show a `UCI:  ● http://<lan-ip>:<port>/foh-uci`
   line (default port `3001`; `<lan-ip>` comes from `getLanIPv4()` in
   `src/main/network.ts` — it prefers `en0`, so on multi-homed Macs this may
   not be the interface you expect for a given VLAN — see Test 9's
   troubleshooting note).
3. Open that URL in a browser **on this same Mac** (e.g. `open
   http://localhost:<port>/foh-uci`, or `curl` it to confirm a `200` and a
   full HTML payload).
4. Confirm the page establishes a live WebSocket to `/qrc` and shows real
   Core state (channel names/levels populate, not stuck on "connecting").

**Pass:** Page returns HTTP 200 with the mixer HTML; the WebSocket connects
and reflects live Core state; tray's `UCI:` line matches (URL shown, no
`✕ Error:`).

**Note:** This is same-machine verification only — it proves the HTTP/WS
server and Core relay work from this Mac's own network stack. It does **not**
prove a separate device on the venue WiFi can reach it (see Test 10 —
manual-only).

### Test 9 — Concurrency check

**What:** Confirms the `/qrc` relay handles 2–3 simultaneous browser-style
WebSocket clients without serializing or dropping them, and that the MIDI
bridge's own Core connection is unaffected while they're open.

**How to test:**
1. With the app running and connected, open 2–3 concurrent WebSocket
   connections to `ws://localhost:<port>/qrc` (a small Node script using the
   `ws` package — already a dependency — works; see
   `qrc-ws-concurrency-test.mjs` at the repo root for a ready-made one:
   `node qrc-ws-concurrency-test.mjs ws://localhost:3001/qrc 3`).
2. From each connection, send a JSON-RPC request such as `EngineStatus` or
   `NoOp` (no trailing `\0` needed — the client script appends it) and
   confirm each connection gets back its own valid JSON-RPC response.
3. While those connections are open, check the tray menu — the `UCI:` line
   should show a `(N clients)` suffix matching the number of open
   connections, and the `Q-Sys:`/`MIDI:` lines should be unaffected
   (bridge keeps working normally; trigger a real MIDI control move or a
   `qrc-test.mjs` readback if you want to confirm the bridge's own Core
   connection is still live).
4. Close the extra connections and confirm the tray's client count drops
   back to 0 and the app doesn't log any errors/crashes.

**Pass:** All 2–3 connections get valid, independent responses; the tray
client-count suffix tracks connections opening/closing; the MIDI bridge's
own connection and status are unaffected throughout.

**Troubleshooting:** If a connection just hangs with no response, check
that the Core at the configured host/port is actually reachable
(`nc -zv <host> 1710`) — the relay opens a fresh TCP socket to the Core per
browser client, so a Core that's unreachable/rebooting will strand *all*
open relay connections, not just the MIDI bridge's.

### Test 10 — Manual-only: physical + real-device tests

**These three cannot be automated or faked from this Mac — they need a
human with hands on the hardware and/or a second device on the venue WiFi.**
Budget under 5 minutes total once on site with the gear.

**(a) Physical fader test**
1. With the app running and MIDImix connected, open the running design in
   Q-Sys Designer and double-click `Input.Mixer` (or whichever component a
   fader is mapped to) to show its live controls.
2. Move one physical MIDImix fader.
3. Confirm the paired QRC control updates in Designer in real time.

This is the authoritative regression test for the MIDI→QRC path — it is
the only test that actually exercises the physical controller. Test 2 in
this document (QRC-readback via `qrc-test.mjs`) is **not** a substitute: it
only confirms the Core's own control state is readable/writable via QRC
independent of MIDI, it does not prove a fader move reaches the Core.

**(b) Tablet-on-LAN test**
1. Get the LAN URL from **Tray → UCI** (or "Copy UCI Link").
2. On a phone or tablet connected to the **same WiFi network** as this Mac
   (not a different VLAN/guest network), open that URL in a browser.
3. Confirm the mixer page loads and a control move from the tablet updates
   the Core (visible in Designer, or by another fader move showing up on a
   second client).

**If it fails, check (in order):**
- **AP/client isolation** — many venue/guest WiFi networks block
  device-to-device traffic even on the same SSID. This needs a different
  network configuration (a non-isolated SSID/VLAN, or a wired/AP-bridged
  segment) — it is not something a code change can fix.
- **macOS firewall prompt** — on first launch, macOS may ask "Allow incoming
  connections?" for the app; it must be accepted, or the HTTP/WS server
  will be unreachable from other devices even though it works via
  `localhost`.
- **iOS Local Network permission** — on iPhone/iPad, check
  **Settings → Safari → Local Network** (or the per-site prompt) is allowed;
  iOS blocks LAN requests from Safari/web views without this.
- Confirm the tablet is actually on the interface/subnet
  `getLanIPv4()` picked (see Test 8, step 2) — on a multi-homed Mac the
  advertised IP may be on a different interface/VLAN than the one the
  tablet's WiFi is bridged to, in which case the URL is simply
  unreachable from that device by design.

**(c) Combined test (manual-only, do alongside (a))**
1. With a tablet's UCI session open on one control and the MIDImix on the
   physical control for the same channel, move the physical fader and the
   on-screen fader in quick succession (or have two people do it at once).
2. Confirm both converge on the same Core state (last write wins, as
   expected for two independent Core connections) and neither path
   crashes, freezes, or desyncs from the Core's actual value.

---

## Troubleshooting

**Q-SYS shows "disconnected"**
- Check that External Control is enabled on the Core: Core Properties → External Control → ✓ Enable
- Confirm the Mac can reach `10.4.84.20:1710` — `nc -zv 10.4.84.20 1710` should succeed
- Check `config.json` host/port

**MIDI shows "disconnected"**
- Confirm MIDImix is plugged in *before* app launch (no hot-reload)
- Check `config.midi.deviceName` matches the actual port name. The bridge does a substring match, so "MIDI Mix" matches "Akai MIDI Mix" etc. To list available ports, add `console.log` to `midi-io.ts` or check System Information → USB

**Fader moves but nothing happens in Q-SYS**
- Open tray activity log — is the action appearing? If yes, the MIDI side works; the Q-SYS write is failing. Check component name in config matches exactly (case-sensitive) what's in Designer Properties.
- If the action isn't appearing, the MIDI CC number may be wrong. Check the MIDImix CC map in `README.md`.

**Mute LED doesn't light**
- Feedback requires `feedback.enabled: true` in config (it is — confirm it wasn't accidentally edited)
- The note number in `feedback.mute_leds` must match the note number in the `toggle` mapping for the same channel

**App won't start / native module error**
```bash
npm run rebuild-midi
npm start
```
The `@julusian/midi` package has a native addon that must be compiled against the Electron version. If Electron was updated without rebuilding, this will fail.
