import { Elf32, planHooks, prepareSpiShims, prepareIdfShims } from './elf.mjs';
import { EspImage } from './espimage.mjs';
import { SHIMS, relocateShimsForChip } from './shims.mjs';
import { prepareBleShims } from './core/ble_shims.mjs';
import { prepareThreadShims } from './core/thread_shims.mjs';
import { ThreadController } from './core/thread_controller.mjs';
import { BleHciPump } from './core/ble_hci_pump.mjs';
import { BLEController } from './core/ble_controller.mjs';
import { BLEMirror } from './core/ble_mirror.mjs';
import { ReplyDribbler } from './reply_queue.mjs';
import { I2CBus, SPIBus, SSD1306Device, ST7789Device, NeoPixelStrip, MPU6050Device, VirtualSDCard, VirtualADC, VirtualPWM, VirtualI2S, VirtualTWAI, VirtualTouch, VirtualDAC, VirtualSDMMC, VirtualCamera, VirtualLcdPanel } from './peripherals.mjs';

let wasmExports = null;
let wasm = null;
let emulator = null;
let running = false;
let batchSize = 100000;
let pendingLoad = null;
let ws = null;
let bleWs = null;
let bleMode = 'local';
let currentChip = 'esp32c3';
const bleController = new BLEController();
const threadController = new ThreadController();
const bleMirror = new BLEMirror(() => {
    if (!wasmExports?.memory) throw new Error('no memory bound');
    return wasmExports.memory.buffer;
});
// Forward raw HCI traffic to the UI thread (Peripheral Monitor, BLE tag).
bleController.onHci((msg) => {
    postMessage({
        type: 'ble_hci',
        dir: msg.dir,
        opcode: msg.opcode,
        name: msg.name,
        data: Array.from(msg.bytes || []),
    });
});
// HCI pump: local stub by default; 'bumble' forwards H4 over bleWs to the
// gateway's /api/ble-gateway (real Bumble stack). Shared with headless tests.
// (Created after replyDribbler below; declared here for message-handler use.)
let blePump = null;

function postBleStatus() {
    postMessage({
        type: 'ble_status',
        mode: bleMode,
        connected: !!(bleWs && bleWs.readyState === WebSocket.OPEN),
    });
}
// Paced host->firmware replies: the guest HW RX FIFO drops bursts larger
// than ~128B, so SDMMC/camera replies dribble out across batches.
const replyDribbler = new ReplyDribbler();

function pumpReplies() {
    replyDribbler.pump((b) => {
        if (emulator) emulator.uart_input(b);
    });
}

blePump = new BleHciPump({
    controller: bleController,
    mirror: bleMirror,
    dribbler: replyDribbler,
    postHci: (msg) => {
        postMessage({
            type: 'ble_hci',
            dir: msg.dir,
            opcode: msg.opcode,
            name: msg.name,
            data: Array.from(msg.bytes || []),
        });
    },
});

// Virtual buses and devices
const i2cBus = new I2CBus();
const spiBus = new SPIBus();
const oledDevice = new SSD1306Device(128, 64);
const tftDevice = new ST7789Device(240, 240);
const neoPixel = new NeoPixelStrip(8);
const mpuDevice = new MPU6050Device();
const sdCardDevice = new VirtualSDCard();
const adcDevice = new VirtualADC();
const pwmDevice = new VirtualPWM();
const i2sDevice = new VirtualI2S(16000);
const twaiDevice = new VirtualTWAI();
const touchDevice = new VirtualTouch();
const dacDevice = new VirtualDAC();
const sdmmcDevice = new VirtualSDMMC();
const cameraDevice = new VirtualCamera();
const lcdDevice = new VirtualLcdPanel(240, 240);

i2cBus.register(0x3c, oledDevice);
i2cBus.register(0x3d, oledDevice);
i2cBus.register(0x68, mpuDevice);
spiBus.register('tft', tftDevice);
spiBus.register('sd', sdCardDevice);

i2sDevice.onAudio((data) => {
    postMessage({
        type: 'i2s_audio',
        ...data,
    });
});

twaiDevice.onActivity((act) => {
    postMessage({
        type: 'twai_activity',
        ...act,
    });
});

adcDevice.onActivity((act) => {
    postMessage({
        type: 'adc_activity',
        ...act,
    });
});

pwmDevice.onActivity((act) => {
    postMessage({
        type: 'pwm_activity',
        ...act,
    });
});

sdCardDevice.onActivity((act) => {
    postMessage({
        type: 'sd_activity',
        ...act,
    });
});

