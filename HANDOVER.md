# HANDOVER — esp-emu (ESP-RV32 WASM Emulator)

> **Copy-paste this whole prompt into a new session / agent to resume work.**
> Last update: **2026-09-06**, branch `main` @ `315955c`, working tree clean
> (only this untracked file).

---

## 1. You are taking over this repo

**Repo:** `espc3 wasm` — blazing-fast in-browser **WebAssembly RV32 emulator** for Espressif `ESP32-C3 / C6 / H2 / P4 / C5` (+ S31 smoke).
**WASM core:** `pkg/esp_emu_bg.wasm` + `pkg/esp_emu.js` (Rust `esp-emulator` **0.41.0**; `pkg.prev/` keeps 0.39.0 for bisection).
**Frontend:** `index.html` + `app.js` (XTerm.js, OLED/TFT canvases, GPIO grid) + `worker.js` (WASM instance).
**SDK:** `index.mjs` re-exports `core/esp32c3.mjs` (`ESP32C3.create({chip})`, `loadFirmware(flash,elf)`, `step(n)`, `gpio/i2c/spi/adc/pwm/i2s/twai/touch/dac/sdmmc/camera/lcd/uart0` events) — `rp2040js`-style, works in browser & Node.
**Principle:** **zero guest modifications** — unmodified Arduino/IDF/MicroPython `.bin` + `.elf`. ELFs are only for load-time symbol patching.

### 1.1 Core idea in 30s

```
ELF symbols --planHooks--> patch list --prepareSpiShims/prepareBleShims/prepareIdfShims--> RV32 shims
flash image --EspImage.writeAtVaddr--> reseal (checksum+SHA) --> WASM load_firmware
shim writes APC frame to UART0 FIFO (0x60000000; P4 0x500CA000) --> worker/core/uart parses --> virtual device
device reply --> uart_input (dribbled) or shared-memory flag poll (BLE events) --> guest resumes
```

