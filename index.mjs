// esp-rv32-js SDK Root Entry Point
// Pure WebAssembly MCU Core Engine for Espressif RISC-V Microcontrollers
//
// OpenHW / Wokwi-style hosts: import everything board/component code needs
// from here (never deep-import core/* — paths are internal and may move).
// Component contract: create → loadFirmware → step in a rAF/frame loop,
// attach peripherals via the controller listeners below.

export { ESP32C3 } from './core/esp32c3.mjs';
export { GPIOPin, GPIOController, CHIP_GPIO_COUNT } from './core/gpio.mjs';
export { I2CBus } from './core/i2c.mjs';
export { SPIBus } from './core/spi.mjs';
export { ADCController } from './core/adc.mjs';
export { PWMController } from './core/pwm.mjs';
export { I2SController } from './core/i2s.mjs';
export { TWAIController } from './core/twai.mjs';
export { UARTController } from './core/uart.mjs';
export { TouchController } from './core/touch.mjs';
export { DACController } from './core/dac.mjs';
export { SDMMCController } from './core/sdmmc.mjs';
export { CameraController } from './core/camera.mjs';
export { LCDController } from './core/lcd.mjs';
export { NeoPixelController } from './core/neopixel.mjs';
export { ThreadController } from './core/thread_controller.mjs';
export { BLEController, HCI_COMMAND_NAMES } from './core/ble_controller.mjs';
export { BLEMirror } from './core/ble_mirror.mjs';
export { BleHciPump, BLE_LOCAL_OPS } from './core/ble_hci_pump.mjs';
export { ReplyDribbler } from './reply_queue.mjs';
// Loader / image surgery (for hosts that build their own runner instead of
// using ESP32C3.loadFirmware): ELF symbols, hook planner, flash reseal.
export { Elf32, HOOK_TARGETS, makeJal, planHooks, prepareSpiShims, prepareIdfShims } from './elf.mjs';
export { EspImage } from './espimage.mjs';
export { UART0_BASE, SPI_BUS_BASE, I2C_CELL_BASE, SHIMS, relocateShimsForChip } from './shims.mjs';
// Virtual devices + helpers for wiring circuits (displays, sensors, storage).
export {
    I2CBus as PeriphI2CBus, SPIBus as PeriphSPIBus, GenericSPIDevice,
    NeoPixelStrip, ST7789Device, SSD1306Device, MPU6050Device, VirtualSDCard,
    VirtualADC, VirtualPWM, VirtualI2S, VirtualTWAI, VirtualTouch, VirtualDAC,
    VirtualSDMMC, VirtualCamera, VirtualLcdPanel,
    calcCrc16, createDefaultFat16Image,
} from './peripherals.mjs';
// Headless observers (same pipeline as the browser Peripheral/BLE monitors).
export { PeripheralInspector, buildPeripheralReport, formatPeripheralReport, diffPeripheralReports, formatPeripheralDiff } from './spike/peripheral_inspector.mjs';
export { BleInspector, parseLine } from './spike/ble_inspector.mjs';
export { buildReport, formatReport, renderEvent, diffReports, formatDiff } from './spike/ble_report.mjs';
// Shim internals for custom runners (advanced): BLE/Thread patch builders,
// RV32I assembler, and the MicroPython REPL harness (bootMpy/replExec +
// live GPIO calibration). Most hosts never need these (loadFirmware covers
// it), but OpenHW-style runners that pre-inspect firmware do.
export { BLE_SCRATCH, BLE_CB_OFF, BLE_FLAG_OFF, BLE_EVT_OFF, BLE_LEN_OFF, BLE_MAGIC1, BLE_MAGIC2, prepareBleShims } from './core/ble_shims.mjs';
export { THREAD_HOOKS, prepareThreadShims } from './core/thread_shims.mjs';
export { T0, T1, T2, T3, T4, T5, A0, A1, A2, A3, A4, A5, A6, A7, S0, S1, SP, RA, ZERO, lui, addi, sw, lw, sb, lbu, andi, srli, slli, beq, bne, bge, add, or, lb, jal, ret, jalr_ra, jalr, li, asm32, assemble } from './core/rvasm.mjs';
export { bootMpy, calibrateGpioLive, replExec } from './spike/mpy_repl.mjs';

// Board metadata for component hosts (mirrors app.js CHIP_GPIO_COUNT plus
// wireless/capability flags from AGENT.md §1 / PROTOCOLS.md §2).
export const CHIPS = {
    esp32c3: { pins: 22, arch: 'RV32IMC', mhz: 160, wifi: 4, ble: 5, dot154: false, twai: true, rom: 'ESP-ROM:esp32c3-api1-20210207' },
    esp32c6: { pins: 30, arch: 'RV32IMAC', mhz: 160, wifi: 6, ble: 5, dot154: true, twai: true, rom: 'ESP-ROM:esp32c6-20220919' },
    esp32h2: { pins: 19, arch: 'RV32IMAC', mhz: 96, wifi: 0, ble: 5, dot154: true, twai: true, rom: 'ESP-ROM:esp32h2-20221101' },
    esp32c5: { pins: 29, arch: 'RV32IMAC', mhz: 240, wifi: 6, ble: 5, dot154: true, twai: false, rom: 'ESP-ROM:esp32c5-eco2-20250121' },
    esp32p4: { pins: 56, arch: 'RV32IMAFC', mhz: 400, wifi: 0, ble: 0, dot154: false, twai: true, rom: 'ESP-ROM:esp32p4-20230811', romElf: 'samples/p4/esp32p4_rev0_rom.elf' },
    esp32s31: { pins: 60, arch: 'RV32', mhz: 320, wifi: 6, ble: 5.4, dot154: true, twai: false, rom: 'ESP-ROM:esp32s31-20251218', smokeOnly: true },
};