touchDevice.onActivity((act) => {
    postMessage({
        type: 'touch_activity',
        ...act,
    });
});

dacDevice.onActivity((act) => {
    postMessage({
        type: 'dac_activity',
        ...act,
    });
});

sdmmcDevice.onActivity((act) => {
    postMessage({
        type: 'sdmmc_activity',
        ...act,
    });
});

cameraDevice.onFrame((frame) => {
    postMessage({
        type: 'camera_frame',
        width: frame.width,
        height: frame.height,
        fmt: frame.fmt,
        buffer: frame.buffer,
    });
});

lcdDevice.onFrame((frame) => {
    postMessage({
        type: 'lcd_frame',
        width: frame.width,
        height: frame.height,
        buffer: frame.buffer,
    });
});

threadController.onActivity((act) => {
    postMessage({ type: 'thread_activity', ...act });
});

oledDevice.onFrame((frame) => {
    postMessage({
        type: 'oled_frame',
        width: frame.width,
        height: frame.height,
        buffer: frame.buffer,
        inverted: frame.inverted,
        displayOn: frame.displayOn,
    });
});

tftDevice.onFrame((frame) => {
    postMessage({
        type: 'tft_frame',
        width: frame.width,
        height: frame.height,
        buffer: frame.buffer,
        displayOn: frame.displayOn,
    });
});

neoPixel.onFrame((frame) => {
    postMessage({
        type: 'neopixel_frame',
        pin: frame.pin,
        pixels: frame.pixels,
    });
});

i2cBus.onActivity((act) => {
    postMessage({
        type: 'i2c_activity',
        op: act.type,
        addr: act.addr,
        data: Array.from(act.data || []),
        timestamp: act.timestamp,
    });
});

spiBus.onActivity((act) => {
    postMessage({
        type: 'spi_activity',
        op: act.type,
        data: Array.from(act.data || []),
        reply: Array.from(act.reply || []),
        timestamp: act.timestamp,
    });
});

// Dynamic GPIO calibration probe (80 bytes RV32 writing 0xCAFE1234 to OUT and 0xBEEF5678 to ENABLE)
const GPIO_CALIBRATION_PROBE = new Uint8Array([
    233, 1, 2, 32, 0, 0, 56, 64, 238, 0, 0, 0,
    5, 0, 0, 0, 0, 255, 255, 0, 0, 0, 0, 0,
    0, 0, 56, 64, 44, 0, 0, 0, 183, 66, 0, 96,
    147, 130, 2, 2, 55, 83, 239, 190, 19, 3, 131, 103,
    35, 160, 98, 0, 183, 66, 0, 96, 147, 130, 66, 0,
    55, 19, 254, 202, 19, 3, 67, 35, 35, 160, 98, 0,
    111, 0, 0, 0, 0, 0, 0, 99
]);

let gpioOutOffset = 0x827850;
let gpioEnableOffset = 0x827858;
let gpioInOffset = 0x827860;

let lastGpioOut = -1n;
let lastGpioEn = -1n;
let streamBuffer = '';

// Global error handlers
self.onerror = function(msg, src, line, col, err) {
    postMessage({ type: 'error', message: `Worker error: ${msg}` });
};
self.onunhandledrejection = function(e) {
    postMessage({ type: 'error', message: `Worker promise rejected: ${e.reason}` });
};

function calibrateGpio(chip) {
    try {
        const calEmu = new wasm.WasmEmulator(chip || 'esp32c3');
        calEmu.set_boot_from_rom(false);
        calEmu.load_firmware(GPIO_CALIBRATION_PROBE);
        calEmu.run_batch(200);

        const u32 = new Uint32Array(wasmExports.memory.buffer);
        for (let i = 0; i < u32.length; i++) {
            if (u32[i] === 0xCAFE1234) gpioOutOffset = i * 4;
            if (u32[i] === 0xBEEF5678) gpioEnableOffset = i * 4;
        }
        gpioInOffset = gpioEnableOffset + 8;
        postMessage({
            type: 'calibrated',
            out: gpioOutOffset,
            enable: gpioEnableOffset,
            in: gpioInOffset,
        });
    } catch (e) {
        console.warn('Dynamic GPIO calibration error, using defaults:', e);
    }
}

// Import and initialize WASM module
async function initWasm(wasmUrl) {
    try {
        const { default: init, WasmEmulator } = await import(wasmUrl);
        wasmExports = await init();
        wasm = { WasmEmulator, memory: wasmExports.memory };

        // Run dynamic GPIO calibration at boot
        calibrateGpio('esp32c3');

        postMessage({ type: 'ready' });

        if (pendingLoad) {
            const msg = pendingLoad;
            pendingLoad = null;
            await handleLoad(msg);
        }
    } catch (e) {
        postMessage({ type: 'error', message: `Failed to init WASM: ${e.message}` });
    }
}

