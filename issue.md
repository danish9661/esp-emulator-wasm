# Upstream issue packet (esp-emu 0.42.0)

Five ready-to-paste issues (was four at 0.41.0). Issues 1–3 and 5 go to
`espressif/esp-emulator`; issue 4 goes to `arduino-esp32` (with an
`esp-idf` counterpart for the toolchain half). Environment: `pkg/`
esp-emu 0.42.0 (JS API byte-identical to 0.41.0 — all changes are inside
the `.wasm`), `esp32:esp32` Arduino core 3.3.10, no `idf.py` toolchain
installed.

---

## Issue 1 → `espressif/esp-emulator`: expose Ethernet / 802.15.4 / USB-Serial-JTAG in the WASM JS API

**Observed:** The native CLI models all three (OpenETH + P4 DesignWare GMAC
with `--net tap/user`, smoltcp user-mode, ws-proxy; `--thread-sim`
localhost-UDP bridge for 802.15.4; USB Serial JTAG peripheral used by
esptool flows). But `WasmEmulator` in `pkg/esp_emu.js` (0.41.0) exposes
only: `constructor`, `run_batch`, `pc`/`cycles`/`get_reg`,
`load_firmware`/`load_rom_elf`/`load_default_rom`/`load_efuse`/`load_app_elf`,
`set_boot_from_rom`, `restart`/`needs_restart`/`has_default_rom`,
`uart_input`, and the WiFi trio `set_wifi_config` / `wifi_rx_push` /
`wifi_tx_drain`. There is no path for ETH / 15.4 / USB-JTAG frames from JS.

**Expected:** Mirror the WiFi pattern:

- `eth_rx_push(Uint8Array)` / `eth_tx_drain()` (same u32-LE
  length-prefixed framing `wifi_tx_drain` already uses —
  see `drainTxToNetwork` in `worker.js`),
- `thread_rx_push` / `thread_tx_drain` with `--thread-sim` bridge
  semantics (or a JS-side peer hook for the localhost UDP bridge),
- `usb_serial_jtag_rx_push` / `usb_serial_jtag_tx_drain`.

**Use case:** We drive every peripheral from JS through a UART frame
protocol; WiFi works end-to-end through this exact glue, the other three
are unreachable from the browser build.

**Local workaround (done, C3 only):** the IDF `usb_serial_jtag_*` driver
API is shimmed at load time (write→console text, read→RX-FIFO poll,
`is_connected`→true), verified by `spike/27-verify-idf.mjs` TEST 4. This
covers driver-level firmware; USB-CDC/TinyUSB and true USB visibility
still need the WASM exports above. Ethernet and 802.15.4 have no local
workaround.

---

## Issue 2 → `espressif/esp-emulator`: no BLE radio model for C6/H2 (and C5) LL-transport images

**STATUS: RESOLVED LOCALLY — no upstream action needed for host verification.**
C6/H2/C5 NimBLE is fully live in-sim (BLEDemo: ~19 HCI commands
Reset→`LE_Set_Adv_Enable`, syncs, advertises, heartbeats; asserted by
`25-verify-hci.mjs` §3 on all three chips). Technique: route HCI around the
ROM link layer instead of emulating RF — transport-init barrier stubbed,
sem takes neutered to their success paths, commands redirected into a parked
body that emits `B` frames / polls the shared mirror / calls the host recv
callback directly, ROM mbuf/substrate gaps covered by tiny shims (full
write-up: `BLE-OBSERVABILITY.md` § "LL-transport bring-up"). The virtual
controller answers everything, so no radio is needed. (Genuine over-the-air
RF remains unmodeled — out of scope for verification.)

Original report preserved below.

**Observed:** C3 NimBLE works because images expose VHCI symbols
(`esp_vhci_host_send_packet`, `esp_vhci_host_register_callback`, …) that a
JS virtual controller can answer. C6/H2 Arduino BLE builds contain **no
VHCI symbols at all** — transport is NimBLE Link Layer `hci_transport_*`
plus ROM `r_ble_ll_*`. Without a radio/LL model these images cannot do BLE
in the emulator (BLEDemo crashes; on C5, BLETest doesn't even link — no
VHCI host interface — and C5 radios are documented as unmodeled).

**Expected:** A virtual BLE Link Layer / radio model for LL-transport
images, analogous to what `--thread-sim` does for 15.4 (frame bridge
between instances) or the Bumble HCI forwarding already offered for BLE.
Advertising-only loopback would already unblock verification.

**Evidence:** Symbol comparison of C3 vs C6/H2 BLE sketches (VHCI set
present vs absent, `hci_transport_*`/`r_ble_ll_*` present);
`BLE-OBSERVABILITY.md` § "NimBLE host bring-up" documents the four C3
load-time fixes and the C6/H2 dead end. Retested on 0.42.0: C5 `BLEDemo`
still Gurus (Store fault) at radio bring-up with no VHCI symbols patched —
even though 0.42.0 models C5 BLE advertising natively, the WASM build
exposes no radio bridge for it.

---