- Shims use **only RV32I** → same bytes on RV32IMC/IMAC/IMAFC.
- **APC frames:** `\x1b_<kind><nibble-payload>\x1b\` (`W/R` I2C, `Q` I2C probe/scan, `S/SX` SPI, `N` NeoPixel, `A/V` ADC, `P` PWM, `I` I2S, `C` TWAI, `T` Touch, `D` DAC, `M` SDMMC, `F` Camera, `L` LCD, `B/E` BLE).
- Firmware→host bytes are **nibble-encoded** (`'a'+nibble`) — UART→JS is a UTF-8 string, raw ≥ 0x80 becomes U+FFFD (I2S is the exception, audible not bit-exact).
- Host→firmware bursts are **dribbled 16B/batch** (`reply_queue.mjs`) — larger pushes lose their tail (HW RX FIFO), hang the poll loop. Always `pump()` even on silent batches.
- **BLE shared memory:** `B` still crosses as UART TX; `E` returns via `core/ble_mirror.mjs` — shim writes magic `DEADBEEF/BEAC0001` to per-chip DRAM scratch, emits `B`, polls flag; host scans WASM linear memory for magic (once/boot), writes event, sets flag=1.
- **Per-chip scratch:** `UART0_BASE` (C3/C6/H2/C5 `0x60000000`, P4 `0x500CA000`), `SPI_BUS_BASE`, `BLE_SCRATCH`, `I2C_CELL_BASE` (all in `shims.mjs`, applied by `relocateShimsForChip`).
- **App offsets:** most images boot the app at flash `0x10000`, but P4/C5 Arduino layouts put app0 at **`0x100000`** (`EspImage` knows both).

---

## 2. What we were doing (last wave — just finished, committed)

1. **Legacy I2C cmd-link** (`5975de7`): `i2c_master_cmd_begin` in-shim START/WRITE/READ/STOP list walker (W-merge + read-run re-walk), live on C3.
2. **Multi-chip cmd-link** (`e1582be`): rebuilt `IDFI2CLegacyDemo` for C6/H2/P4/C5, strengthened markers (`cmdlink rc=0` + `idf-i2c-cmd-done`).
3. **Upstream packet** (`a1ce948`): `issue.md` — WASM ETH/15.4/USB glue, C6/H2 BLE radio, C6 flake, S31 target.
4. **C6/H2 BLE stubs + P4 DAC close** (`d44208f`): `ble_vhci_disc_duplicate_*` stubs (verified A/B: Load-fault → past init), P4 DAC documented as virtual-DAC-covered.
5. **MicroPython v1.29.0** (`315955c` + this wave): REPL + machine.I2C/SPI/GPIO/ADC/PWM + scan on C3/C6/H2 (`spike/30-verify-mpy.mjs`, `samples/mpy/`).

---

## 3. What has been done (state @ `315955c`+, **all suites green**)

### 3.1 Legacy I2C cmd-link — live on all 5 chips

`shim_idf_i2c_cmd_begin()` walks the real 20B node list (mode=`w0>>11`: 6/2/1/3, next@+16): consecutive WRITEs merge into one `W` frame (first byte after START/STOP is the stripped address), read runs re-walk twice (sum → one `R` frame → scatter into node dests, following next-ptrs — heap stride is 36B, nodes are linked). 141 words/564B (fits the 582B symbol; the 528B `_static` twin stays skipped, public entry covers it). Debugged with triplet-tracer probes (since deleted). 27-verify #3 asserts `cmdlink rc=0 got=DEADBE`.

### 3.2 MicroPython v1.29.0 — live on C3/C6/H2

Prebuilt `ESP32_GENERIC_*` firmware under `samples/mpy/` (`.bin` + `.elf`, ~107MB total — normal for this repo), driven over UART0 by `spike/mpy_repl.mjs` (`bootMpy` + `replExec`, prompt-anchored). `30-verify-mpy` asserts banner + `print` + `writeto/readfrom/readfrom_mem/scan` (`[104]`) + SPI XOR-bus + GPIO out/in + ADC (`32776`) + PWM (per-chip max) on all three chips. P4/C5 firmware stored but **ROM-blocked** (`issue.md` #5).

- **I2C**: MP adds with addr 0 and calls `i2c_master_device_change_address` before EVERY transfer → new 16B shim stashes addr in the per-chip **I2C cell** (`I2C_CELL_BASE`), preferred by transmit/receive/transmit_receive when nonzero; `new_bus` zeroes it so Arduino is bit-identical. **Scan** uses `i2c_master_execute_defined_operations` ([START,WRITE,STOP] walker) + new **`Q` probe frame** (addr → 1-byte ACK; `Q` chosen because `P` was taken by PWM — a collision that briefly broke PWM dead, caught by 18-verify).
- **GPIO**: fully native (no shims!) once calibrated — but the zero-pattern heuristic in `core/gpio.mjs` can NEVER match UART0-active firmware, so `calibrateGpioLive` (in `mpy_repl.mjs`) discovers OUT/ENABLE/IN in-instance: two-pin co-movement + s0==0 rule + ENABLE-adjacency tiebreak + empirical IN sweep. (`core/gpio.mjs:setBaseAddrs` is the seeding hook; Arduino keeps the heuristic.)
- **ADC**: `adc_oneshot_*` shims reusing the `A` frame (`shim_analog_read` parametrized pin/out/mask/store — IDF stores to `*out_raw`, Arduino returns in a0; byte-identical for Arduino). H2 maps GPIO3→channel 2 (per-chip table in the suite).
- **PWM/LEDC**: `ledc_timer/channel/set_duty/update` + clock helpers (`esp_clk_tree_src_get_freq_hz` reports 80MHz) reusing the `P` frame; channel→pin via a table at `I2C_CELL+0x40`. C3 runs MP's 13-bit res (max 8192); C6/H2 run **16-bit** — the 14-bit frame **saturates at 16383** instead of wrapping (100% must never read as 0%). Suite pins per-chip maxima.
- **ISR mask discipline (lesson)**: any shim keeping t-regs across its body MUST mask UART INT_ENA — an ISR clobbering t0 mid-shim was caught live as a store fault (`T0 == RA` in the Guru dump). All MP shims mask; don't add unmasked ones.

### 3.3 Loader + image robustness (kept from this wave)

- **Per-hook try/catch** in `core/esp32c3.mjs` forge loop: one unlocatable hook (ROM-absolute, XIP-missing) warns and skips instead of nuking the whole patch set.
- **Header-preserving regen**: `python3 spike/gen_spi_shims.py` splices entries into `shims.mjs` keeping the hand header (no more `/tmp` merge script); merge-injected entries (`cmd_begin` pair, `read_cal` pair) now live in `all_shims`.
- **`EspImage` 0x100000 app offset** (P4/C5 Arduino layouts).
- **Relocator rule** for `0x3fc91` (I2C cell) + `I2C_CELL_BASE` table.

### 3.4 Earlier waves (still true)

C5 bring-up (22/22, no TWAI/VHCI), S31 ROM smoke, NimBLE host live on C3, IDF SPI/v5 shims, virtual Touch/DAC/SDMMC/Camera/LCD, timers/WDT/RTC/LittleFS/NVS, 0.41 UART-RX masking + C6 retry harness. See git log (`27ed35b`, `2a2b85b`).

---

## 4. Repo map (files that matter)

```
README.md / AGENT.md / PROTOCOLS.md (29 ✅) / BLE-OBSERVABILITY.md / issue.md (5 upstream items)
app.js / worker.js / index.html            browser UI + WASM worker
core/esp32c3.mjs        headless SDK (create/loadFirmware/step + all controllers)
core/{gpio,i2c,spi,adc,pwm,i2s,twai,touch,dac,sdmmc,camera,lcd,uart}.mjs
core/ble_{shims,controller,mirror}.mjs
reply_queue.mjs         16B host→firmware dribbler