async function handleLoad(msg) {
    const chip = msg.chip || 'esp32c3';
    currentChip = chip;
    try {
        let firmwareBytes = new Uint8Array(msg.firmware);

        // Auto-patch firmware with RISC-V shims if ELF is provided
        if (msg.elf) {
            try {
                const elf = new Elf32(new Uint8Array(msg.elf));
                const hookPlan = planHooks(elf);
                const allHooks = []
                    .concat(hookPlan?.i2c?.hooks || [])
                    .concat(hookPlan?.spi?.hooks || [])
                    .concat(hookPlan?.neopixel?.hooks || [])
                    .concat(hookPlan?.adc?.hooks || [])
                    .concat(hookPlan?.pwm?.hooks || [])
                    .concat(hookPlan?.i2s?.hooks || [])
                    .concat(hookPlan?.twai?.hooks || [])
                    .concat(hookPlan?.touch?.hooks || [])
                    .concat(hookPlan?.dac?.hooks || [])
                    .concat(hookPlan?.sdmmc?.hooks || [])
                    .concat(hookPlan?.camera?.hooks || [])
                    .concat(hookPlan?.lcd?.hooks || [])
                    .concat(hookPlan?.thread?.hooks || []);
                // Relocate UART0/SPI-bus bases per chip (C3 vs C6/H2 vs P4).
                const effectiveShims = prepareSpiShims(elf, relocateShimsForChip(SHIMS, chip));
                const hooks = Object.fromEntries(allHooks.map(h => [h.name, h]));
                const idfExtras = [];

                // BLE VHCI shims (required or BLEDemo hangs in ROM PHY spin).
                // Merged here so browser matches core/esp32c3.mjs behavior.
                let bleExtra = [];
                try {
                    const ble = prepareBleShims(elf, chip);
                    for (const [fn, shim] of Object.entries(ble.shims || {})) effectiveShims[fn] = shim;
                    for (const h of ble.hooks || []) hooks[h.name] = h;
                    bleExtra = ble.extra || [];
                } catch (bleErr) {
                    console.warn('BLE shim prep skipped:', bleErr);
                }

                // IDF raw-driver shims (SPI transaction trampolines + extras).
                try {
                    const idf = prepareIdfShims(elf, effectiveShims);
                    for (const [fn, shim] of Object.entries(idf.shims || {})) effectiveShims[fn] = shim;
                    idfExtras.push(...(idf.extra || []));
                } catch (idfErr) {
                    console.warn('IDF shim prep skipped:', idfErr);
                }

                // 802.15.4 / Thread radio shims (soft: missing/small skips).
                // The EnergyScan parked body travels via th.extra, merged
                // into idfExtras (written below like the BLE/IDF extras).
                try {
                    const th = prepareThreadShims(elf, chip);
                    for (const [fn, shim] of Object.entries(th.shims || {})) effectiveShims[fn] = shim;
                    for (const h of th.hooks || []) hooks[h.name] = h;
                    idfExtras.push(...(th.extra || []));
                } catch (thErr) {
                    console.warn('Thread shim prep skipped:', thErr);
                }

                // Warn for tiers that resolve but still lack shim bytecode
                // (e.g. legacy i2c command-link API).
                for (const [bus, plan] of Object.entries(hookPlan || {})) {
                    if (!plan || !plan.tier || !plan.tier.startsWith('idf-') ||
                        (bus !== 'i2c' && bus !== 'spi')) continue;
                    const uncovered = (plan.hooks || []).filter(h => !effectiveShims[h.name]);
                    if (uncovered.length) {
                        console.warn(`[patcher] ${bus} tier ${plan.tier} unpatched: ${uncovered.map(h => h.name).join(', ')}`);
                    }
                }

                const img = new EspImage(firmwareBytes);
                const patched = [];
                for (const [fn, shim] of Object.entries(effectiveShims)) {
                    if (hooks[fn] && shim.length <= hooks[fn].size) {
                        img.writeAtVaddr(hooks[fn].addr, shim);
                        patched.push({ name: fn, addr: hooks[fn].addr, size: shim.length });
                    } else if (hooks[fn] && shim.length > hooks[fn].size) {
                        console.warn(`[patcher] skip ${fn}: shim ${shim.length}B > func ${hooks[fn].size}B`);
                    }
                }
                for (const ex of bleExtra) {
                    try {
                        img.writeAtVaddr(ex.addr, ex.bytes);
                        patched.push({ name: 'ble:' + ex.addr.toString(16), addr: ex.addr, size: ex.bytes.length });
                    } catch (_) {}
                }
                for (const ex of idfExtras) {
                    try {
                        img.writeAtVaddr(ex.addr, ex.bytes);
                        patched.push({ name: 'idf:' + ex.addr.toString(16), addr: ex.addr, size: ex.bytes.length });
                    } catch (_) {}
                }
                if (patched.length > 0) {
                    await img.reseal();
                    postMessage({ type: 'patched', plan: hookPlan, patched: patched });
                }
            } catch (patchErr) {
                console.warn('ELF patching skipped:', patchErr);
            }
        }

        emulator = new wasm.WasmEmulator(chip);
        if (msg.ssid) {
            emulator.set_wifi_config(msg.ssid, msg.password || '');
        }
        if (msg.rom) {
            emulator.load_rom_elf(new Uint8Array(msg.rom));
        } else if (emulator.has_default_rom()) {
            emulator.load_default_rom();
        } else {
            throw new Error(`No ROM provided and no embedded default for chip ${chip}`);
        }
        if (msg.efuse) {
            emulator.load_efuse(new Uint8Array(msg.efuse));
        }

        emulator.set_boot_from_rom(!msg.skipRom);
        emulator.load_firmware(firmwareBytes);

        // Re-run GPIO auto-calibration for the actual target chip (C3 vs
        // C6/H2 vs P4 have different peripheral base addresses). The boot-time
        // c3 calibration above is only a default until the chip is known.
        try {
            if (chip !== 'esp32c3') calibrateGpio(chip);
        } catch (_) {}
        postMessage({ type: 'chip', chip });

        streamBuffer = '';
        replyDribbler.clear();
        bleMirror.clear();
        threadController.reset();
        lastGpioOut = -1n;
        lastGpioEn = -1n;

        postMessage({ type: 'loaded', pc: emulator.pc() });
    } catch (err) {
        postMessage({ type: 'error', message: `Load failed: ${err}` });
    }
}

