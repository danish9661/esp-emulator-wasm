# ESP-RV32 WebAssembly Emulator (`esp-emu`)

[![RISC-V](https://img.shields.io/badge/Architecture-RISC--V%20(RV32)-red.svg)](https://riscv.org/)
[![WebAssembly](https://img.shields.io/badge/Runtime-WebAssembly%20(WASM)-654FF0.svg)](https://webassembly.org/)
[![Targets](https://img.shields.io/badge/Targets-ESP32--C3%20%7C%20C6%20%7C%20H2%20%7C%20P4-orange.svg)](https://www.espressif.com/)
[![Tests](https://img.shields.io/badge/Tests-11%2F11%20Passing-brightgreen.svg)]()
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A blazing-fast, **in-browser WebAssembly emulator** for Espressif **RISC-V 32-bit (RV32)** microcontrollers (**ESP32-C3, ESP32-C6, ESP32-H2, ESP32-P4**). 

Features a **Wokwi-style virtual peripheral bridge** that enables unmodified Arduino and ESP-IDF firmwares to interact with realistic displays, sensors, audio, automotive CAN bus, and storage peripherals directly in the browser with **zero guest modifications or re-compilation**.

---

## 🌟 Live Demo & Architecture Highlights

- **Zero Guest Overhead**: Runs unmodified compiled ELF & `.bin` firmware compiled with standard `arduino-cli` or ESP-IDF.
- **Dynamic Load-Time Binary Patching**: Automatically detects HAL/driver entry points in the application's ELF symbol table and applies tiny, high-performance RV32 assembly trampolines and shims.
- **APC Escape Frame Bridge**: High-bandwidth peripheral I/O (I2C, SPI, NeoPixel, ADC, PWM, I2S Audio, TWAI/CAN) is encoded into ANSI Application Program Command (`\x1b_...`) frames over UART0 with synchronous host delivery.
- **Dynamic Memory Auto-Calibration**: Probes and discovers hardware register offsets inside WASM linear memory at boot time across different target chips and FreeRTOS heap layouts.

---

## 🚀 Supported Hardware Protocols & Peripherals

| Peripheral / Protocol | Status | Emulated Hardware / Library Support | Mechanism |
|---|:---:|---|---|
| **UART0 Console** | ✅ | Serial TX / RX (bidirectional 115200 baud terminal) | Native WASM FIFO + XTerm.js |
| **GPIO Matrix (22 Pins)** | ✅ | Digital Out + Direction + Interactive Input Injection | Dynamic memory register auto-calibration |
| **I2C Master** | ✅ | `Wire.h` (SSD1306 OLED 128x64, MPU6050 6-DOF IMU) | HAL shims + APC bridge (`\x1b_W`, `\x1b_R`) |
| **SPI Master** | ✅ | `SPI.h` (ST7789 Color TFT 240x240 RGB565, Full Duplex) | Chunked RV32 shims (`\x1b_SX`) |
| **SD Card (SPI)** | ✅ | `SD.h` (FAT16/FAT32 Filesystem, Disk Image Exporter) | CCITT CRC16 + virtual sector streamer |
| **RMT (Remote Control)** | ✅ | WS2812 NeoPixel (8x RGB LED Strip Animation) | `espShow` / `neopixelWrite` interceptor |
| **ADC (Analog Input)** | ✅ | `analogRead()`, `analogReadMilliVolts()`, 12-bit SAR | Virtual ADC model + interactive UI slider |
| **PWM / LEDC Output** | ✅ | `analogWrite()`, `ledcWrite()`, Live Duty Visualizer | Virtual PWM tracker + glowing progress meter |
| **I2S Digital Audio** | ✅ | `i2s_write()`, Web Audio API (`AudioContext`), VU Meter | 16-bit stereo PCM streaming (`\x1b_I`) |
| **TWAI / CAN Bus** | ✅ | `twai_transmit()`, `twai_receive()`, ISO 11898-1 (500 kbps) | Live CAN traffic inspector & packet injector |
| **Networking (WiFi/ETH)** | ✅ | TCP/IP TAP WebSocket Bridge (`ws://localhost:8765`) | WASM Ethernet MAC + Host TAP bridge |
| **Bluetooth (BLE)** | 🟡 | Symbol interception hook table | Built-in WASM `load_app_elf` BLE layer |

---

## 🎯 Supported Espressif RISC-V Chips

All 4 target architectures are binary-compatible with the emulator's universal RV32 base integer instruction shims:

| Target Chip | CPU Architecture | Max Frequency | Wireless & Features | Emulator Status |
|---|---|---|---|:---:|
| **ESP32-C3** | Single-core 32-bit RISC-V (`RV32IMC`) | 160 MHz | Wi-Fi 4, Bluetooth 5 (LE) | ✅ **Full Peripheral Support** |
| **ESP32-C6** | Single-core 32-bit RISC-V (`RV32IMAC`) | 160 MHz | Wi-Fi 6, BLE 5, 802.15.4 (Thread/Zigbee) | ✅ **ROM & Flash Boot Verified** |
| **ESP32-H2** | Single-core 32-bit RISC-V (`RV32IMAC`) | 96 MHz | BLE 5, 802.15.4 (Thread/Zigbee) | ✅ **ROM & Flash Boot Verified** |
| **ESP32-P4** | Dual-core 32-bit RISC-V (`RV32IMAFC`) | 400 MHz | High-Performance with Single/Double FPU | ✅ **Core Initialized & Ready** |

---

## 📦 Bundled Firmware Presets

The emulator ships with pre-compiled, production-ready Arduino and ESP-IDF binaries:

1. **WS2812 NeoPixel Strip (8x RGB Rainbow)**: RMT-driven 8-LED animated rainbow cycle.
2. **ADC & PWM Demo**: Real-time potentiometer slider reading `analogRead()` / `analogReadMilliVolts()` controlling `analogWrite()` PWM duty cycle.
3. **I2S Digital Audio Output**: Synthesizes a 440 Hz sine wave tone at 16kHz 16-bit stereo with live browser audio playback and VU-meter.
4. **TWAI / CAN Bus Controller**: 500 kbps automotive CAN bus communication with live packet monitor and interactive packet injection.
5. **Virtual SD Card FAT16 (SPI CS=7)**: Mounts `/sd` filesystem, reads files, and exports binary `.img` disks.
6. **Adafruit ST7789 Color TFT (240x240 RGB565)**: High-speed SPI graphics rendering circles, rectangles, text, and triangles.
7. **Adafruit SSD1306 OLED (128x64 I2C)**: I2C graphics demo with splash screen, line art, and shapes.
8. **Blink LED (GPIO2)**: Demonstrates digital GPIO output and toggling.
9. **I2C Sensor Read (0x68 MPU6050)**: Multi-byte sensor register probing and reading.
10. **SPI Master Transfer**: Full-duplex bidirectional SPI data verification.
11. **Dual Bus Probe**: Concurrent I2C and SPI transaction probe.

---

## 🛠️ Getting Started

### 1. Prerequisites
- Python 3 (for the local no-cache HTTP server) or Node.js.
- Modern Web Browser with WebAssembly and Web Audio support (Chrome, Firefox, Edge, Safari).

### 2. Run the Local Development Server
Clone the repository and launch the server:
```bash
git clone https://github.com/danish9661/esp-rv32-emulator.git
cd esp-rv32-emulator

# Start the dev server on port 8080
python3 serve.py 8080
```
Open **`http://localhost:8080`** in your browser.

---

## 💻 Modular SDK Usage (`rp2040js` Style)

You can use the MCU Core Engine directly in Node.js, Web Workers, or custom browser simulators:

```javascript
import { readFileSync } from 'node:fs';
import { ESP32C3 } from 'esp-rv32-emulator';

// 1. Initialize the MCU instance
const mcu = await ESP32C3.create({ chip: 'esp32c3' });

// 2. Load firmware (auto-detects ELF symbols and applies shims)
const flash = new Uint8Array(readFileSync('firmware.bin'));
const elf = new Uint8Array(readFileSync('firmware.elf'));
await mcu.loadFirmware(flash, elf);

// 3. Listen to GPIO pin changes (e.g. LED on GPIO2)
mcu.gpio.pin(2).addListener((level, isOutput) => {
    console.log(`GPIO 2 is now ${level ? 'HIGH' : 'LOW'}`);
});

// 4. Inject button clicks / digital inputs
mcu.gpio.pin(0).setInput(true); // Pull GPIO0 HIGH

// 5. Connect I2C & SPI peripheral callbacks
mcu.i2c.onWrite((addr, bytes) => {
    console.log(`I2C write to 0x${addr.toString(16)}:`, bytes);
});

mcu.spi.onTransfer((txByte) => {
    return 0x55; // SPI MISO reply byte
});

// 6. Set simulated analog sensor voltage (0.0 to 3.3V)
mcu.adc.setVoltage(0, 1.65); // 50% pot reading -> 2048 raw

// 7. Listen for PWM duty cycles & CAN bus frames
mcu.pwm.onUpdate(({ pin, duty, percent }) => {
    console.log(`PWM on pin ${pin}: ${percent}%`);
});

mcu.twai.onActivity((frame) => {
    console.log('CAN Frame:', frame.type, 'ID:', frame.id, frame.data);
});

// 8. Step CPU instructions in your loop / worker
while (mcu.running) {
    const consoleOutput = mcu.step(50000);
    if (consoleOutput) process.stdout.write(consoleOutput);
}
```

---

## 🧪 Automated Verification Suite

The repository includes a comprehensive, automated regression test suite that boots real compiled firmware images inside headless Node.js instances:

```bash
# Run all 11 automated firmware test suites
node spike/18-verify-all.mjs
```

### Test Suite Output:
```text
========================================
TEST: Blink (GPIO2 Output)
========================================
✓ Auto-patched shims: rmtInit, _rmtWrite, rmtWrite, _rmtDetachBus
GPIO2 Output Enabled: true, Toggling Observed: PASS

========================================
TEST: I2C Sensor Read (0x68 IMU)
========================================
✓ Auto-patched shims: i2cWrite, i2cRead
Received mock sensor bytes 'got=3:DEADBE': PASS

========================================
TEST: Adafruit SSD1306 OLED Demo (128x64)
========================================
OLED frames rendered: 2909 -> PASS

========================================
TEST: SPIDemo (Full Duplex Transfer)
========================================
SPI Transfer Result Verified: PASS

========================================
TEST: BusProbe (Dual Bus I2C + SPI)
========================================
Dual Bus Execution Completed ('bus-done'): PASS

========================================
TEST: Adafruit ST7789 Color TFT (240x240 RGB565)
========================================
ST7789 Color TFT frames rendered: 2844 -> PASS

========================================
TEST: Adafruit NeoPixel 8-LED Strip (WS2812 RMT)
========================================
NeoPixel color frames captured: 1336 -> PASS

========================================
TEST: SDCardDemo (SPI Virtual SD Card FAT16)
========================================
SD Card Initialized & /README.TXT Read: PASS

========================================
TEST: ADCPWMDemo (ADC analogRead & PWM analogWrite)
========================================
ADC Read (2048/1650mV) & PWM Updates (315): PASS

========================================
TEST: I2SDemo (I2S Digital Audio 16kHz PCM)
========================================
I2S Audio Output (chunks=56): PASS

========================================
TEST: TWAIDemo (TWAI / CAN Bus Controller 500kbps)
========================================
TWAI CAN Bus TX (frames=190) & RX (ID=0x777): PASS

================================================================================
ALL 11 REAL ARDUINO FIRMWARE TESTS PASSED (I2C + SPI + TFT + OLED + NEOPIXEL + SDCARD + ADC + PWM + I2S + TWAI + GPIO)! ✅
================================================================================
```

---

## 🏗️ Repository Architecture

```text
esp-rv32-emulator/
├── index.html              # Main Web UI layout, virtual components, and displays
├── app.js                  # Frontend orchestration, Web Audio player, CAN inspector
├── worker.js               # Dedicated Web Worker hosting the WASM emulator instance
├── elf.mjs                 # ELF32 symbol parser, hook planner, and trampoline generator
├── espimage.mjs            # ESP32 flash image resealer and virtual address mapper
├── peripherals.mjs         # Models for I2C, SPI, OLED, ST7789, NeoPixel, SD, ADC, PWM, I2S, TWAI
├── shims.mjs               # Auto-generated RV32 machine bytecode shims
├── serve.py                # Local development server with no-cache headers
├── pkg/
│   ├── esp_emu.js          # WASM JavaScript wrapper bindings
│   └── esp_emu_bg.wasm     # High-performance Rust-compiled RV32 emulator core
├── samples/                # Pre-compiled .bin and .elf firmware sample binaries
└── spike/
    ├── gen_spi_shims.py    # RV32 instruction assembler & shim generator
    ├── 18-verify-all.mjs   # Automated multi-peripheral verification test suite
    └── sketches/           # Source Arduino sketches (.ino) for all demos
```

## 📄 Acknowledgements & License

- **WASM Core Engine**: Based on Espressif's official open-source [`esp-emulator`](https://github.com/espressif/esp-emulator) (Apache-2.0 / MIT).
- **Peripheral Bridge & Web Frontend**: Licensed under the **MIT License**. Created with paired programming in Antigravity.
