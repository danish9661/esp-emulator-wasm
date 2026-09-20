# espc3api.md — ESP32-C3/C6/H2/C5/P4/S31 (`esp-emu@0.42.0`) API reference + OpenHW contract

> Single entry point: **`index.mjs`** (122 names, verified live). OpenHW /
> Wokwi-style hosts import ONLY from there — `core/*`, `spike/*` paths are
> internal and may move. The Go gateway tree (`openhw-studio-gateway/`) is
> owned by the OpenHW agent; do not edit gateway sources for esp-emu fixes.

Probed live (`node -e import(...)`, `grep ^export`). Fixed 2026-09-20 (GPIO
per-chip counts, single entry, `setWifi`/`wifiRxPush`/`wifiTxDrainSplit`/
`dispose`); extended 2026-09-20 (rvasm, BLE/Thread shim builders, MPY
harness, per-chip sample matrix).

---

## 1. Package layout

- `pkg/package.json`: `esp-emu` 0.42.0, ESM, Apache-2.0, `main esp_emu.js`,
  files = `esp_emu_bg.wasm` (3.4 MB) + `esp_emu.js` (17K, 518 lines).
- `core/`: 22 files — `esp32c3, gpio, uart, i2c, spi, adc, pwm, i2s, twai,
  touch, dac, sdmmc, camera, lcd, neopixel, ble_controller, ble_hci_pump,
  ble_mirror, ble_shims, thread_controller, thread_shims, rvasm`.
- Import rule: `import { ESP32C3, CHIPS, … } from './index.mjs'` (or the
  published package name once packed). Never deep-import `core/*`.

## 2. `WasmEmulator` (`pkg/esp_emu.js`, wasm-bindgen — raw layer, usually hidden)

```
constructor(chip), __destroy_into_raw, free, cycles()->n, get_reg(i)->u32, pc()->u32,
run_batch(n)->string, restart(), needs_restart()->bool,
load_firmware(bytes), load_rom_elf(bytes), load_default_rom(),
load_app_elf(bytes), load_efuse(bytes), has_default_rom()->bool,
set_boot_from_rom(b), uart_input(bytes),
set_wifi_config(ssid, password), wifi_rx_push(bytes), wifi_tx_drain()->len-prefixed batch
```

(20 protos incl constructor; counted live via `Object.getOwnPropertyNames`.)
Node init MUST be `initSync({module: readFileSync(wasm)})`; browser uses
`default(url)`. Multi-instance: per-instance `?instance=N` cache-bust inside
`ESP32C3.create` — else pkg 0.42 shares one dlmalloc heap and corrupts
(`issue.md#3`). Prefer the `ESP32C3` SDK below over touching this layer.

## 3. `ESP32C3` SDK (the board object — one instance per emulated chip)

`ESP32C3.create({chip, bootFromRom=true, wasmModuleUrl?})` → instance with
`gpio/i2c/spi/adc/pwm/i2s/twai/neopixel/touch/dac/sdmmc/camera/lcd/thread/uart0`
(P4 loads `samples/p4/esp32p4_rev0_rom.elf` instead of the embedded ROM).

| Method | Signature | Notes |
|---|---|---|
| `loadFirmware` | `(flashBin, elfBin?, shimOpts?={thread}) → {patched[]}` | ELF HAL trampolines + `EspImage.reseal()`; `patched[]` lists applied shims |
| `step` | `(n=100000) → clean serial string` | `run_batch` + `gpio.sync()` + APC routing; never step smaller (H2/P4 drop UART tails) |
| `pc` / `cycles` / `getRegister(i)` | getters / `(i)→u32` | sim-time + RV32 regs; chunk-boundary PC only |
| `readMemory` / `writeMemory` | `(addr,len)→Uint8Array` / `(addr,bytes)` | linear-memory inspect for runners/debuggers |
| `restart` | `()` | soft reset (full reload = `loadFirmware` again) |
| `setWifi` | `(ssid,pass='')` | native WASM glue (C3/C6 only) |
| `wifiRxPush` | `(bytes)` | one raw RX frame into the guest |
| `wifiTxDrainSplit` | `()→Uint8Array[]` | pre-split frames (gateway rule: one raw frame per WS message) |
| `dispose` | `()` | detach for runner teardown |

