# BLE-OBSERVABILITY.md — Observing BLE Behavior in the WASM Emulator

## Why this exists

Two complementary observation paths exist, because two different BLE software
stacks run on the emulator:

1. **Direct transport calls are fully observable.** Firmware that calls
   `esp_vhci_host_send_packet` / `API_vhci_host_send_packet` directly (e.g. the
   extended `spike/sketches/BLETest`) gets a complete, byte-visible round trip:
   the command crosses into JS as a UART APC `B` frame (see
   `BLEController.onHci`), the virtual controller answers, and the event comes
   back through a **shared-memory channel** — the shim writes a magic
   rendezvous pair, emits `B`, and polls a flag word; the host discovers the
   WASM linear-memory mirror by scanning for the magic (once per boot, see
   `core/ble_mirror.mjs`), writes the event bytes, and sets flag=1. UART RX is
   deliberately not involved (pushed bytes are unreliable for the guest to
   poll on this core — measured during development).
2. **The NimBLE host stack is fully live on ESP32-C3.** `BLEDemo` boots the
   real NimBLE host task in-sim: Reset → version/commands/features →
   sync → adv setup → `LE_Set_Adv_Enable`, all as observable `B` frames
   answered by the virtual controller (`--hci` shows the whole timeline).
   This works after four load-time fixes (see "NimBLE host bring-up" below);
   before them the stack was host-silent. C6/H2 Arduino builds use a
   different transport (NimBLE Link Layer `hci_transport_*` + ROM `r_ble_ll_*`
   — no VHCI symbols at all) that needs radio emulation upstream does not
   provide, so C6/H2/C5 BLE remains out of scope. The tooling below covers
   both paths.

## Components