elf.mjs                 ELF + HOOK_TARGETS (arduino/idf/mp tiers) + planHooks + prepare*Shims
espimage.mjs            flash app-image surgery + reseal (0x10000 + 0x100000 app offsets)
shims.mjs               RV32 shim bytes + UART0_BASE + SPI_BUS_BASE + I2C_CELL_BASE + relocate
peripherals.mjs         virtual devices (MPU6050, VirtualADC/PWM, ...)
spike/gen_spi_shims.py  shim assembler (source of truth; run from repo root)
samples/                prebuilt .merged.bin + .elf (C3 top-level, per-chip c5/c6/h2/p4)
samples/mpy/            MicroPython v1.29.0 .bin + .elf per chip (c3/c6/h2 live, c5/p4 blocked)
spike/mpy_repl.mjs      MP REPL harness (bootMpy/replExec/calibrateGpioLive)
pkg/esp_emu.{js,wasm}   compiled emulator 0.41.0 (do not edit by hand)

Spike suites (all green):
  18-verify-all.mjs     C3 15 tests (all protocols)
  24-verify-new.mjs     C3 5 virtualized (Touch/DAC/SDMMC/Camera/LCD)
  25-verify-hci.mjs     HCI unit + direct x2 + BLEDemo health
  26-verify-native.mjs  C3 Timer/WDT/RTC/LittleFS/NVS (no shims)
  27-verify-idf.mjs     C3 IDF SPI + I2C-v5 + legacy (incl. cmd-link)
  21/22/23-verify-*.mjs C6/H2/P4 18 demos each (incl. cmd-link markers)
  28-verify-c5.mjs      C5 22/22 (no TWAI on silicon)
  29-verify-s31.mjs     S31 target/ROM/chip-ID smoke (no firmware)
  30-verify-mpy.mjs     MicroPython REPL+I2C+SPI+GPIO+ADC+PWM on C3/C6/H2
  ble/peripheral_inspector.test.mjs (53+20 assertions)
```

---

## 5. How to compile and test (copy-paste)

### 5.1 Prerequisites

```bash
arduino-cli version   # 1.5.1+; core esp32:esp32 3.3.10
export TMPDIR=/tmp/isolated_path; mkdir -p /tmp/isolated_path  # clean TMPDIR, avoids PyInstaller collisions
```

### 5.2 Compile (Arduino) + refresh samples

```bash
# Single sketch / chip
arduino-cli compile --fqbn esp32:esp32:esp32c3 spike/sketches/TouchDemo \
  --output-dir spike/sketches/TouchDemo/build

# Per chip (example C6); C5 list skips TWAI/VHCI sketches
for s in TouchDemo DACDemo SDMMCDemo CameraDemo LCDDemo IDFSPIDemo IDFI2CDemo IDFI2CLegacyDemo TimerDemo WDTDemo RTCDemo LittleFSDemo NVSDemo; do
  arduino-cli compile --fqbn esp32:esp32:esp32c6 spike/sketches/$s \
    --output-dir spike/sketches/$s/build_esp32c6