## 4. Board table — every chip (import `CHIPS` / `CHIP_GPIO_COUNT` from `index.mjs`)

| Chip | Pins | Arch | MHz | WiFi | BLE | 15.4 | TWAI | ROM banner | Samples | Suites | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `esp32c3` | 22 | RV32IMC | 160 | 4 | 5 | — | ✅ | `esp32c3-api1-20210207` | root 34 (`samples/*.elf`) | 18,24,25,26,27 | full; reference target |
| `esp32c6` | 30 | RV32IMAC | 160 | 6 | 5 | ✅ | ✅ | `esp32c6-20220919` | `samples/c6/` 18 | 21,25§3,32,35–40 | full; Thread leader/A |
| `esp32h2` | 19 | RV32IMAC | 96 | — | 5 | ✅ | ✅ | `esp32h2-20221101` | `samples/h2/` 18 | 22,25§3,32,35–40 | full; Thread child/B (37) |
| `esp32c5` | 29 | RV32IMAC | 240 | 6 | 5 | ✅ | — | `esp32c5-eco2-20250121` | `samples/c5/` 22 (+Timer/WDT/RTC/NVS/LittleFS) | 28,25§3,32,35 | no TWAI on silicon |
| `esp32p4` | 56 | RV32IMAFC | 400 | — | — | — | ✅ | `esp32p4-20230811` | `samples/p4/` 19 .elf/18 .bin + `esp32p4_rev0_rom.elf` | 23 | HP, no radio; P4 ROM via bundled ELF |
| `esp32s31` | 60 | RV32 | 320 | 6 | 5.4 | ✅ | — | `esp32s31-20251218` | — (no toolchain) | 29 smoke only | target+ROM+chip-ID only |

- GPIO counts are enforced: `gpio.pins.length === CHIPS[chip].pins`
  (verified live for all six). Low-32-mask model — pins >31 are API-visible,
  sim-limited; see `core/gpio.mjs` header.
- Demo naming: root = lowercase (`blink.elf`), per-chip dirs = CamelCase
  (`samples/c6/Blink.elf`). Thread builds live at root (`threaddemo_{c6,c6b,
  h2,c5}`); MicroPython under `samples/mpy/` (`mpy_{c3,c5,c6,h2,p4}.{bin,elf}`
  + `mpy_{c5,p4}_flash.bin` composed flashes).
- Sketch sources: `spike/sketches/` (33 dirs incl `ThreadDemo`, `JoinerDemo`,
  `BLEDemo`/`BLEDetect`/`BLETest`, `WiFiDemo`).
- Suite map: 18 C3-all · 21 C6 · 22 H2 · 23 P4 · 24 virtual · 25 HCI (all BLE
  chips) · 26 native · 27 IDF · 28 C5 · 29 S31 · 30 MPY (all 5) · 31 WiFi ·
  32/35/36/37/39/40 Thread.

## 5. Controllers (attach components here)

