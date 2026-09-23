#pragma once
// emu_api.h — OPTIONAL helper declaring patch targets for the esp-emu
// virtual peripherals (touch/DAC/SDMMC/camera/LCD).
//
// Two ways to run firmware here, both honest:
//
// 1. UNMODIFIED firmware (no helper, no source changes): anything built on
//    the standard vendor HAL (GPIO/I2C/SPI/ADC/PWM/I2S/TWAI/USB/BLE/WiFi/
//    timers/filesystems — everything with real silicon behind it) loads and
//    runs as-is. Drawback: the five virtual peripherals have NO silicon and
//    no vendor HAL symbol, so without this header their calls are simply
//    unavailable (link error on chips without the peripheral, or an error
//    sentinel at runtime). The firmware still boots and everything else
//    works — that is the previous system, and it works fine.
// 2. HELPER firmware (include this header): the source gains patch targets
//    for the virtual peripherals, and the built .bin + .elf still load
//    as-is with zero POST-COMPILATION changes — the loader overwrites each
//    symbol with its RV32 shim at load time. The emu_api.cpp bodies are
//    link-time fallbacks that run ONLY outside the emulator.
//
// It declares ONLY the symbols the loader knows how to patch (see
// HOOK_TARGETS in elf.mjs: virtual-touch/dac/sdmmc/camera/lcd).
//
// Patch-space rule: every fallback body must be LARGER than its shim (the
// loader only patches when shim.length <= func size — a smaller fallback
// would silently stay unpatched). All shims except dacDisable need >= 512
// NOPs + 160 scratch words; dacDisable's shim is an 8B noop so its body is
// intentionally tiny (but never smaller than the shim). Do not shrink the
// EMU_API_PAD bodies.
//
// Usage:
//   #include "emu_api.h"   // copy emu_api.h + emu_api.cpp into the sketch
//                          // dir (arduino-cli only compiles files inside it)
//
// Standard-HAL requirement: the emulator patches at the DRIVER SYMBOL
// level, so real-silicon peripherals MUST be driven through the standard
// Arduino/IDF HAL — that is what HOOK_TARGETS patches. Bit-banged
// GPIO/SPI/I2C cannot be intercepted from JS (needs an MMIO trap in the
// WASM core — upstream issue issue.md#1).

#include <Arduino.h>
#include <stdint.h>
#include "soc/soc_caps.h"

// --- Touch pad (APC kind 'T') -------------------------------------------
// Chips with native touch (e.g. P4, SOC_TOUCH_SENSOR_SUPPORTED=1) already
// declare these in the Arduino core; only declare the fallback otherwise.
#if !SOC_TOUCH_SENSOR_SUPPORTED
extern "C" {
uint16_t touchRead(uint8_t pin);
void touchAttachInterrupt(uint8_t pin, void (*fn)(void), uint16_t threshold);
void touchDetachInterrupt(uint8_t pin);
}
#endif

// --- DAC output (APC kind 'D') ------------------------------------------
// No C3/C6/H2 Arduino DAC hardware exists; the loader overwrites these
// with the 'D' shim. Unpatched: dacWrite reports failure (false).
extern "C" {
bool dacWrite(uint8_t pin, uint8_t value);
void dacDisable(uint8_t pin);
}

// --- SDMMC host, 4-bit SD bus, sector-level (APC kind 'M') ---------------
// The C3 has no SDMMC host; unpatched both calls return -1 (error).
extern "C" {
int emuSdmmcReadSectors(uint32_t lba, uint8_t *buf, uint32_t count);
int emuSdmmcWriteSectors(uint32_t lba, const uint8_t *buf, uint32_t count);
}

// --- Camera, grayscale test-pattern frames (APC kind 'F') ----------------
// No CSI hardware exists; unpatched returns -1. Pull the frame in small
// bands (512B): some chips cannot sink multi-KB host->firmware replies.
extern "C" {
int emuCameraReadBand(uint8_t *buf, uint32_t offset, uint32_t len);
}

// --- LCD panel, RGB565 bitmap blits (APC kind 'L') -----------------------
// The request uses 32-bit coordinate fields so the 'L' shim can `lw` them
// straight off the struct: { x1, y1, x2, y2 (u32), px (ptr), len (u32) }.
typedef struct {
  uint32_t x1, y1, x2, y2;
  const uint8_t *px;
  uint32_t len;
} EmuLcdReq;

extern "C" {
void emuLcdDraw(const EmuLcdReq *req);
}