// --- WebSocket networking ---
function connectNetwork(url) {
    if (ws) {
        ws.close();
        ws = null;
    }
    try {
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function() {
            postMessage({ type: 'net_status', connected: true });
        };

        ws.onclose = function() {
            postMessage({ type: 'net_status', connected: false });
            ws = null;
        };

        ws.onerror = function() {
            postMessage({ type: 'error', message: `WebSocket connection failed: ${url}` });
            ws = null;
        };

        ws.onmessage = function(e) {
            if (emulator && e.data instanceof ArrayBuffer && e.data.byteLength >= 14) {
                emulator.wifi_rx_push(new Uint8Array(e.data));
            }
        };
    } catch (e) {
        postMessage({ type: 'error', message: `WebSocket error: ${e.message}` });
    }
}

function disconnectNetwork() {
    if (ws) {
        ws.close();
        ws = null;
    }
}

// --- BLE gateway (real radio via Bumble) ---
function connectBle(url) {
    disconnectBle();
    try {
        bleWs = new WebSocket(url);
        bleWs.binaryType = 'arraybuffer';
        blePump.setTransport({
            send: (bytes) => {
                if (bleWs && bleWs.readyState === WebSocket.OPEN) {
                    const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
                    bleWs.send(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
                }
            },
            isOpen: () => !!(bleWs && bleWs.readyState === WebSocket.OPEN),
        });
        bleWs.onopen = function() {
            postBleStatus();
        };
        bleWs.onclose = function() {
            postBleStatus();
            bleWs = null;
            if (blePump) blePump.setTransport(null);
        };
        bleWs.onerror = function() {
            postMessage({ type: 'error', message: `BLE gateway connection failed: ${url}` });
        };
        bleWs.onmessage = function(e) {
            if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
                try {
                    blePump.handleWsMessage(new Uint8Array(e.data));
                } catch (err) {
                    console.warn('BLE gateway message error:', err);
                }
            } else if (typeof e.data === 'string' && e.data.startsWith('ERROR')) {
                postMessage({ type: 'error', message: `BLE gateway: ${e.data}` });
            }
        };
    } catch (e) {
        postMessage({ type: 'error', message: `BLE gateway error: ${e.message}` });
    }
    postBleStatus();
}

function disconnectBle() {
    if (bleWs) {
        try { bleWs.close(); } catch (_) {}
        bleWs = null;
    }
    if (blePump) blePump.setTransport(null);
}