done

# Refresh what the verifiers load (C3 top-level + per-chip c6/h2/p4/c5)
cp spike/sketches/TouchDemo/build/esp32.esp32.esp32c3/TouchDemo.ino.merged.bin  samples/touch_demo.merged.bin
cp spike/sketches/TouchDemo/build/esp32.esp32.esp32c3/TouchDemo.ino.elf        samples/touch_demo.elf
for short in c6 h2 p4 c5; do
  for s in TouchDemo DACDemo SDMMCDemo CameraDemo LCDDemo IDFSPIDemo IDFI2CDemo IDFI2CLegacyDemo; do
    chip=esp32$short
    cp spike/sketches/$s/build_$chip/$s.ino.merged.bin samples/$short/$s.merged.bin
    cp spike/sketches/$s/build_$chip/$s.ino.elf      samples/$short/$s.elf
  done
done
```

**Regenerate shims** after editing `gen_spi_shims.py` (run from repo root; preserves the `shims.mjs` header):

```bash
python3 spike/gen_spi_shims.py
```

**MicroPython firmware** (prebuilt, micropython.org): `.bin` + `.elf` per chip → `samples/mpy/mpy_<tag>.{bin,elf}`. C3/C6/H2 boot bare as whole flash; P4/C5 stored for later (ROM-blocked).

### 5.3 Test (headless, all real firmware)

```bash
node spike/18-verify-all.mjs      # C3: 15 tests
node spike/24-verify-new.mjs      # C3: 5 virtual (Touch/DAC/SDMMC/Camera/LCD)
node spike/25-verify-hci.mjs      # C3: HCI unit + direct x2 + BLEDemo health
node spike/26-verify-native.mjs   # C3: Timer/WDT/RTC/LittleFS/NVS
node spike/27-verify-idf.mjs      # C3: IDF SPI + I2C-v5 + legacy (incl. cmd-link)
node spike/21-verify-c6.mjs       # C6: 18 demos
node spike/22-verify-h2.mjs       # H2: 18 demos
node spike/23-verify-p4.mjs       # P4: 18 demos
node spike/28-verify-c5.mjs       # C5: 22 tests
node spike/29-verify-s31.mjs      # S31: smoke
node spike/30-verify-mpy.mjs      # MicroPython C3/C6/H2

