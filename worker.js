// Web Worker running the emulation loop, binary patcher, and virtual peripherals
// Communicates with main thread via postMessage

import { Elf32, planHooks } from './elf.mjs';
import { EspImage } from './espimage.mjs';
import { SHIMS } from './shims.mjs';
import { I2CBus, SSD1306Device, MPU6050Device } from './peripherals.mjs';

let wasmExports = null;
let wasm = null;
let emulator = null;
let running = false;
let batchSize = 50000;
let pendingLoad = null;
let ws = null;

// Virtual I2C bus and peripheral devices
const i2cBus = new I2CBus();
const oledDevice = new SSD1306Device(128, 64);
const mpuDevice = new MPU6050Device();

i2cBus.register(0x3c, oledDevice);
i2cBus.register(0x3d, oledDevice);
i2cBus.register(0x68, mpuDevice);

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

i2cBus.onActivity((act) => {
    postMessage({
        type: 'i2c_activity',
        op: act.type,
        addr: act.addr,
        data: Array.from(act.data || []),
        timestamp: act.timestamp,
    });
});

// Memory offsets for GPIO registers on esp32c3 (verified in AGENT.md)
const GPIO_OUT_OFFSET = 0x827850;
const GPIO_ENABLE_OFFSET = 0x827858;
const GPIO_IN_OFFSET = 0x827860;

let lastGpioOut = -1n;
let lastGpioEn = -1n;
let streamBuffer = '';

// Global error handler — catches WASM panics and unhandled exceptions
self.onerror = function(msg, src, line, col, err) {
    postMessage({ type: 'error', message: `Worker error: ${msg}` });
};
self.onunhandledrejection = function(e) {
    postMessage({ type: 'error', message: `Worker promise rejected: ${e.reason}` });
};

// Import and initialize WASM module
async function initWasm(wasmUrl) {
    try {
        const { default: init, WasmEmulator } = await import(wasmUrl);
        wasmExports = await init();
        wasm = { WasmEmulator, memory: wasmExports.memory };
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
    try {
        let firmwareBytes = new Uint8Array(msg.firmware);

        // Auto-patch firmware with RISC-V shims if ELF is provided
        if (msg.elf) {
            try {
                const elf = new Elf32(new Uint8Array(msg.elf));
                const hookPlan = planHooks(elf);
                const hooks = Object.fromEntries(
                    (hookPlan?.i2c?.hooks || []).concat(hookPlan?.spi?.hooks || []).map(h => [h.name, h])
                );
                const img = new EspImage(firmwareBytes);
                const patched = [];
                for (const [fn, shim] of Object.entries(SHIMS)) {
                    if (hooks[fn] && shim.length <= hooks[fn].size) {
                        img.writeAtVaddr(hooks[fn].addr, shim);
                        patched.push({ name: fn, addr: hooks[fn].addr, size: shim.length });
                    }
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

        // Set boot from ROM (default true for merged flash images)
        emulator.set_boot_from_rom(!msg.skipRom);
        emulator.load_firmware(firmwareBytes);

        streamBuffer = '';
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
            // Retain incomplete APC prefix if one is starting at the end of the buffer
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
    return cleanOutput;
}

function handleApcFrame(kind, body) {
    if (!body || body.length === 0) return;
    const addr = body.charCodeAt(0);

    if (kind === 'W') {
        const hex = [...body.slice(1)].map(c => c.charCodeAt(0) - 97);
        const bytes = [];
        for (let j = 0; j + 1 < hex.length; j += 2) {
            bytes.push((hex[j] << 4) | hex[j + 1]);
        }
        i2cBus.write(addr, bytes);
    } else if (kind === 'R') {
        const len = body.charCodeAt(1);
        const data = i2cBus.read(addr, len);
        if (emulator && data && data.length > 0) {
            emulator.uart_input(new Uint8Array(data));
        }
    }
}

function pollGpio() {
    if (!wasmExports?.memory) return;
    try {
        const view = new DataView(wasmExports.memory.buffer);
        const outVal = view.getBigUint64(GPIO_OUT_OFFSET, true);
        const enVal = view.getBigUint64(GPIO_ENABLE_OFFSET, true);

        if (outVal !== lastGpioOut || enVal !== lastGpioEn) {
            lastGpioOut = outVal;
            lastGpioEn = enVal;
            postMessage({
                type: 'gpio_update',
                out: Number(outVal & 0x3fffff_ffffffffn),
                enable: Number(enVal & 0x3fffff_ffffffffn),
            });
        }
    } catch (e) {
        // Memory buffer may resize
    }
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
                    let curr = view.getBigUint64(GPIO_IN_OFFSET, true);
                    const mask = 1n << BigInt(msg.pin);
                    if (msg.level) {
                        curr |= mask;
                    } else {
                        curr &= ~mask;
                    }
                    view.setBigUint64(GPIO_IN_OFFSET, curr, true);
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
        }
        totalCycles += batchSize;

        // Handle software restart (esp_restart / OTA reboot)
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

        // Drain TX frames every batch to minimize network latency
        drainTxToNetwork();

        // Check elapsed time to yield ~16ms
        if (performance.now() - startTime > 12) break;
    }

    // Flush any clean console output
    if (accumulatedOutput.length > 0) {
        postMessage({ type: 'uart_output', data: accumulatedOutput });
    }

    // Sync GPIO levels
    pollGpio();

    // Send status update
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