function drainTxToNetwork() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !emulator) return;

    const buf = emulator.wifi_tx_drain();
    if (buf.length === 0) return;

    let offset = 0;
    while (offset + 4 <= buf.length) {
        const len = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
        offset += 4;
        if (offset + len > buf.length) break;
        const frame = new Uint8Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + len));
        ws.send(frame.buffer);
        offset += len;
    }
}

// --- APC Frame Parsing & Peripheral Dispatch ---
const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;

function processStream(chunk) {
    // Flush previously queued replies first (a polling shim is silent).
    pumpReplies();
    streamBuffer += chunk;
    let cleanOutput = '';

    while (true) {
        const m = streamBuffer.match(APC);
        if (m) {
            cleanOutput += streamBuffer.slice(0, m.index);
            const [frame, kind, body] = m;
            handleApcFrame(kind, body);
            streamBuffer = streamBuffer.slice(m.index + frame.length);
        } else {
            const partialIdx = streamBuffer.lastIndexOf('\x1b_');
            if (partialIdx !== -1) {
                cleanOutput += streamBuffer.slice(0, partialIdx);
                streamBuffer = streamBuffer.slice(partialIdx);
            } else {
                cleanOutput += streamBuffer;
                streamBuffer = '';
            }
            break;
        }
    }
    // Release newly queued reply bytes in the same batch.
    pumpReplies();
    return cleanOutput;
}

