# BLE-OBSERVABILITY.md — Observing BLE Behavior in the WASM Emulator

## Why this exists

In the WASM build, the emulator's loader intercepts the VHCI symbols
(`esp_vhci_host_send_packet`, `esp_bt_controller_init/enable`, …) at
`load_firmware` and routes HCI to its own built-in native BLE controller.
Consequences (see `PROTOCOLS.md` §4):

- The HCI **byte stream is not observable from JS** — only the firmware's own `Serial`
  output is visible. The VHCI shim (`core/ble_shims.mjs` + `core/ble_controller.mjs`) is
  active and required for BLE firmware to run, but its HCI frames do not reach the JS
  observer.
- `esp_vhci_host_send_packet()` called from firmware **hangs** the wasm.

So BLE observability here means **watching what the firmware itself prints** — its own
`Serial` debug log — not the hidden HCI traffic. This is exactly what the tooling below does.

## Components

| File | Role |
|---|---|
| `spike/observe_ble.mjs` | CLI harness: runs a BLE sketch and renders its console. |
| `spike/ble_inspector.mjs` | `parseLine()` / `BleInspector` — turn console lines into typed events. |
| `spike/ble_report.mjs` | `buildReport()` / `formatReport()` / `renderEvent()` — aggregate events into a session report. |
| `spike/ble_inspector.test.mjs` | 41-assertion regression test for the parser. |
| `ble_monitor_api.js` + `app.js` + `index.html` | Web UI "BLE Monitor" panel (live event log + session report). |
| `spike/sketches/BLEDemo`, `BLEDetect`, `BLETest` | Enriched NimBLE sketches that log BLE behavior. |

## CLI observer

```bash
# Default sketch is BLEDemo; also: BLEDetect, BLETest
node spike/observe_ble.mjs BLEDemo

# Structured JSON Lines (one JSON object per event)
node spike/observe_ble.mjs BLEDemo --json

# Human-readable aggregated session report (printed at the end)
node spike/observe_ble.mjs BLEDemo --report

# Both: JSON report plus the (JSON) event stream
node spike/observe_ble.mjs BLEDemo --json --report
```

Sample plain output:

```
[BLE 0.16s] → starting
[BLE 0.16s] → init_done
[BLE 0.16s]   local-mac=01:00:00:c4:0a:24
[BLE 0.16s] → server_created
[BLE 0.16s]   service created uuid=0xdead
[BLE 0.16s]   characteristic uuid=0xbeef props=0x1a value='Burger'
[BLE 0.16s]   advertising started name='NimBLE-Server' scan-response=1
[BLE 0.16s] → done
[BLE 0.21s]   heartbeat uptime=5000ms connections=0
[BLE 0.21s]   gatt-notify uuid=0xbeef value='tick-0'
```

`BLEDetect` / `BLETest` use the same renderer but with `[DETECT]` / `[TEST]` tags and
prove the loader intercepts VHCI at runtime (e.g. `init returned: 0`).

## BleInspector API

```js
import { parseLine, BleInspector } from './spike/ble_inspector.mjs';
import { buildReport, formatReport, renderEvent } from './spike/ble_report.mjs';

// Single line -> event object (or null for non-tagged console lines)
const ev = parseLine('[BLE] characteristic uuid=0xbeef props=0x1a value=\'Burger\'');
// => { type: 'ble.characteristic', uuid: '0xbeef', props: 26, value: 'Burger' }

// Streaming: feed chunks; split on newlines; attaches a relative timestamp `t`
const ins = new BleInspector();
const parsed = ins.feed('[BLE] starting\n[BLE] init done\n');  // => 2 events
ins.events;  // all accumulated events

// Aggregate into a session report
const report = buildReport(ins.events);
console.log(formatReport(report));      // pretty text
console.log(JSON.stringify(report));    // machine-readable
console.log(renderEvent(ev));            // '[BLE] characteristic uuid=0xbeef props=0x1a value=\'Burger\''
```

### Event types

| `type` | Fields |
|---|---|
| `ble.state` | `state` (starting / init_done / server_created / advertising_started / done) |
| `ble.mac` | `mac` |
| `ble.service` | `uuid` |
| `ble.characteristic` | `uuid`, `props`, `value` |
| `ble.advertising` | `name`, `scanResponse` |
| `ble.heartbeat` | `uptimeMs`, `connections` |
| `ble.connect` / `ble.disconnect` | `peer`, `handle` (+ `reason` on disconnect) |
| `ble.gatt_read` / `ble.gatt_write` / `ble.gatt_notify` / `ble.gatt_subscribe` | `peer`, `uuid`, (+ `len`/`bytes` / `value` / `sub`) |
| `ble.mtu_change` | `peer`, `mtu` |
| `detect.symbol` | `name`, `addr`, `w0`, `classification` |
| `detect.mac` / `detect.done` / `detect.heartbeat` | mac / loop / sendAvailable |
| `test.mac` / `test.init` / `test.enable` / `test.send_available` / `test.send_hci_reset` / `test.done` / `test.heartbeat` | phase / returned / available / loop |

## Web UI BLE Monitor

1. Serve the repo: `python3 serve.py` (serves from the repo root).
2. Open `index.html` in a browser.
3. In **Bundled Arduino Demos**, pick a BLE firmware:
   - **BLE Server Demo (NimBLE)**, **BLE VHCI Detector**, **BLE VHCI Call Test**.
4. Click **Load Demo Firmware** (this also auto-runs).
5. Watch the **BLE Monitor** panel in the right column: a live, color-coded event
   log (cyan = firmware BLE, purple = VHCI detector, amber = VHCI call test) plus a
   continuously updated **Session Report**. Use **Clear** to reset the log.

The monitor taps the same UART0 output the terminal shows — it just routes
`[BLE]`/`[DETECT]`/`[TEST]` lines through the shared `BleInspector`.

## Enriched sketches (rebuild with arduino-cli)

The sketches are intentionally verbose so the observer has something to show. Rebuild
after editing:

```bash
arduino-cli compile -b esp32:esp32:esp32c3 \
  --output-dir spike/sketches/BLEDemo/build spike/sketches/BLEDemo
# then re-run: node spike/observe_ble.mjs BLEDemo
```

What each logs:

- **BLEDemo** — MAC, service/characteristic UUIDs + properties + value, advertising
  config; wires `NimBLEServerCallbacks` (connect/disconnect/MTU) and
  `NimBLECharacteristicCallbacks` (read/write/subscribe); periodic heartbeat + `notify`.
  Connection/GATT callbacks fire only when a peer connects (the simulator has no client,
  so they're exercised by real hardware / an external peer, not the wasm).
- **BLEDetect** — MAC + classification of each VHCI symbol from flash (the firmware's
  weak stubs; the live override is invisible to `rd32`).
- **BLETest** — MAC + calls `esp_bt_controller_init/enable` (proving the loader returns
  0) and reports `send_available`; documents that `esp_vhci_host_send_packet` hangs.

## Regression test

```bash
node spike/ble_inspector.test.mjs   # 41 passed
```

Covers every event type, non-tagged-line rejection, and `BleInspector` accumulation.
