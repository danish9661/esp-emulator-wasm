// ESP32-S31 target smoke test (esp-emu 0.41→0.43).
//
// S31 firmware samples are BLOCKED: no Arduino core and no ESP-IDF toolchain
// in this environment can target S31, so no .merged.bin/.elf can be built and
// shim addresses (UART0/SPI/bus bases) cannot be validated. This script locks
// in what IS verified:
//   1. The `esp32s31` target constructs and ships an embedded default ROM.
//   2. Foreign images are rejected by chip-ID validation (S31 expects 0x20).
//   3. A chip-ID 0x20 image reaches the real S31 ROM (banner observed).
//   4. Shim bases stay null (C3 fallback) — relocateShimsForChip,
//      BLE_SCRATCH, I2C_CELL_BASE, SPI_BUS_BASE and UART0_BASE must NOT gain
//      guessed S31 addresses (a wrong base bricks every future S31 image;
//      the GPIO calibrator's wide scan is the only S31-safe discovery).
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

// 1. Target constructs, embedded ROM present.
{
    const mcu = await ESP32C3.create({ chip: 'esp32s31' });
    const ok = mcu.emu.has_default_rom();
    console.log(`S31 target constructs + embedded ROM: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error('S31 has no default ROM');
}

// 2. Chip-ID gate: a C3 image (id 0x05) must be rejected for esp32s31 (0x20).
{
    const mcu = await ESP32C3.create({ chip: 'esp32s31' });
    let err = '';
    try {
        await mcu.loadFirmware(new Uint8Array(readFileSync('samples/blink.merged.bin')), null);
    } catch (e) { err = String(e.message || e); }
    const ok = /0x0020/.test(err) && /esp32s31/.test(err);
    console.log(`S31 chip-ID gate rejects C3 image: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error('S31 chip-ID gate broken: ' + err.slice(0, 120));
}

// 3. A chip-0x20 image reaches the S31 ROM (banner). The probe image is a
// bare app image forged by spike/mkimg.py (`CHIP_ID['esp32s31'] = 0x20`,
// checked in as spike/s31_probe.bin) — no S31 2nd-stage bootloader exists
// here, so the ROM stops at "invalid header" after its banner. The banner
// is the assertion.
{
    const mcu = await ESP32C3.create({ chip: 'esp32s31' });
    await mcu.loadFirmware(new Uint8Array(readFileSync('spike/s31_probe.bin')), null);
    let t = '';
    mcu.uart0.onData((c) => { t += c; });
    for (let i = 0; i < 200; i++) mcu.step(100000);
    const ok = t.includes('ESP-ROM:esp32s31-');
    console.log(`S31 ROM banner via forged image: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error('S31 ROM banner missing: ' + JSON.stringify(t.slice(0, 120)));
}

// 4. Shim bases stay null for S31 (C3 fallback — never a guessed base).
{
    const { UART0_BASE, SPI_BUS_BASE, I2C_CELL_BASE } = await import('../shims.mjs');
    const { BLE_SCRATCH } = await import('../core/ble_shims.mjs');
    const nulls = [UART0_BASE.esp32s31, SPI_BUS_BASE.esp32s31,
        I2C_CELL_BASE.esp32s31, BLE_SCRATCH.esp32s31];
    const ok = nulls.every((v) => v === null || v === undefined);
    console.log(`S31 shim bases null (C3 fallback): ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error('S31 gained a guessed shim base — revert to null until toolchain firmware validates it');
}

console.log('\nS31 SMOKE PASSED (target live; firmware blocked on toolchain) ✅');