function handleApcFrame(kind, body) {
    if (!body || body.length === 0) return;

    if (kind === 'W') {
        // I2C Write
        const addr = body.charCodeAt(0);
        const hex = [...body.slice(1)].map(c => c.charCodeAt(0) - 97);
        const bytes = [];
        for (let j = 0; j + 1 < hex.length; j += 2) {
            bytes.push((hex[j] << 4) | hex[j + 1]);
        }
        i2cBus.write(addr, bytes);
    } else if (kind === 'R') {
        // I2C Read
        const addr = body.charCodeAt(0);
        const len = body.charCodeAt(1);
        const data = i2cBus.read(addr, len);
        if (emulator && data && data.length > 0) {
            emulator.uart_input(new Uint8Array(data));
        }
    } else if (kind === 'S') {
        // SPI Transfer
        if (body[0] === 'W') {
            const len = body.charCodeAt(1) & 0x7f;
            const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
            const bytes = [];
            for (let j = 0; j + 1 < hex.length; j += 2) {
                bytes.push((hex[j] << 4) | hex[j + 1]);
            }
            spiBus.write(bytes);
            if (len === 64 && emulator) {
                emulator.uart_input(new Uint8Array([0]));
            }
        } else if (body[0] === 'X') {
            const lenHi = body.charCodeAt(1) & 0x7f;
            const lenLo = body.charCodeAt(2) & 0x7f;
            const len = (lenHi << 7) | lenLo;
            const hex = [...body.slice(3)].map(c => c.charCodeAt(0) - 97);
            const bytes = [];
            for (let j = 0; j + 1 < hex.length; j += 2) {
                bytes.push((hex[j] << 4) | hex[j + 1]);
            }
            const replies = [];
            for (const b of bytes) {
                replies.push(spiBus.transferByte(b));
            }
            if (emulator && replies.length > 0) {
                emulator.uart_input(new Uint8Array(replies));
            }
        } else {
            const hi = body.charCodeAt(0) - 97;
            const lo = body.charCodeAt(1) - 97;
            const txByte = ((hi & 15) << 4) | (lo & 15);
            const reply = spiBus.transferByte(txByte);
            if (emulator) {
                emulator.uart_input(new Uint8Array([reply]));
            }
        }
    } else if (kind === 'N') {
        // NeoPixel Frame: N<pin><len><nibbles...>
        const pin = body.charCodeAt(0);
        const len = body.charCodeAt(1);
        const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
        const bytes = [];
        for (let j = 0; j + 1 < hex.length; j += 2) {
            bytes.push((hex[j] << 4) | hex[j + 1]);
        }
        neoPixel.update(pin, bytes);
    } else if (kind === 'A') {
        // ADC Raw Read: A<pin>
        const pin = body.charCodeAt(0) & 0x7F;
        const raw = adcDevice.readRaw(pin);
        if (emulator) {
            emulator.uart_input(new Uint8Array([(raw >> 8) & 0xFF, raw & 0xFF]));
        }
    } else if (kind === 'V') {
        // ADC Voltage Read (mV): V<pin>
        const pin = body.charCodeAt(0) & 0x7F;
        const mv = adcDevice.readMilliVolts(pin);
        if (emulator) {
            emulator.uart_input(new Uint8Array([(mv >> 8) & 0xFF, mv & 0xFF]));
        }
    } else if (kind === 'P') {
        // PWM / LEDC Write: P<pin><duty_hi><duty_lo>
        const pin = body.charCodeAt(0) & 0x7F;
        const dutyHi = body.charCodeAt(1) & 0x7F;
        const dutyLo = body.charCodeAt(2) & 0x7F;
        const duty = (dutyHi << 7) | dutyLo;
        pwmDevice.update(pin, duty);
    } else if (kind === 'I') {
        // I2S Audio: I<len_hi><len_lo><raw_bytes...>
        const lenHi = body.charCodeAt(0) & 0x7f;
        const lenLo = body.charCodeAt(1) & 0x7f;
        const len = (lenHi << 7) | lenLo;
        const rawBytes = [];
        for (let i = 0; i < len && 2 + i < body.length; i++) {
            rawBytes.push(body.charCodeAt(2 + i) & 0xff);
        }
        i2sDevice.writePcm(rawBytes);
    } else if (kind === 'C') {
        if (body === 'R') {
            // TWAI CAN Frame Read Request
            const resp = twaiDevice.popRxFrame() || new Uint8Array([0]);
            if (emulator) emulator.uart_input(resp);
        } else {
            // TWAI CAN Frame Transmit: C<flags><dlc><id3><id2><id1><id0><data...>
            const flags = body.charCodeAt(0) & 0x7f;
            const dlc = body.charCodeAt(1) & 0x0f;
            const id = ((body.charCodeAt(2) & 0x7f) << 21) |
                       ((body.charCodeAt(3) & 0x7f) << 14) |
                       ((body.charCodeAt(4) & 0x7f) << 7) |
                       (body.charCodeAt(5) & 0x7f);
            const data = [];
            for (let i = 0; i < dlc && 6 + i < body.length; i++) {
                data.push(body.charCodeAt(6 + i) & 0xff);
            }
            twaiDevice.transmit({
                id,
                extd: (flags & 1) !== 0,
                rtr: (flags & 2) !== 0,
                dlc,
                data,
            });
        }
    } else if (kind === 'T') {
        // Touch pad read: T<pin>
        const pin = body.charCodeAt(0) & 0x7F;
        const raw = touchDevice.read(pin);
        if (emulator) {
            emulator.uart_input(new Uint8Array([(raw >> 8) & 0xFF, raw & 0xFF]));
        }
    } else if (kind === 'D') {
        // DAC write: D<pin><vhi><vlo> (nibble-encoded, UART string is UTF-8)
        const pin = body.charCodeAt(0) & 0x7F;
        const value = (((body.charCodeAt(1) - 97) & 0xF) << 4) | ((body.charCodeAt(2) - 97) & 0xF);
        dacDevice.write(pin, value);
    } else if (kind === 'M') {
        // SDMMC sector transfer: M<R|W><lba:8nib><count:4nib>[nibbles...]
        const op = body[0];
        const nib = (c) => (body.charCodeAt(c) - 97) & 0xF;
        let lba = 0;
        for (let i = 1; i <= 8; i++) lba = (lba << 4) | nib(i);
        let count = 0;
        for (let i = 9; i <= 12; i++) count = (count << 4) | nib(i);
        count = Math.max(0, Math.min(64, count));
        if (op === 'R') {
            replyDribbler.push(sdmmcDevice.readSectors(lba >>> 0, count));
        } else if (op === 'W') {
            // Chunked writes (see shim_sdmmc_write): reassembled by the device.
            const bytes = [];
            for (let i = 13; i + 1 < body.length; i += 2) {
                bytes.push((nib(i) << 4) | nib(i + 1));
            }
            sdmmcDevice.writeChunk(lba >>> 0, count, new Uint8Array(bytes));
        }
            sdmmcDevice.writeSectors(lba >>> 0, new Uint8Array(bytes));
        }
    } else if (kind === 'F') {
        // Camera band: F<off:8nib><len:4nib> -> len + bytes
        const nib = (c) => (body.charCodeAt(c) - 97) & 0xF;
        let off = 0;
        for (let i = 0; i < 8; i++) off = (off << 4) | nib(i);
        let count = 0;
        for (let i = 8; i < 12; i++) count = (count << 4) | nib(i);
        count = Math.max(0, Math.min(1024, count));
        const frame = cameraDevice.readBand(off >>> 0, count);
        {
            const out = new Uint8Array(4 + frame.length);
            out[0] = (frame.length >>> 24) & 0xFF;
            out[1] = (frame.length >>> 16) & 0xFF;
            out[2] = (frame.length >>> 8) & 0xFF;
            out[3] = frame.length & 0xFF;
            out.set(frame, 4);
            replyDribbler.push(out);
        }
    } else if (kind === 'L') {
        // LCD panel blit: L<x1:4><y1:4><x2:4><y2:4><len:8><nibbles...>
        const nib = (c) => (body.charCodeAt(c) - 97) & 0xF;
        const rd16 = (o) => (nib(o) << 12) | (nib(o + 1) << 8) | (nib(o + 2) << 4) | nib(o + 3);
        const x1 = rd16(0), y1 = rd16(4), x2 = rd16(8), y2 = rd16(12);
        let len = 0;
        for (let i = 16; i < 24; i++) len = (len << 4) | nib(i);
        len = Math.max(0, Math.min(240 * 240 * 2, len));
        const bytes = new Uint8Array(len);
        for (let i = 0, o = 24; i < len && o + 1 < body.length; i++, o += 2) {
            bytes[i] = (nib(o) << 4) | nib(o + 1);
        }
        lcdDevice.drawBitmap(x1, y1, x2, y2, bytes);
    } else if (kind === 'B') {        // BLE HCI command -> controller or Bumble.
        // Mirrors core/uart.mjs so browser BLE matches Node SDK behavior.
        // Local stub answers via the shared-memory mirror (E-UART dribbled
        // fallback); 'bumble' mode forwards H4 to /api/ble-gateway instead.
        if (!emulator || !blePump) return;
        try {
            const hex = [...body].map(c => c.charCodeAt(0) - 97);
            const bytes = [];
            for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
            blePump.handleBFrame(new Uint8Array(bytes));
        } catch (e) {
            console.warn('BLE HCI bridge error:', e);
        }
    } else if (kind === 'G') { // 802.15.4 TX tap: G<ch><len><psdu nibbles>
        threadController.handle(body);
    } else if (kind === 'H') { // 802.15.4 energy-scan tap: H<ch>
        threadController.handleScan(body);
    }
}