| File | Role |
|---|---|
| `spike/observe_ble.mjs` | CLI harness: runs a BLE sketch and renders its console (+ `--hci` interleaves the raw HCI stream). |
| `spike/ble_inspector.mjs` | `parseLine()` / `BleInspector` — turn console lines into typed events. |
| `spike/ble_report.mjs` | `buildReport()` / `formatReport()` / `renderEvent()` — aggregate events into a session report. |
| `spike/ble_inspector.test.mjs` | 53-assertion regression test for the parser. |
| `spike/25-verify-hci.mjs` | Headless HCI proof: controller unit + direct round trip x2 + BLEDemo health. |
| `ble_monitor_api.js` + `app.js` + `index.html` | Web UI "BLE Monitor" panel (live event log + session report). |
| `core/ble_controller.mjs` | Virtual HCI controller + `onHci` byte-stream observers. |
| `core/ble_mirror.mjs` | Shared-memory event channel (mirror discovery + delivery). |
| `spike/peripheral_inspector.mjs` | Generic `PeripheralInspector` — structured event log for ALL protocols (observed from the emulator's own JS callbacks, not console text). |
| `peripheral_monitor_api.js` + `app.js` + `index.html` | Web UI "Peripheral Monitor" panel — same tooling as BLE Monitor, aggregated across ALL protocols. |
| `spike/peripheral_inspector.test.mjs` | 20-assertion regression test for the generic inspector. |
| `spike/sketches/BLEDemo`, `BLEDetect`, `BLETest` | Enriched NimBLE sketches that log BLE behavior. |

## CLI observer

```bash
# Default sketch is BLEDemo; also: BLEDetect, BLETest
node spike/observe_ble.mjs BLEDemo

# Interleave the raw HCI command/event stream (direct-call paths like BLETest)
node spike/observe_ble.mjs BLETest --hci

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

 ### BLE Monitor controls

 - **Tag filter** (BLE / DETECT / TEST checkboxes): show/hide each stream in the
   live log without discarding the underlying events (filtering is display-only;
   the report and export always use the full event set).
 - **Export JSON**: downloads `ble-events.json` — the full structured event array
   (`BleInspector.events`), ready for downstream tooling.
 - **Export Report**: downloads `ble-report.txt` — the `formatReport` session summary.
 - **Copy Report**: copies the report text to the clipboard.
 - **Snapshot**: captures the current session report as a baseline.
 - **Compare vs Snapshot**: shows a `formatDiff(diffReports(snapshot, current))`
   delta in the pink diff panel — useful for run-to-run comparison (e.g. after
   changing firmware or sketch parameters): MAC, lifecycle progress, services /
   characteristics, advertising, connections, and GATT op counts.

 All of the above are exposed from `ble_monitor_api.js` via `window.BleInspectorMod`
 (`BleInspector`, `parseLine`, `buildReport`, `formatReport`, `renderEvent`,
 `diffReports`, `formatDiff`).

## Peripheral Monitor (all protocols)

The same observability pattern is generalized to **every** protocol the emulator
exposes through its own JS callbacks. BLE is observed by parsing firmware console
text; I2C / SPI / TWAI / ADC / PWM / I2S / NeoPixel / OLED / ST7789 / SD / GPIO are
observed from the emulator's structured activity callbacks (the same data the worker
uses to drive the on-screen widgets). A single **Peripheral Monitor** panel aggregates
them all under one taggable, reportable stream:

- **Tag filter** (I2C / SPI / TWAI / ADC / PWM / I2S / NeoPixel / OLED / ST7789 / SD
  / GPIO checkboxes): show/hide each protocol in the live log (display-only; the
  report and export always use the full event set).
- High-frequency streams (OLED / ST7789 frames, NeoPixel updates, I2S audio) are
  **sampled** in the live log (~every 400 ms) so it stays readable, while still
  counted in full in the report.
- **Export JSON** (`peripheral-events.json`), **Export Report**
  (`peripheral-report.txt`), **Copy Report**.
- **Snapshot** + **Compare vs Snapshot**: `formatPeripheralDiff(
  diffPeripheralReports(snapshot, current))` shows a per-kind event-count delta —
  useful for comparing two runs of the same firmware (e.g. before/after a code
  change that alters bus traffic).
- Each event is `{ t, proto, kind, summary, detail }`; `detail` carries structured
  data (`addr`/`data` for I2C, `data`/`reply` for SPI, `id`/`dlc`/`data` for TWAI,
  `pin`/`raw`/`voltage` for ADC, `pin`/`duty` for PWM, `samples`/`volume` for I2S,
  `width`/`height` for OLED/ST7789, `pin`/`count` for NeoPixel, `lba`/`cmd` for SD).

 All of the above are exposed from `peripheral_monitor_api.js` via
 `window.PeripheralInspectorMod` (`PeripheralInspector`, `buildPeripheralReport`,
 `formatPeripheralReport`, `diffPeripheralReports`, `formatPeripheralDiff`).

 ### CLI observer (`spike/observe_peripheral.mjs`)

 The same pipeline can be run headlessly to **prove the monitor on real emulator
 output** (the APC routing + `peripherals.mjs` host models below are exactly what
 the browser worker does before it posts the activity messages). It captures the
 same protocols: I2C / SPI / TWAI via the `W`/`R`/`S`/`C` APC frames, and ADC / PWM /
 I2S / NeoPixel via the `A`/`V`/`P`/`I`/`N` frames; OLED / ST7789 / SD are captured
 through the device `onFrame` / `onActivity` hooks.

 ```bash
 node spike/observe_peripheral.mjs i2c      # I2C sensor read
 node spike/observe_peripheral.mjs spi      # SPI full-duplex transfer
 node spike/observe_peripheral.mjs bus      # BusProbe (I2C + SPI)
 node spike/observe_peripheral.mjs twai     # TWAI / CAN transmits
 node spike/observe_peripheral.mjs oled    # OLED frames + I2C
 node spike/observe_peripheral.mjs st7789  # ST7789 frames + SPI
 node spike/observe_peripheral.mjs neopixel
 node spike/observe_peripheral.mjs sdcard
 node spike/observe_peripheral.mjs adcpwm
 node spike/observe_peripheral.mjs i2s
 ```

 Flags: `--json` dumps the raw event array; `--steps=N` sets the batch count
 (default 1500, stops early on a `*done` marker). It prints the firmware console
 tail plus a `formatPeripheralReport` summary — the same report the web UI shows.

 ### Unified Timeline (BLE + all peripherals)

 The web UI also has a **Unified Timeline** panel that interleaves BLE Monitor
 and Peripheral Monitor events on a single chronological axis (tagged `BLE` /
 `PRF`). A source filter (BLE / Peripherals) toggles which stream is shown; the
 log carries the same inline visualizations as the Peripheral Monitor (NeoPixel
 swatches, I2S waveform, OLED / ST7789 thumbnails). **Export JSON** dumps the
 merged event array.

 When a **preset** is loaded, the Peripheral Monitor auto-focuses its tag filters
 to the protocols that preset exercises (e.g. `oled_demo` → OLED + I2C,
 `adcpwm_demo` → ADC + PWM, `i2s_demo` → I2S), so the relevant traffic is
 immediately visible without manual checkbox toggling.

 ### A/B Firmware Comparison

 The **A/B Firmware Comparison** panel runs two presets back-to-back and prints a
 single combined diff. Pick Firmware A (baseline) and Firmware B (compare), set a
 *Settle* time (how long each firmware runs before its snapshot is taken, default
 4 s), then click **Run A→B**. The tool resets the BLE and Peripheral monitors,
 loads A, waits, snapshots both reports, resets again, loads B, waits, and prints:

 ```
 === A/B Comparison (BLE + Peripherals) ===
 Firmware A : oled_demo
 Firmware B : st7789_demo
 --- BLE ---      (BleInspector diffReports / formatDiff)
 --- Peripherals ---  (PeripheralInspector diffPeripheralReports / formatPeripheralDiff)
 ```

 **Export** downloads the combined report as `ab-comparison.txt`. This is handy
 for catching regressions between two builds of the same sketch (e.g. before/after
 a change that alters bus or BLE traffic).

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
  0) and reports `send_available`; then performs a **direct HCI Reset round
  trip through both send_packet entries** (`esp_` + `API_`), printing each
  Command Complete event and `hci-direct ok`. This is the real-firmware proof
  of the observable HCI path (`spike/25-verify-hci.mjs` asserts it headlessly).

## Regression test

```bash
node spike/ble_inspector.test.mjs   # 53 passed
```

Covers every event type, non-tagged-line rejection, and `BleInspector` accumulation.

## NimBLE host bring-up (C3): why the stack transmits

Before these fixes the NimBLE host never sent a byte (`BLEDemo` stayed
host-silent though "healthy" — every status print is unconditional, and
`NimBLEDevice::init()`'s bool return is ignored by the sketch). Four
load-time defects, found by disassembling the Arduino image plus guest-RAM
reads (`vhci_send_sem`, `ble_hs_sync_state`, `m_synced`, task handles):

1. **`registerCb` must return ESP_OK.** `esp_nimble_hci_init` treats any
   nonzero return as failure and aborts NimBLE startup silently (before
   `nimble_port_init`, so no host task, no event queue, no sync). The old
   stub left A0 holding the callback pointer (nonzero). Now returns 0.
2. **The send shim must re-give the VHCI semaphore.** On hardware the
   controller frees a buffer per packet (ISR → `controller_rcv_pkt_ready`
   gives the sem); with no radio the transport blocks on its *second*
   command forever. The shim gives after each send (infinite buffers).
3. **The event callback may be a struct, not a function.** Direct callers
   (BLETest) register `on_hci_evt(data)`; the stack
   (`esp_nimble_hci_init`) registers `&vhci_host_cb` =
   `{notify_send_available, notify_recv}`. The old shim `jalr`ed into the
   struct as code. Now it sniffs the pointer's top-12 bits (code =
   `0x400`/`0x420`/`0x403`, else struct) and calls `recv(data, len)`.
4. **The virtual controller must answer with full-length data.** The host
   length-checks every Command Complete (`bha_params_len != rsp_len` →
   "Received status 0" + scheduled reset = infinite Reset loop). Fixed:
   `0x1002` claims all commands, `0x1003` returns 8 feature bytes,
   `0xfc01` (ESP vendor random-address) returns a static-random address,
   `0x2018` (LE_Rand) returns 8 bytes.

Result: ~24 HCI commands from Reset through `LE_Set_Adv_Enable`, zero
NimBLE errors, `m_synced`/`m_initialized` set, sketch heartbeats.
`spike/25-verify-hci.mjs` asserts stack Reset + AdvEnable frames headlessly.
