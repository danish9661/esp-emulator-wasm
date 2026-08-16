# AGENT.md — Wokwi-style Peripheral Layer for `esp-emu` WASM

Plan for adding GPIO / I2C / SPI virtual peripherals to this browser-based ESP32-C3
emulator, **without requiring users to modify or rebuild their firmware**.

---

## 1. Established facts

All of the below was verified by inspecting `pkg/esp_emu_bg.wasm` directly
(export table + embedded Rust source paths). There is no Rust source in this repo —
only the compiled artifact.

### 1.1 What the WASM exposes to JS

`WasmEmulator` exports exactly these methods:

| Method | Purpose |
| --- | --- |
| `load_rom_elf` / `load_default_rom` / `has_default_rom` | ROM image |
| `load_firmware` | Flash image or ELF |
| `load_app_elf` | **App ELF for BLE symbol interception** |
| `load_efuse` | eFuse blob |
| `run_batch(n) -> string` | Step N instructions, returns merged console output |
| `pc()`, `cycles()`, `get_reg(i)` | CPU introspection |
| `restart()`, `needs_restart()`, `set_boot_from_rom()` | Reset control |
| `uart_input(Uint8Array)` | Console input |
| `wifi_rx_push` / `wifi_tx_drain` / `set_wifi_config` | Networking |

There are **no** `gpio_*`, `i2c_*`, or `spi_*` exports.

### 1.2 The WASM `memory` export is available

The export table includes `mem memory`. `await init()` returns the exports object
(`pkg/esp_emu.js:434`), so `wasmExports.memory.buffer` gives full read/write access
to the entire emulator state from JS.

`worker.js:23` currently discards this:

```js
await init();                       // current — discards exports
const wasmExports = await init();   // needed — exposes .memory
```

### 1.3 Which peripherals are actually emulated

From Rust source paths embedded in panic strings:

**Emulated:** `gpio.rs`, `rmt.rs`, `uart.rs`, `usbjtag.rs`, `systimer.rs`,
`timer_group.rs`, `gdma.rs`, `efuse.rs`, `spimem.rs` (flash controller only),
`wifi_mac.rs`, `openeth.rs`, `aes/sha/rsa/hmac/ecc/ecdsa`, `intc.rs`, `clic.rs`.

**NOT emulated:** there is no `i2c.rs` and no SPI *master* peripheral.
Every `i2c` string in the binary is a ROM symbol (`rom_i2c_readReg_Mask`) — the
internal analog bus used for PLL configuration, not the user-facing I2C controller.

**Consequence (measured, not predicted):** a real Arduino `Wire` sketch was compiled
and booted (`spike/sketches/I2CProbe`). It does **not** crash or hang:

```
i2c-begin
i2c-inited
endTransmission=4      <- Arduino Wire "other error"
i2c-done
```

So the I2C register region is tolerated (reads return benign values, no bus fault) and
IDF's driver errors out cleanly instead of stalling. The failure mode is **graceful
degradation, not a crash** — an earlier draft of this plan predicted a hang; that was
wrong.

What remains true: there is **no I2C functionality**. No ACK, no data, no device ever
responds. Every transaction fails with error 4, and the timeout burns ~7e9 cycles.
The shim is still required to make I2C sketches *work* — it is just not required to
keep them from crashing.

### 1.4 Source availability