function pollGpio() {
    if (!wasmExports?.memory) return;
    try {
        const view = new DataView(wasmExports.memory.buffer);
        const outVal = view.getBigUint64(gpioOutOffset, true);
        const enVal = view.getBigUint64(gpioEnableOffset, true);

        if (outVal !== lastGpioOut || enVal !== lastGpioEn) {
            lastGpioOut = outVal;
            lastGpioEn = enVal;
            // Mask widens per chip (P4 has 56 GPIOs > 53-bit Number precision),
            // so send BigInt strings alongside numeric fallbacks for compat.
            const mask = (1n << 56n) - 1n;
            const outM = outVal & mask;
            const enM = enVal & mask;
            postMessage({
                type: 'gpio_update',
                out: Number(outM & 0xffffffffn),
                enable: Number(enM & 0xffffffffn),
                outStr: outM.toString(),
                enableStr: enM.toString(),
                chip: currentChip,
            });
        }
    } catch (e) {}
}

// Handle messages from main thread
onmessage = async function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'init':
            await initWasm(msg.wasmUrl);
            break;

        case 'load':
            if (!wasm) {
                pendingLoad = msg;
                postMessage({ type: 'error', message: 'WASM still loading, please wait...' });
            } else {
                await handleLoad(msg);
            }
            break;

        case 'start':
            running = true;
            runLoop();
            break;

        case 'stop':
            running = false;
            break;

        case 'step': {
            if (!emulator) break;
            let output = emulator.run_batch(1);
            if (emulator.needs_restart()) {
                if (output) {
                    const clean = processStream(output);
                    if (clean) postMessage({ type: 'uart_output', data: clean });
                }
                output = '';
                try {
                    emulator.restart();
                    postMessage({ type: 'restarted' });
                } catch (err) {
                    postMessage({ type: 'error', message: `Restart failed: ${err}` });
                }
            } else if (output) {
                const clean = processStream(output);
                output = clean;
            } else {
                pumpReplies(); // keep dribbled replies flowing on silent batches
            }
            pollGpio();
            postMessage({
                type: 'step',
                output: output,
                pc: emulator.pc(),
                cycles: emulator.cycles(),
            });
            sendRegisters();
            break;
        }

        case 'reset': {
            running = false;
            if (emulator) {
                try {
                    emulator.restart();
                    streamBuffer = '';
                    replyDribbler.clear();
                    bleMirror.clear();
                    threadController.reset();
                    lastGpioOut = -1n;
                    lastGpioEn = -1n;
                    postMessage({ type: 'reset', reloaded: true, pc: emulator.pc() });
                } catch (err) {
                    postMessage({ type: 'error', message: `Reset failed: ${err}` });
                    postMessage({ type: 'reset', reloaded: false });
                }
            } else {
                postMessage({ type: 'reset', reloaded: false });
            }
            break;
        }

        case 'uart_input':
            if (emulator) {
                emulator.uart_input(new Uint8Array(msg.data));
            }
            break;

        case 'gpio_set': {
            if (wasmExports?.memory && typeof msg.pin === 'number') {
                try {
                    const view = new DataView(wasmExports.memory.buffer);
                    let curr = view.getBigUint64(gpioInOffset, true);
                    const mask = 1n << BigInt(msg.pin);
                    if (msg.level) {
                        curr |= mask;
                    } else {
                        curr &= ~mask;
                    }
                    view.setBigUint64(gpioInOffset, curr, true);
                } catch (err) {
                    console.error('GPIO set failed:', err);
                }
            }
            break;
        }

        case 'mem_read': {
            if (wasmExports?.memory && typeof msg.addr === 'number') {
                try {
                    const len = Math.min(msg.length || 64, 256);
                    const u8 = new Uint8Array(wasmExports.memory.buffer, msg.addr, len);
                    postMessage({
                        type: 'mem_data',
                        addr: msg.addr,
                        bytes: Array.from(u8),
                    });
                } catch (err) {
                    postMessage({ type: 'mem_data', addr: msg.addr, error: String(err) });
                }
            }
            break;
        }

        case 'net_connect':
            connectNetwork(msg.url);
            break;

        case 'net_disconnect':
            disconnectNetwork();
            break;

        case 'ble_connect':
            connectBle(msg.url);
            break;

        case 'ble_disconnect':
            disconnectBle();
            postBleStatus();
            break;

        case 'ble_set_mode':
            bleMode = msg.mode === 'bumble' ? 'bumble' : 'local';
            if (blePump) blePump.setMode(bleMode);
            postBleStatus();
            break;

        case 'sd_upload_img':
            if (msg.buffer) {
                sdCardDevice.loadDisk(new Uint8Array(msg.buffer));
                postMessage({ type: 'sd_status', loaded: true, size: msg.buffer.byteLength });
            }
            break;

        case 'sd_download_img':
            postMessage({ type: 'sd_disk_data', buffer: sdCardDevice.getDisk() });
            break;

        case 'adc_set_pin':
            adcDevice.setVoltage(msg.pin, msg.voltage);
            break;

        case 'adc_set_raw':
            adcDevice.setVoltage(msg.pin, (msg.raw / 4095) * 3.3);
            break;

        case 'touch_set':
            touchDevice.setTouched(msg.pin, !!msg.touched);
            break;

        case 'twai_inject':
            if (msg.frame) {
                const raw = twaiDevice.inject(msg.frame);
                if (emulator) emulator.uart_input(raw);
            }
            break;

        case 'set_batch_size':
            batchSize = msg.size;
            break;
    }
};