## Issue 3 → `espressif/esp-emulator`: C6 multi-instance nondeterminism, regression 0.39 → 0.41

**Observed:** On 0.41, C6 runs flake nondeterministically (~1/3 runs lose
1–2 SPI/I2C-heavy demos). 0.39 was stable on C6; C3/H2/P4 are stable on
0.41. Identical patched images boot differently per OS process — guest
inputs and shims are deterministic, so the nondeterminism is inside the
core (smells like uninitialized state or scheduler/ROM nondeterminism
specific to the C6 target).

**Repro:** Boot the same patched C6 `merged.bin`+`.elf` N times in fresh
`WasmEmulator('esp32c6')` instances, step `3000×100000`, and check serial
markers (`idf-spi-done`, `idf-i2c-done`, `idf-i2c-legacy-done`, …).
Intermittent runs miss markers or raise Guru Meditation with no preceding
console text. Our mitigation is per-demo retry ×3 with a fresh instance
(`spike/21-verify-c6.mjs`, same in `22-verify-h2`/`23-verify-p4`); a real
regression fails 3/3 loudly, flakes pass on retry.

**Expected:** Deterministic boot per image on C6 as on the other targets
(or a documented seed/pinning knob if the nondeterminism is intentional).

**New 0.42.0 data point (H2, deterministic):** `spike/22-verify-h2.mjs`
crashes 4/4 runs at the 3rd demo with a host-side Rust panic
(`dlmalloc-0.2.11: assertion failed: psize >= size + min_overhead` →
`RuntimeError: unreachable`), while 0.41.0 passes the same suite.
Bisected further: single demos pass alone (even 8000 batches), pairs pass,
fixed-count triplets pass — only the suite's early-marker-break pattern
(fewer prior batches) crashes, pointing at WASM memory growth/fragmentation
across instances (0.42.0's "keep internal memory across every reset" is the
prime suspect). Minimal repro: boot Blink → I2CRead → SPIDemo H2 images in
fresh `WasmEmulator('esp32h2')` instances with early marker break; the 3rd
`load_firmware`/early steps abort the process (no retry possible).

---

## Issue 4 → `arduino-esp32` (+ `esp-idf`): no ESP32-S31 target

**Observed:** `arduino-cli core list` → `esp32:esp32 3.3.10` ships C3/C5/C6/
H2/P4 board definitions but **zero matching `s31`**; no `idf.py`
toolchain for S31 in the environment either. So no S31 firmware can be
built, and emulator shim bases can't be validated.

**Emulator side ready:** esp-emu 0.41.0 accepts `esp32s31`, ships an
embedded default ROM (`ESP-ROM:esp32s31-20251218`), enforces the chip-ID
gate (S31 expects `0x20`, rejects foreign images) — all locked in by
`spike/29-verify-s31.mjs` ROM-banner smoke. Known S31 facts for bring-up:
dual RV32, 60 GPIOs, chip ID `0x20`.

**Expected:** S31 chip support in ESP-IDF plus `esp32s31` board definitions
in arduino-esp32, so firmware builds and peripheral-base validation become
possible.

---

## Issue 5 → `espressif/esp-emulator`: P4/C5 ROM model rejects valid MicroPython images (invalid-header loop)

**Observed:** Prebuilt MicroPython v1.29.0 (`ESP32_GENERIC_P4`, `ESP32_GENERIC_C5`,
full 7-segment `.app-bin` incl. XIP code) never boots in the WASM build: the
P4 ROM (`ESP-ROM:esp32p4-20230811`) and C5 ROM (`ESP-ROM:esp32c5-eco2-20250121`)
loop `invalid header: 0xffffffff` forever. The
same images in every hardware-plausible layout fail identically: bare file as
whole flash, app@0x10000 ± Arduino partition table, app@0x100000 (the
partition-declared P4/C5 app offset), 4MB and 16MB flash sizes, header bytes
8–23 spoofed to a booting Arduino image's values + resealed checksum/SHA,
segment count 7→6, and `bootFromRom=false` (whose ROM-less loader rejects ESP
app images outright: `Invalid image magic`). Notably, even a 100%-Arduino
layout (Arduino bootloader + partitions + app at the partition offset) fails
the same way, while Arduino images with the app at 0x10000 boot fine — i.e.
the ROM model only accepts the Arduino-shaped image and the
2nd-stage-bootloader path appears unsupported on these targets.

**Control cases that work:** the same MicroPython release boots to a live REPL
over UART0 on C3/C6/H2 (bare `.bin` as flash), with `machine.I2C`/`machine.SPI`
fully working through the loader's IDF shims (`spike/30-verify-mpy.mjs`).

**Impact:** P4/C5 MicroPython (REPL, peripherals) is unreachable despite
complete firmware being available; the IDF driver functions also live in XIP
flash on these builds, so this blocks all P4/C5 MP verification.

**Expected:** ROM-model boot accepts standard multi-segment app images on P4/C5
(partition-declared app offset, XIP segments), as it does for Arduino-shaped
images — or documentation of the exact image constraints the model enforces.