- `GPIOController{chip, pinCount, pin(n)→GPIOPin{addListener/removeListener/setInput}, setInput, getPinLevel, isOutput, onActivity(out,en), setBaseAddrs, sync, bindMemory}` — `setBaseAddrs` only for UART-TX-stuck images, else auto-calibration (`gpio.mjs`).
- `UARTController{write, onData, processOutputChunk, bindMemory}` + `ReplyDribbler` (≤16 B slices — always `pump()` even silent batches).
- `I2CBus{register/unregister, onWrite/onRead/onActivity, write, read}` — device dialect `i2cWrite/i2cRead`. Bus aliases in `peripherals.mjs` use `onWrite/onRead` instead — match the bus you attach to (suites use the `core` spelling). Standard addrs: SSD1306 0x3c/0x3d, MPU6050 0x68.
- `SPIBus{register(name|cs)/unregister, onTransfer/onWrite/onActivity, transferByte, write}` — device fns `onTransferByte`/`onWrite` (aliases `spiTransferByte`/`spiWrite` accepted); `onTransfer` = loopback rig.
- `ADCController{setVoltage/setRaw/getVoltage/readRaw/readMilliVolts/onSample}` (12-bit, 3.3 V ref); `PWMController{getDuty/getPercent/update/onUpdate}` (`update` is guest-driven); `I2SController{writePcm/onAudio}` (guest-driven PCM→Float32); `TWAIController{inject/transmit/popRxFrame/onActivity}` (`inject` = host→guest).
- `TouchController{setTouched/attachInterrupt/detachInterrupt/getRaw/read/onActivity}`; `DACController{write/getChannel/onActivity}`; `SDMMCController{readSectors/writeSectors/writeChunk/sectorCount/onActivity}`; `CameraController{capture/readBand/onFrame}` (96×96 gray); `LCDController{drawBitmap/onFrame}` (240×240 RGB565); `NeoPixelController{update/getFrame/onFrame}` (GRB).
- `BLEController{handle/onHci}` + `BLEMirror{discover/deliver/clear}` (shared-mem events, not UART RX) + `BleHciPump{setMode/setTransport/handleBFrame/handleWsMessage}` (local/Bumble; `0xfc01`/`0x204e` always local); `ThreadController{handle/handleScan/onActivity/reset}` (256-frame ring — cursors MUST use `frame.n`).
- Virtual devices (`peripherals.mjs`, 19 exports): `PeriphI2CBus/PeriphSPIBus/GenericSPIDevice/NeoPixelStrip/ST7789Device/SSD1306Device/MPU6050Device/VirtualSDCard/VirtualADC/VirtualPWM/VirtualI2S/VirtualTWAI/VirtualTouch/VirtualDAC/VirtualSDMMC/VirtualCamera/VirtualLcdPanel` + `calcCrc16/createDefaultFat16Image`. SD-SPI: `loadDisk/getDisk/onActivity`.
- Observers (same pipeline as the browser monitors): `PeripheralInspector{feed/add}` + report/diff fns; `BleInspector/parseLine` + `buildReport/formatReport/renderEvent/diffReports/formatDiff`; proofs `spike/observe_peripheral.mjs` (18 presets incl `idfspi/idfi2c/idfi2clegacy`) and `observe_ble.mjs --hci`.

## 6. Loader / patching internals (for custom runners; `loadFirmware` covers most hosts)

- `elf.mjs{Elf32{symbols/vaddrToFileOffset/resolve}, HOOK_TARGETS, makeJal, planHooks, prepareSpiShims, prepareIdfShims}` — hook groups: arduino-i2c/spi/neopixel/adc/pwm, mp-adc/mp-pwm, idf-usb/i2s/twai, virtual-touch/dac/sdmmc/camera/lcd, idf-i2c-v5/legacy, idf-spi, thread-15d4.
- `shims.mjs{UART0_BASE, SPI_BUS_BASE, I2C_CELL_BASE, SHIMS (115 keys), relocateShimsForChip}` — RV32I-only bytecode, all chips.
- `espimage.mjs{EspImage{findApp/vaddrToOffset/writeAtVaddr/computeChecksum/reseal/verify}}` — app offsets `0x10000`/`0x100000`.
- `core/rvasm.mjs` — registers (`T0–T5/A0–A7/S0–S1/SP/RA/ZERO`), encoders (`lui/addi/sw/lw/sb/lbu/andi/srli/slli/beq/bne/bge/add/or/lb/jal/ret/jalr_ra/jalr/li`), `asm32/assemble` (two-pass, labels).
- `core/ble_shims.mjs{BLE_SCRATCH/BLE_CB_OFF/BLE_FLAG_OFF/BLE_EVT_OFF/BLE_LEN_OFF/BLE_MAGIC1/BLE_MAGIC2/prepareBleShims}` (7 VHCI symbols); `core/thread_shims.mjs{THREAD_HOOKS/prepareThreadShims(elf,chip,opts)}` (`opts.joiner`, `opts.tickDivShift`, `THREAD_STARTAT`/`THREAD_JOINER_BEACON`/`THREAD_TICK_DIV_SHIFT` env).
- MicroPython harness: `bootMpy({chip,binPath,elfPath,setup,gpioProbe})/replExec/calibrateGpioLive` — REPL over UART0, live GPIO discovery (see `spike/30-verify-mpy.mjs` per-chip quirks: H2 USB pins, ADC maps, PWM saturate, P4 low-pins).
- APC frames (`PROTOCOLS.md` §1, `core/uart.mjs:110-325`): `\x1b_<kind>…\x1b\\`, kinds `W/R/Q`(I2C) `S`(SPI) `N`(RMT) `A/V`(ADC) `P`(PWM) `I`(I2S) `C`(TWAI) `T`(touch) `D`(DAC) `M`(SDMMC) `F`(camera) `L`(LCD) `B`(BLE cmd)/`E`(legacy evt) `G/H`(15.4 TX/scan); nibble-encoded (`'a'+nibble`); batch ≥100000 (`AGENT.md` §6).