function runLoop() {
    if (!running || !emulator) return;

    const startTime = performance.now();
    let totalCycles = 0;
    let accumulatedOutput = '';

    while (running) {
        const rawOutput = emulator.run_batch(batchSize);
        if (rawOutput) {
            accumulatedOutput += processStream(rawOutput);
        } else {
            pumpReplies(); // keep dribbled replies flowing on silent batches
        }
        totalCycles += batchSize;

        if (emulator.needs_restart()) {
            if (accumulatedOutput.length > 0) {
                postMessage({ type: 'uart_output', data: accumulatedOutput });
                accumulatedOutput = '';
            }
            try {
                emulator.restart();
                postMessage({ type: 'uart_output', data: '\r\n' });
                postMessage({ type: 'restarted' });
            } catch (err) {
                postMessage({ type: 'error', message: `Restart failed: ${err}` });
                running = false;
            }
            break;
        }

        drainTxToNetwork();

        if (performance.now() - startTime > 12) break;
    }

    if (accumulatedOutput.length > 0) {
        postMessage({ type: 'uart_output', data: accumulatedOutput });
    }

    pollGpio();

    postMessage({
        type: 'status',
        pc: emulator.pc(),
        cycles: emulator.cycles(),
        mips: (totalCycles / (performance.now() - startTime) / 1000).toFixed(1),
    });

    if (running) {
        setTimeout(runLoop, 0);
    }
}

function sendRegisters() {
    if (!emulator) return;
    const regs = [];
    for (let i = 0; i < 32; i++) {
        regs.push(emulator.get_reg(i));
    }
    postMessage({
        type: 'registers',
        regs: regs,
        pc: emulator.pc(),
    });
}
