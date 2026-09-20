# espc3api.md — ESP32-C3/C6/H2/C5/P4/S31 (`esp-emu@0.42.0`) API + OpenHW gap spec

Probed from `espc3 wasm` (`index.mjs`, `core/*.mjs`, `pkg/esp_emu.js`,
`elf.mjs`, `shims.mjs`, `espimage.mjs`, `peripherals.mjs`, `worker.js`,
`PROTOCOLS.md`, `AGENT.md`, `openhw-studio-gateway/ESP-EMU-INTEGRATION.md`).
All names below dumped live (`node -e import(...)`, `grep ^export`); suite
counts are doc claims (`PROTOCOLS.md` §4–5), not re-run here. Fixed 2026-09-20:
GPIO per-chip counts (was hardcoded 22 — C6 pins 22+ were `undefined`),
`index.mjs` now the single component entry (68 names + `CHIPS` table), new
`setWifi/wifiRxPush/wifiTxDrainSplit/dispose` wrappers; §5 gap rewritten
without openhw-studio source claims (that tree is owned by the OpenHW agent).

## 1. Package layout

- `pkg/package.json`: `esp-emu` 0.42.0, ESM, Apache-2.0, `main esp_emu.js`,
  files = `esp_emu_bg.wasm` (3.4 MB) + `esp_emu.js` (17K, 518 lines).