## 7. Browser worker + Pages demo (demo harness — NOT the OpenHW runner)

Deployed to GitHub Pages on every `main` push via `.github/workflows/pages.yml`
(build → upload-pages-artifact → deploy-pages; enable Pages → Source
"GitHub Actions" once in repo Settings). The artifact ships the UI shell
(`index.html/app.js/worker.js/index.mjs/core/pkg/*.js+wasm/loader+devices+
observers`), root C3 samples (68 files, ~368 MB — the preset dropdown's ONLY
firmware source), and C3 BLE sketch builds (built in-CI, never committed).
Excluded: per-chip `samples/c5-c6-h2-p4-mpy`, `pkg.prev*`, gateway Go sources,
`spike/build` (not fetched by the UI; keeps the artifact small). Gateway-backed
features degrade gracefully with no gateway (WiFi/BLE-radio need `ws://`).

`worker.js` main→worker (19 cases): `init/load/start/stop/step/reset/
uart_input/gpio_set/mem_read/net_connect/net_disconnect/ble_connect/
ble_disconnect/ble_set_mode/sd_upload_img/sd_download_img/adc_set_pin/
adc_set_raw/touch_set/twai_inject/set_batch_size`; worker→main (35 types):
`ready/patched/chip/loaded/uart_output/step/registers/status/
gpio_update{out,enable,outStr(BigInt),enableStr,chip}/mem_data/calibrated/
ble_hci/ble_status/twai_activity/adc_activity/pwm_activity/sd_activity/
sd_status/sd_disk_data/touch_activity/dac_activity/sdmmc_activity/
camera_frame/lcd_frame/thread_activity/oled_frame/tft_frame/neopixel_frame/
spi_activity/i2c_activity/i2s_audio/net_status/restarted/reset/error`.
`pollGpio()` posts only on change (BigUint64 + 56-bit mask); loop = `run_batch`
+ stream-split + `pumpReplies` every batch incl silent ones. OpenHW drives
`index.mjs` directly (§8), not this worker.

## 8. OpenHW component contract (this repo exposes; openhw-studio builds the runner)

1. Load: `ESP32C3.create({chip})` (board type per `CHIPS`; `?instance=N` handled internally); `loadFirmware(mergedBin, elf, shimOpts?)` → `patched[]`; `restart()` soft reset; `dispose()` teardown.
2. Tick: `step(≥100000)` per frame; `pc/cycles` → sim-time; `getRegister(i)` regs; `readMemory/writeMemory` inspect. Chunk-boundary PC only.
3. GPIO: `gpio.pin(n).addListener((level,isOutput)=>…)` (count `CHIPS[chip].pins`); `gpio.onActivity((out,en)=>…)`; `pin(n).setInput(level)` ← UI. Low-32-bit masks.
4. UART: `uart0.onData(text)` → TX; `uart0.write(bytes)` ← RX. No baud API.
5. I2C: `i2c.register(addr,{i2cWrite,i2cRead})`; `onWrite/onRead/onActivity` → signals. Watch the two bus dialects (§5).
6. SPI: `spi.register(name|cs,dev)`; `onTransfer` loopback; `onWrite/onActivity` → signals.
7. Analog/audio/CAN + virtual devices per §5 (stimulus vs guest-driven directions as listed).
8. Radio: `setWifi/wifiRxPush/wifiTxDrainSplit` (C3/C6); `uart0.ble.onHci` + `BleHciPump`; `thread.onActivity` (`frame.n` cursors). Gateway wire rules in `openhw-studio-gateway/ESP-EMU-INTEGRATION.md` — rooms owned by the OpenHW agent.
9. Firmware pipeline: fqbn `esp32:esp32:esp32cX` → merged-bin+elf are the ONLY loader artifacts (§4 names).
10. Debug: `planHooks` tiers; `patched[]`; `observe_*.mjs` proofs; inspector report fns.