node spike/ble_inspector.test.mjs         # 53 assertions
node spike/peripheral_inspector.test.mjs  # 20 assertions
```

**Must run with** `mcu.step(100000)` (smaller batches drop UART bytes at batch boundaries on H2/P4 — `AGENT.md:6`).

### 5.4 Observe (CLIs that prove the monitor pipeline on real output)

```bash
node spike/observe_ble.mjs BLETest --hci          # HCI live timeline
node spike/observe_peripheral.mjs idfspi          # IDF SPI via Peripheral Monitor
node spike/observe_peripheral.mjs touch           # Touch virtual
```

### 5.5 Browser

```bash
python3 serve.py 8080
# open http://localhost:8080 — pick a preset, Load Demo Firmware, watch
# OLED/TFT/NeoPixel/I2S + GPIO grid + I2C/CAN logs + BLE/Peripheral/Unified monitors + A/B Compare
```

---

## 6. Gotchas to keep in mind

1. **Mask discipline:** every shim that keeps t-regs across its body MUST `_mask_uart`/`_unmask_uart` on every exit — an ISR clobbering t0 mid-shim panics as a store fault (proven live; `T0 == RA` in the dump). No unmasked additions.
2. **Frame-kind collisions are fatal and silent:** `P` was taken by PWM; the I2C probe uses `Q`. Check `core/uart.mjs` switch + `PROTOCOLS.md` frame table before adding kinds (a duplicate makes the later `case` dead code).
3. **ABI shapes differ per caller:** Arduino `analogRead` returns u16 in a0; IDF `adc_oneshot_read` stores to `*a2` and returns ESP_OK — same wire format, different epilogue (parametrized, byte-identical for Arduino). Always check who consumes a0.
4. **Per-chip bases:** `relocateShimsForChip` handles UART/SPI-bus/I2C-cell; GPIO bases differ too (C3 `0x60004000`, C6/H2/C5 `0x60091000`; OUT/EN/IN offsets in soc headers). Linear addresses ≠ physical offsets — never assume adjacency in linear memory.
5. **GPIO calibration:** zero-pattern heuristic only works for UART0-idle firmware. UART0-active firmware (MicroPython) needs live discovery (`calibrateGpioLive`); never seed across instances (linear layout varies per process).
6. **MP quirks pinned in 30-verify:** H2 USB pins (no GPIO6/7), H2 ADC GPIO3→CH2, C6/H2 16-bit LEDC res (P-frame saturates at 16383), `duty_u16(65535)` bumps to 65536, `read_u16` Taylor scaling (2048→32776).
7. **P4/C5 Arduino layouts** put app0 at `0x100000` (not `0x10000`) — but the emulator boots Arduino apps from `0x10000`; the partition table is vestigial in-emulator. Don't "fix" layouts by hand.
8. **Bulk RX cost:** IDF `xfer` covers big shims only via the trampoline-park trick; verify with `elf.mjs:prepareIdfShims`. Camera 512B bands, SDMMC 128B chunks, 16B dribble, pump on silent batches.
9. **Build outputs:** C3 IDF builds live in `spike/sketches/**/build/esp32.esp32.esp32c3/`; other sketches use `build_<chip>/` — don't mix them when copying to `samples/`.

---

## 7. What's left (honest)

| Status | Item | Next step |
|---|---|---|
| ✅ done | Legacy I2C cmd-link (all chips), MicroPython C3/C6/H2 (REPL+I2C+SPI+GPIO+ADC+PWM+scan), P4 DAC (virtual), C6/H2 BLE stubs, loader resilience, header-preserving regen | — |
| ❌† | **802.15.4 / Ethernet / USB WASM glue** | Upstream `esp-emulator` (`issue.md` #1) |
| ❌† | **C6/H2 BLE radio** (LL transport needs radio model) | Upstream (`issue.md` #2) |
| ❌† | **C6 multi-instance flake** (mitigated by 3x retry) | Upstream (`issue.md` #3) |
| ❌† | **S31 firmware** (no Arduino/IDF target) | Upstream (`issue.md` #4) |
| ❌† | **MicroPython on P4/C5** (ROM rejects images, invalid-header loop) | Upstream (`issue.md` #5) |
| 📝 | **File the 5 upstream issues** | Needs human GitHub auth (no `gh` here) |

**Suggested next work (ranked):**
1. **CI** (GitHub workflow running all suites + parser tests) — locks in all gains.
2. **MP TWAI/BLE** (`twai_transmit` exists in MP? `bluetooth` module via NimBLE — C3 VHCI symbols are IN the MP binary! aioble against our virtual controller could light up).
3. **P-frame 14-bit ceiling** — proper resolution-aware LEDC scaling if real PWM fidelity matters.

---

## 8. WASM upkeep notes

- 0.41.0 intake done (`pkg.prev/` keeps 0.39.0). On the next drop: re-run the full battery, `grep -n "^    [a-z_]*(" pkg/esp_emu.js` for new exports (BLE HCI / 802.15.4 / Ethernet / USB would flip ❌ rows), keep old `pkg/` in `pkg.prev/`.
- `CHIP_GPIO_COUNT` + badge (`app.js`/`index.html`), ROM override check, dropdown option, `samples/<chip>/` + extended verify suite (mirror `21-verify-c6.mjs`) per new chip.

---

## 9. Handy one-liner (full regression)

```bash
node spike/ble_inspector.test.mjs && node spike/peripheral_inspector.test.mjs \
&& node spike/18-verify-all.mjs && node spike/24-verify-new.mjs \
&& node spike/25-verify-hci.mjs && node spike/26-verify-native.mjs \
&& node spike/27-verify-idf.mjs && node spike/20-test-mcu-core.mjs \
&& node spike/21-verify-c6.mjs && node spike/22-verify-h2.mjs \
&& node spike/23-verify-p4.mjs && node spike/28-verify-c5.mjs \
&& node spike/29-verify-s31.mjs && node spike/30-verify-mpy.mjs
# Expected: 53+20 parser, 15 C3 + 5 new + HCI + 5 native + 3 IDF + 18x3 per-chip + 22 C5 + S31 smoke + 3 MP chips
```

Good luck — the repo is in a clean, all-green state. Keep bisecting with the harness scripts; they are the source of truth, not the docs.