- `index.mjs` re-exports 68 names (verified live): `ESP32C3`, all 14 on-chip
  controllers (`GPIOController`/`GPIOPin`/`CHIP_GPIO_COUNT`, `I2CBus`, `SPIBus`,
  `ADCController`, `PWMController`, `I2SController`, `TWAIController`,
  `UARTController`, `TouchController`, `DACController`, `SDMMCController`,
  `CameraController`, `LCDController`, `NeoPixelController`, `ThreadController`,
  `BLEController`/`HCI_COMMAND_NAMES`, `BLEMirror`, `BleHciPump`/`BLE_LOCAL_OPS`,
  `ReplyDribbler`), loader chain (`Elf32`, `HOOK_TARGETS`, `makeJal`,
  `planHooks`, `prepareSpiShims`, `prepareIdfShims`, `EspImage`, `UART0_BASE`,
  `SPI_BUS_BASE`, `I2C_CELL_BASE`, `SHIMS`, `relocateShimsForChip`), all 14
  virtual devices + `calcCrc16`/`createDefaultFat16Image` (I2C/SPI aliases are
  `PeriphI2CBus`/`PeriphSPIBus` — same modules, distinct bindings), observers
  (`PeripheralInspector`+report/diff, `BleInspector`/`parseLine`, report fns),
  and board table `CHIPS` (pins/arch/mhz/wifi/ble/15.4/twai/rom per chip).
  Rule: OpenHW imports ONLY from `index.mjs` (core/* paths are internal).
- `core/`: `esp32c3, gpio, uart, i2c, spi, adc, pwm, i2s, twai, touch, dac,
  sdmmc, camera, lcd, neopixel, ble_controller, ble_hci_pump, ble_mirror,
  ble_shims, thread_controller, thread_shims, rvasm` (22 files).
- Chips (`AGENT.md` §1, `PROTOCOLS.md` §2): `esp32c3` (RV32IMC 160M, WiFi4+BLE5,
  22 GPIO) / `esp32c6` (RV32IMAC 160M, WiFi6+BLE+15.4, 30 GPIO) / `esp32h2`
  (RV32IMAC 96M, BLE+15.4, 19 GPIO) / `esp32c5` (RV32IMAC 240M, 29 GPIO, no
  TWAI) / `esp32p4` (dual RV32IMAFC 400M, 56 GPIO) / `esp32s31` (smoke only,
  no toolchain). ROM banners per chip in `AGENT.md` §1.

## 2. `WasmEmulator` (`pkg/esp_emu.js`, wasm-bindgen, 20 protos incl `__destroy_into_raw`, verified live)

```
constructor(chip), __destroy_into_raw, free, cycles()->n, get_reg(i)->u32, pc()->u32,
run_batch(n)->string, restart(), needs_restart()->bool,
load_firmware(bytes), load_rom_elf(bytes), load_default_rom(),
load_app_elf(bytes), load_efuse(bytes), has_default_rom()->bool,
set_boot_from_rom(b), uart_input(bytes),
set_wifi_config(ssid, password), wifi_rx_push(bytes), wifi_tx_drain()->len-prefixed batch
```
(20 protos incl constructor; counted live via `Object.getOwnPropertyNames`.)

Node init MUST be `initSync({module: readFileSync(wasm)})` (same fetch-trap as
8086); browser uses `default(url)`. Multi-instance: per-instance
`?instance=N` cache-bust required — `core/esp32c3.mjs:94-101`, else pkg 0.42
shares one dlmalloc heap and corrupts (`issue.md#3`).

## 3. `ESP32C3` SDK (`core/esp32c3.mjs:29-333`, `index.mjs` entry)

`ESP32C3.create({chip, bootFromRom=true, wasmModuleUrl?})` → ctor builds
`gpio/i2c/spi/adc/pwm/i2s/twai/neopixel/touch/dac/sdmmc/camera/lcd/thread/uart0`
(P4 loads `samples/p4/esp32p4_rev0_rom.elf` instead of embedded ROM, `:107-117`).
`loadFirmware(flashBin, elfBin?, shimOpts?={thread}) → {patched[]}` (ELF HAL
trampolines + `EspImage.reseal()`). `step(n=100000) → clean serial`
(`run_batch` + `gpio.sync()` + `uart0.processOutputChunk` routing to all
controllers, `:254-274`). `pc/cycles/getRegister(i)/readMemory/writeMemory/restart`
+ component wrappers `setWifi(ssid,pass)/wifiRxPush(bytes)/wifiTxDrainSplit()→Uint8Array[]`
(pre-split, gateway rule: one raw frame per WS message) and `dispose()`.

Controllers (each `…/core/<name>.mjs`): `GPIOController{chip, pinCount, pin(n)→GPIOPin{addListener/removeListener/setInput}, setInput, getPinLevel, isOutput, onActivity, setBaseAddrs, sync, bindMemory}` (per-chip counts via `CHIP_GPIO_COUNT`: 22/30/19/29/56/60; low-32-mask model — pins >31 API-visible, sim-limited; auto-calibrate `gpio.mjs`);
`UARTController{write, onData, processOutputChunk, bindMemory}` + `ReplyDribbler`
(`reply_queue.mjs:12`, ≤16 B slices); `I2CBus{register/unregister, onWrite/onRead/onActivity, write, read}`;
`SPIBus{register/unregister, onTransfer/onWrite/onActivity, transferByte, write}`;
`ADCController{setVoltage/setRaw/getVoltage/readRaw/readMilliVolts/onSample}`;
`PWMController{getDuty/getPercent/update/onUpdate}`; `I2SController{writePcm/onAudio}`;
`TWAIController{inject/transmit/popRxFrame/onActivity}`;
`TouchController{setTouched/attachInterrupt/detachInterrupt/getRaw/read/onActivity}`;
`DACController{write/getChannel/onActivity}`; `SDMMCController{readSectors/writeSectors/writeChunk/sectorCount/onActivity}`;
`CameraController{capture/readBand/onFrame}` (96×96 gray); `LCDController{drawBitmap/onFrame}`
(240×240 RGB565); `NeoPixelController{update/getFrame/onFrame}`;
`BLEController{handle/onHci}` + `BLEMirror{discover/deliver/clear}` shared-mem event channel +
`BleHciPump{setMode/setTransport/handleBFrame/handleWsMessage}` (local/Bumble, gaps `0xfc01`/`0x204e` stay local); `ThreadController{handle/handleScan/onActivity/reset}` (256-frame ring — cursors must use `frame.n`).
Virtual devices (`peripherals.mjs` 19 exports): `I2CBus/SPIBus` (bus aliases — device fns are `onWrite`/`onRead`/`onTransferByte`, NOT `i2cWrite`; the `core/` controllers use `i2cWrite`/`i2cRead`/`spiTransferByte` — check the bus you attach to), `SSD1306/ST7789/MPU6050/NeoPixelStrip/GenericSPIDevice/Virtual{SDCard,ADC,PWM,I2S,TWAI,Touch,DAC,SDMMC,Camera,LcdPanel}`
+ `calcCrc16/createDefaultFat16Image`. Headless observers: `PeripheralInspector{feed/add}` + report/diff fns; `BleInspector/parseLine` + report fns (same pipeline as the browser monitors; see `spike/observe_peripheral.mjs`, 18 presets).

Load-time patching: `elf.mjs{Elf32, HOOK_TARGETS, makeJal, planHooks,
prepareSpiShims, prepareIdfShims}` (hook groups: arduino-i2c/spi/neopixel/adc/pwm,
mp-adc/mp-pwm, idf-usb/i2s/twai, virtual-touch/dac/sdmmc/camera/lcd,
idf-i2c-v5/legacy, idf-spi, thread-15d4); `shims.mjs{UART0_BASE, SPI_BUS_BASE,
I2C_CELL_BASE, SHIMS, relocateShimsForChip}` (RV32I-only bytecode, all chips);
`espimage.mjs:20{EspImage}`; `core/rvasm.mjs` (lui/addi/lw/sw/sb/beq/bne/jal/ret…);
`core/ble_shims.mjs` (7 VHCI symbols) + `core/thread_shims.mjs`.
APC frames (`PROTOCOLS.md` §1, `core/uart.mjs:110-325`): `\x1b_<kind>…\x1b\\`,
kinds `W/R/Q`(I2C) `S`(SPI) `N`(RMT) `A/V`(ADC) `P`(PWM) `I`(I2S) `C`(TWAI)
`T`(touch) `D`(DAC) `M`(SDMMC) `F`(camera) `L`(LCD) `B`(BLE cmd)/`E`(legacyevt)
`G/H`(15.4 TX/scan); nibble-encoded (`'a'+nibble`); batch ≥100000 (`AGENT.md` §6).

## 4. Samples / worker / gateway

- `samples/`: 34 root `.elf + .merged.bin` (lowercase demos: adcpwm, blink,
  busprobe, camera, dac, i2cread, i2s, idfi2c, idfi2c_legacy, idfspi, lcd,
  littlefs, neopixel(+NeoPixelDemo dup), nvs, oled(+OLEDDemo dup), rtc,
  sdcard(+SDCardDemo dup), sdmmc, spidemo, st7789(+ST7789Demo dup),
  threaddemo_{c6,c6b,h2,c5} (4 Thread builds, NOT in c6/h2 dirs), timer,
  touch, twai, usbserialjtag, wdt, wifidemo) + `c5/` (22: stock 17 +Timer/WDT/
  RTC/NVS/LittleFS, NO twai — silicon gap) + `c6/` (18: stock 15 +IDFSPIDemo/
  IDFI2CDemo/IDFI2CLegacyDemo) + `h2/` (18, same shape as c6) + `p4/` (19 .elf
  / 18 .bin +`esp32p4_rev0_rom.elf` for `create()` P4 ROM boot) + `mpy/`
  (`mpy_{c3,c5,c6,h2,p4}.{bin,elf}` + `mpy_{c5,p4}_flash.bin` composed flashes).
- `worker.js` main→worker (19 cases, `:827-1001`): `init/load/start/stop/step/
  reset/uart_input/gpio_set/mem_read/net_connect/net_disconnect/ble_connect/
  ble_disconnect/ble_set_mode/sd_upload_img/sd_download_img/adc_set_pin/
  adc_set_raw/touch_set/twai_inject/set_batch_size`; worker→main (35 types):
  `ready/patched/chip/loaded/uart_output/step/registers/status/
  gpio_update{out,enable,outStr(BigInt),enableStr,chip}/mem_data/calibrated/
  ble_hci/ble_status/twai_activity/adc_activity/pwm_activity/sd_activity/
  sd_status/sd_disk_data/touch_activity/dac_activity/sdmmc_activity/
  camera_frame/lcd_frame/thread_activity/oled_frame/tft_frame/neopixel_frame/
  spi_activity/i2c_activity/i2s_audio/net_status/restarted/reset/error`.
  `pollGpio()` posts only on out/enable change (`:795-820`, BigUint64 + 56-bit
  mask); loop = `run_batch` + stream-split + `pumpReplies` every batch incl.
  silent ones. NOTE: this browser worker is a demo harness, NOT the OpenHW
  runner — OpenHW drives `index.mjs` directly (see §6).
- `openhw-studio-gateway/` (Go, `ws://HOST:5095`): `/api/network-gateway`
  (raw eth frames, one/msg, answer own ARP, DHCP intercepted `192.168.4.x`),
  `/api/ble-gateway` (H4→Bumble TCP), `/api/thread-gateway?sessionId=` (room
  broadcast). WiFi verified E2E via `set_wifi_config/wifi_rx_push/wifi_tx_drain`
  (`ESP-EMU-INTEGRATION.md`).

## 5. OpenHW gap (what the OpenHW agent still has to build)

This section lists runner-side work ONLY — no claims about openhw-studio
sources (unread from here; owned by the OpenHW agent). What this repo now
provides for each item is noted in brackets.

- Board runner: no ESP32-Cx runner exists yet — needs create/load/step loop
  around §6 items 1–2 [provided: `ESP32C3.create/loadFirmware/step`,
  `CHIPS` table, `patched[]` diagnostics].
- Component wiring: GPIO/I2C/SPI/analog/audio/CAN/virtual-device listeners
  per §6 items 3–8 [provided: all controllers + `CHIP_GPIO_COUNT` +
  `Periph*` device models + `observe_peripheral.mjs` proofs].
- Radio glue: WiFi frames, BLE HCI, Thread TAP records to gateway rooms
  [provided: `wifiTxDrainSplit` (pre-split), `BleHciPump`, `thread.onActivity`;
  gateway wire rules in `openhw-studio-gateway/ESP-EMU-INTEGRATION.md` —
  do not edit gateway sources from here].
- Firmware pipeline: board entries need fqbn `esp32:esp32:esp32cX` builds
  producing merged-bin+elf artifacts [provided: `samples/` layout + §6.10
  build commands; merged-bin/elf are the ONLY artifacts the loader needs].

## 6. OpenHW component contract (this repo exposes; openhw-studio builds the runner)

Scope: this repo (`espc3 wasm`) exposes the board/component API below. The
`openhw-studio-gateway/` tree (Go gateway + rooms) and any OpenHW runner/board
registry live OUTSIDE this repo — owned by the OpenHW agent. Do not edit
gateway sources for esp-emu fixes.

Import: everything from `index.mjs` (68 names; core/* paths are internal).

1. Load: `ESP32C3.create({chip})` (board type per `CHIPS`; Node does the
   `?instance=N` cache-bust internally — no caller action); `loadFirmware(
   mergedBin, elf, shimOpts?)` → record `patched[]`; `restart()` = soft reset
   (full reload = `loadFirmware` again); `dispose()` on teardown.
2. Tick: `step(≥100000)` per frame (never smaller — H2/P4 drop UART tails);
   `pc/cycles` → sim-time; `getRegister(i)` → regs; `readMemory/writeMemory`
   → memory inspect. No per-instruction stepping (chunk-boundary PC only).
3. GPIO: `gpio.pin(n).addListener((level,isOutput)=>…)` per pin (count from
   `CHIPS[chip].pins` — 22/30/19/29/56/60) + `gpio.onActivity((out,en)=>…)`
   global; `pin(n).setInput(level)` ← UI drive; `setBaseAddrs` seed only for
   UART-TX-stuck images (else auto-calibration). Masks are low-32-bit.
4. UART: `uart0.onData(text)` → serial TX; `uart0.write(bytes)` ← serial RX.
   No baud API (record-only at the host).
5. I2C: `i2c.register(addr,{i2cWrite,i2cRead})` per device (SSD1306 0x3c/0x3d,
   MPU6050 0x68); `i2c.onWrite/onRead/onActivity` → component signals.
   NOTE the two bus dialects: `core/I2CBus` devices implement
   `i2cWrite/i2cRead`, `peripherals/I2CBus` devices implement `onWrite/onRead`
   — match the bus you attach to (suites use the `core` spelling).
6. SPI: `spi.register(name|cs,dev)` (`onTransferByte`/`onWrite` or
   `spiTransferByte`/`spiWrite` aliases both accepted); `spi.onTransfer(bytes→
   reply)` loopback rig; `spi.onWrite/onActivity` → signals.
7. Analog/audio/CAN: `adc.setVoltage(pin,V)/setRaw` stimulus + `onSample`;
   `pwm.update` is guest-driven (read via `getDuty/getPercent/onUpdate`);
   `i2s.writePcm` guest-driven (`onAudio` → PCM Float32); `twai.inject(frame)`
   → guest RX, `transmit` → host TX (`onActivity`, `popRxFrame` internal).
8. Virtual devices: `touch.setTouched/attachInterrupt` (+`read`), `dac.write`,
   `sdmmc.readSectors/writeSectors/writeChunk`, `camera.capture/readBand`,
   `lcd.drawBitmap`, `neopixel.update/getFrame` — all with `onFrame/onActivity`
   listeners. SD-SPI (`VirtualSDCard`): `loadDisk/getDisk`, `onActivity`.
9. Radio: `setWifi/wifiRxPush/wifiTxDrainSplit` (native WASM glue, C3/C6; one
   raw frame per message to the gateway); `uart0.ble.onHci` + `BleHciPump`
   (local vs Bumble modes, `BLE_LOCAL_OPS` stay local); `thread.onActivity`
   (`G/H` tap records; 256-ring — use `frame.n` cursors).
10. Debug/telemetry: `planHooks(elf)` → hook tiers; `patched[]` → what applied;
    headless proofs `spike/observe_peripheral.mjs` (18 presets incl. idfspi/
    idfi2c/idfi2clegacy) and `observe_ble.mjs --hci`; reports via
    `PeripheralInspector`/`BleInspector` fns (same as the browser monitors).

(End of file — OpenHW runner + gateway integration owned by the OpenHW agent.)