The underlying WebAssembly core binary is built from Espressif's open-source
[`esp-emulator`](https://github.com/espressif/esp-emulator) crate (version 0.39.0, Apache-2.0).

---

## 2. Architecture decision

### 2.1 Rejected: helper component compiled into the firmware

Workable, but the user must add a component to every project, it inflates the
shipped binary, and the resulting artifact is no longer the one that runs on real
hardware. Rejected on those grounds.

### 2.2 Chosen: load-time binary patching in the browser

Precedent exists inside the emulator itself: `load_app_elf` is documented as
*"Load application ELF for BLE symbol interception"* — the emulator already reads an
unmodified app ELF's symbol table and intercepts firmware calls by name. That hook
list is hardcoded to BLE symbols in Rust and is not extensible from JS, so we
reimplement the same pattern in JavaScript.

**Build time (once, by us):** compile a small RISC-V shim, extract `.text` as raw
bytes, commit as `shim.bin`. It ships with the *simulator*, never with user firmware.

**Load time (per run, in the worker):**

1. Parse the user's ELF symbol table in JS (`elf.mjs`).
2. Resolve target symbols (I2C/SPI driver entry points) and pick a hook tier (§7).
3. Overwrite each target function's body with the shim blob (`espimage.mjs`).
4. Re-seal the image: checksum + SHA256.
5. Hand the patched image to `load_firmware()`.

The shim **replaces** the function rather than resuming it: emit payload →
set `a0 = ESP_OK` → `ret` to the caller.

> An earlier revision planned to append the shim by extending the last `PT_LOAD`
> segment and jump to it via `auipc`+`jalr`. That proved unnecessary — every shim so
> far fits inside the function it replaces (see Phase 2), so there is no trampoline
> and no segment surgery. Revisit only if a shim outgrows its host function.

**Outcome:** user runs a plain `arduino-cli compile` / `idf.py build`. The identical
binary flashes to real hardware and runs in the simulator.

---

## 3. Transport and protocol

### 3.1 Framing

`run_batch()` returns a single merged console string (`pkg/esp_emu.js:181`) and there
is exactly one `uart_input()`. The protocol therefore shares one pipe with `printf`.

Wrap frames in ANSI **APC** (`ESC _ … ESC \`). Terminals — including xterm.js —
silently discard unrecognized APC strings, so console output stays clean even if a
frame leaks through. Strip APC frames in the worker before forwarding `uart_output`.

**Implemented and verified** — see Phase 3 for the frame layout and results.

### 3.2 Peripheral models live in the worker

A blocking I2C read requires a synchronous guest → JS → guest round trip.
`worker.js:220-248` runs batches in a tight 12ms loop and only drains messages when
it yields. If peripheral models live in `app.js`, every sensor read costs a
`postMessage` hop **plus up to 12ms of guest spin**.

Put the SSD1306 / BME280 / etc. models **inside the worker**, answer requests between
`run_batch()` calls, and forward only render state to the main thread.

---

## 4. Phase 0 — RESOLVED ✅

The read path works. Verified with bare-metal RV32 firmware (`spike/08-uart-roundtrip.mjs`):

```
sent "Hi"  -> got "Ij"   PASS
sent "ABC" -> got "BCD"  PASS
```

Answers to the two unknowns:

1. **`uart_input()` feeds UART0** (`0x60000000`). Pushing 3 bytes moved
   `UART_STATUS_REG` (`0x6000001C`) low byte from `0x00` to `0x03` — that field is
   `RXFIFO_CNT`.
2. **No console driver is needed.** Bare-metal code polling `RXFIFO_CNT` and reading
   the FIFO at `0x60000000` receives host bytes directly. The shim can own the RX
   path without fighting IDF's VFS layer.

**Shim RX pattern (validated):**

```
poll UART_STATUS_REG (0x6000001C), mask 0xFF   ; RXFIFO_CNT
if nonzero: lw from UART_FIFO (0x60000000)      ; pop one byte
write to UART_FIFO                              ; TX
```

Remaining caveat: this was proven bare-metal. Under a real IDF app the console driver
also drains that FIFO, so shim and console will race. Mitigation: the shim should
drain into its own buffer and re-inject non-protocol bytes, or the protocol should
use a byte range the console never emits (see APC framing, §3.1).

---

## 5. Phases

### Phase 0 — Read-path spike ✅ DONE
Resolved; see §4. UART0 round trip works bare-metal.

### Test rig

**Two ways to produce firmware. Both work.**

**A. Real Arduino builds — `arduino-cli` is installed.**

```sh
export PATH=$HOME/bin:$PATH        # arduino-cli lives at ~/bin, not on PATH
arduino-cli compile --fqbn esp32:esp32:esp32c3 \
    --output-dir spike/build/<Name> spike/sketches/<Name>
node spike/run-serial.mjs spike/build/<Name>/<Name>.ino.merged.bin
```

`arduino-cli` 1.5.1, esp32 core **3.3.10**, board `esp32:esp32:esp32c3`. This is the
preferred rig — it produces the real app image **and an ELF with a full symbol table**
(~6.4 MB), which is exactly what Phase 1 needs.

**B. Hand-assembled probes — no toolchain needed.** `spike/mkimg.py` assembles RV32
and emits ESP app images directly. Useful for tiny deterministic experiments where a
6 MB Arduino build would drown the signal.
Modes: `blink`, `gpio <out> <en>`, `readgpio`, `readreg <addr>`, `blinkread`, `uartecho`.

### ⚠ Correct boot procedure — load `merged.bin`, boot from ROM

This is not what `worker.js` currently does and it matters:

| Input | `bootFromRom` | Result |
| --- | --- | --- |
| `<Name>.ino.bin` (app only) | `false` | **Crashes** — core dump, `Rebooting...` |
| `<Name>.ino.merged.bin` (full flash) | `true` | **Boots correctly** |

A correct boot prints the ROM banner, then the bootloader segment loads, then the
sketch runs:

```
ESP-ROM:esp32c3-api1-20210207
rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)
load:0x3fcd5820,len:0x110c
entry 0x403cbf10
blink-start          <- sketch output
```

The app image alone skips bootloader and partition setup. Feed the **merged** image
and let the ROM boot it. `worker.js:55` (`set_boot_from_rom(!msg.skipRom)`) and the
`msg.firmware` it is handed should be reviewed against this.

- Node lives at `~/emsdk/node/24.19.0_64bit/bin/node` (not on `PATH`).
- `spike/harness.mjs` — boots the wasm headless via `initSync(bytes)`, returns
  `{ emu, wasm, memory }`.
- `load_firmware` accepts an **ESP image** (magic `0xE9`), *not* an ELF — an ELF is
  rejected with `Invalid image magic: 0x7F`.

**Implication for §2:** the patch target is the ESP image format, not a raw ELF, so
Phase 2 must recompute the image checksum byte (and SHA256 when `hash_appended` is
set). `spike/mkimg.py:build_esp_image` already implements the checksum.
Symbols for the patcher come from the separate `.ino.elf`.

### Phase 1 — ELF symbol resolution ✅ DONE
`elf.mjs` — ELF32/RISC-V reader: section + program headers, `.symtab`/`.strtab`,
`vaddrToFileOffset()`, `resolve()`, `planHooks()`. Verified on three real Arduino
ELFs (§7). Run it with `node spike/10-symbols.mjs <file.ino.elf>`.

### Phase 2 — Image patching ✅ DONE
`espimage.mjs` — finds the app image inside a merged flash image, maps vaddr →
image offset, patches bytes, and re-seals (checksum + SHA256).

Format assumptions were validated against a real Arduino build *before* patching:
`verify() -> { checksum: true, sha256: true }` on the untouched image.

**Proof of the pipeline:** overwriting `i2cWrite`'s first 8 bytes with
`li a0,0 / ret` changed the sketch's observable behaviour from
`endTransmission=4` to `endTransmission=0`, and the resealed image booted normally.
(`spike/13-patch-i2c.mjs`)

**No trampoline is needed.** The original plan called for `auipc`/`jalr` jumps into
appended code plus segment extension. That turned out to be unnecessary: the shim
fits *inside the function it replaces* (`i2cWrite` is 174 B; the shim is 116 B).
Segment extension and `PT_LOAD` surgery are therefore dropped from the design.
Keep the size assertion — if a future shim outgrows its host function, revisit.

### Phase 3 — I2C bridge ✅ DONE (bidirectional, APC-framed)

`spike/shims.py` generates both blobs; `spike/16-i2c-apc.mjs` patches and runs them.

| Shim | Size / budget | Function |
| --- | --- | --- |
| `shim_i2cwrite.bin` | 116 / 174 B | emits payload, returns `ESP_OK` |
| `shim_i2cread.bin` | 128 / 160 B | emits request, blocks for reply, fills buffer |

**Wire protocol** — ANSI APC frames (`ESC _ … ESC \`), which terminals discard:

```
ESC _ 'W' <addr> <payload nibbles…> ESC \     write, fire-and-forget
ESC _ 'R' <addr> <len>              ESC \     read request; host replies with
                                              <len> raw bytes via uart_input()
```

Address and length go out as **raw bytes** (both ≤ 0x7F, so they survive the UTF-8
decode of `run_batch()`'s return). Payload bytes may be ≥ 0x80, so those stay
nibble-encoded as `'a'+nibble`. Sending address/length raw is what shrank the read
shim from 160 B (exactly at budget) to 128 B.

**Verified on unmodified Arduino sketches:**

```
Wire.beginTransmission(0x3C); Wire.write(0xAF); Wire.endTransmission();
  -> I2C WRITE 0x3c <- af          console: endTransmission=0

Wire.requestFrom(0x68, 3);   // host answers de ad be
  -> I2C READ  0x68 -> de ad be    console: got=3:DEADBE
```

The console stays clean — no APC bytes leak into user-visible output.

**§4's open risk is closed.** The concern was that IDF's console driver would drain
UART0's RX FIFO before the shim saw the reply. It does not: the read shim polls
`RXFIFO_CNT` and receives host bytes correctly under a full Arduino app. No
separate channel and no `uart_ll` bypass were needed.

**Remaining for Phase 3:** wire this into `worker.js` (host bus model + virtual
devices in the worker, per §3.2). All of the above currently runs in the node
harness.

### Phase 4 — SPI, then GPIO
SPI reuses the Phase 2/3 machinery. GPIO is a separate mechanism (section 6).

---

## 6. GPIO — SOLVED ✅ (bidirectional)

Offsets found by differential scanning (`spike/dump-mem.mjs`, two firmwares identical
apart from the value written), then confirmed live (`spike/02-gpio-live.mjs`).

**Byte offsets into `wasm.memory.buffer`, chip `esp32c3`, `esp-emu` 0.39.0:**

| Offset | Field | Width | Use |
| --- | --- | --- | --- |
| `0x827850` | `GPIO_OUT` | u64 | **read** — pin drive levels |
| `0x827858` | `GPIO_ENABLE` | u64 | **read** — direction (1 = output) |
| `0x827860` | external pin level | u64 | **write** — inject inputs |
| `0x827870` | derived pin state | u64 | read-only cache, do **not** poke |

Fields are **u64**, not u32 (C6/P4 have >32 pins).

**Offset stability — validated against real firmware.** `0x827850` was found with an
88-byte hand-assembled probe, then independently rediscovered by a full-memory scan
while a **real Arduino sketch** (299 KB app, 6.4 MB ELF) blinked GPIO2
(`spike/09-arduino-gpio.mjs`). Only 2 words in 3.6 M alternated `0x4`/`0x0`, and
`0x827850` was one of them. The offset does not depend on firmware size or content.

**Semantics (measured):** `IN = (OUT & ENABLE) | (external & ~ENABLE)`. A pin driven
as output reads back its own driven value; a pin left as input reads the external
level, which defaults to all-ones (`0xFF…`, i.e. pulled high).

**Injection verified** (`spike/06-poke-in.mjs`): writing `0x5A` to `0x827860` changed
the guest's `GPIO_IN` read from `0xFF` to `0x5A`. That is the button/sensor path.

`0x827870` is a *derived* cache — poking it has no effect on what the guest reads.

### ⚠ Poking memory can crash the emulator

A blind scan that wrote to every word in a 256-byte window panicked the emulator:

```
panicked at src/periph/usbjtag.rs:132: RefCell already borrowed
```

Writing into Rust internals (RefCell borrow flags, Rc refcounts, Vec pointers,
enum discriminants) corrupts state or aborts. **Only write to offsets confirmed by a
read-only differential scan**, never scan by poking. Reads are always safe.

### Offsets are build-specific

These are heap offsets for *this* `esp_emu_bg.wasm` and chip. They will move if the
wasm is rebuilt or another chip is selected. Ship a **startup auto-calibration**: run
the bundled `spike/gpio_A.bin` / `gpio_B.bin` probes once at boot, diff, and derive
the offsets — rather than hardcoding the table above.

`rmt.rs` is also emulated, so WS2812 / NeoPixel is reachable by the same route.

---

## 7. Symbols to hook — RESOLVED ✅ (measured against real ELFs)

Two earlier guesses in this section were **wrong**, both corrected below.

### Hook the Arduino HAL tier, not the IDF tier

Arduino ESP32 has its own bus layer (`esp32-hal-i2c.c`, `esp32-hal-spi.c`) that sits
*above* — or entirely beside — the IDF drivers:

| Bus | Arduino calls | IDF driver present? |
| --- | --- | --- |
| I2C | `i2cWrite`, `i2cRead`, `i2cWriteReadNonStop` | yes — Arduino's HAL wraps `i2c_master_*` |
| SPI | `spiTransferByte`, `spiTransferByteNL`, `spiTransaction`, `spiStartBus` | **no — not linked at all** |

**Correction 1:** Arduino `Wire` does **not** use the legacy I2C API. All 6 `i2c_master_*`
v5 symbols resolve; zero legacy symbols do.

**Correction 2:** Arduino `SPI` does **not** use the IDF `spi_master` driver. A sketch
calling `SPI.begin()/transfer()` links **none** of `spi_device_transmit`,
`spi_device_polling_transmit`, `spi_bus_add_device`, `spi_bus_initialize`. Hooking the
IDF tier for SPI would silently never fire. Arduino's SPI pokes registers via `spi_ll`.

### Address resolution is trivial at the Arduino tier

The earlier plan warned against chasing the 7-bit address inside an opaque handle.
That problem **disappears** here — the Arduino HAL passes the address as a plain
argument:

```c
esp_err_t i2cWrite(uint8_t num, uint16_t address, const uint8_t* buff,
                   size_t size, uint32_t timeOutMillis);
esp_err_t i2cRead (uint8_t num, uint16_t address, uint8_t* buff, size_t size,
                   uint32_t timeOutMillis, size_t* readCount);
uint8_t   spiTransferByte(spi_t* spi, uint8_t data);
```

So the shim reads `a0`=bus, `a1`=address, `a2`=buffer, `a3`=length. No handle map, no
version-dependent struct offsets. **Prefer the Arduino tier whenever it is present.**

### Tier selection

`elf.mjs:planHooks()` picks per bus, first match wins:

- I2C: `arduino-i2c` → `idf-i2c-v5` → `idf-i2c-legacy`
- SPI: `arduino-spi` → `idf-spi`

**Unused drivers are stripped by the linker**, so absent symbols mean "sketch does not
use this bus" — a normal outcome, not an error. Verified: `Blink` reports nothing to
patch for either bus; `I2CProbe` reports I2C only; `BusProbe` reports both.

---

## 8. Capability summary

| Peripheral | Status | Mechanism |
| --- | --- | --- |
| UART TX/RX | ✅ done | already wired; RX round trip proven (§4) |
| WiFi / Ethernet | ✅ done | already wired |
| GPIO out + direction | ✅ done | dynamic auto-calibration at boot (§6) |
| GPIO input injection | ✅ done | dynamic auto-calibration at boot (§6) |
| RMT (NeoPixel WS2812) | ✅ done | image patch (`espShow` / `neopixelWrite`) + APC bridge |
| I2C read + write | ✅ done | image patch + APC bridge over UART0 |
| SPI master | ✅ done | image patch + APC bridge, `arduino-spi` tier (Phase 4) |
| SSD1306 OLED (128x64) | ✅ done | virtual peripheral + live canvas in browser & worker |
| ST7789 Color TFT (240x240) | ✅ done | virtual SPI peripheral + live RGB565 canvas |
| SD Card (FAT16/FAT32 SPI) | ✅ done | virtual SPI block peripheral, CRC16 CCITT, disk image exporter (Phase 5) |
| ADC & PWM / LEDC | ✅ done | `analogRead`/`analogReadMilliVolts` + `analogWrite`/`ledcWrite` shims & UI slider |
| SPI flash | ✅ internal | `spimem.rs`, no work needed |

**Current state:** Phases 0–5 + RMT + ADC + PWM + Dynamic Calibration complete. All 9 real Arduino firmwares (Blink, I2CRead, OLEDDemo, SPIDemo, BusProbe, ST7789Demo, NeoPixelDemo, SDCardDemo, ADCPWMDemo) pass automated end-to-end testing in both Web Worker and headless harness.

**Next, in order:**
1. Interactive visual circuit wiring diagram (Wokwi-style UI canvas).
2. ESP-IDF direct hook tier (`idf-i2c-v5` / `idf-spi`).
3. Additional sensors (BME280 / Servo motor / Rotary Encoder).
