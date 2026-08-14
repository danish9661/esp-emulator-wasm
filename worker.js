// Web Worker running the emulation loop
// Communicates with main thread via postMessage

let wasm = null;
let emulator = null;
let running = false;
let batchSize = 50000;
let pendingLoad = null;
let ws = null;

// Global error handler — catches WASM panics and unhandled exceptions
self.onerror = function(msg, src, line, col, err) {
    postMessage({ type: 'error', message: `Worker error: ${msg}` });
};
self.onunhandledrejection = function(e) {
    postMessage({ type: 'error', message: `Worker promise rejected: ${e.reason}` });
};

// Import wasm module
async function initWasm(wasmUrl) {
    try {
        const { default: init, WasmEmulator } = await import(wasmUrl);
        await init();
        wasm = { WasmEmulator };
        postMessage({ type: 'ready' });

        // Process any load request that arrived while WASM was initializing
        if (pendingLoad) {
            const msg = pendingLoad;
            pendingLoad = null;
            handleLoad(msg);
        }
    } catch (e) {
        postMessage({ type: 'error', message: `Failed to init WASM: ${e.message}` });
    }
}

function handleLoad(msg) {
    const chip = msg.chip || 'esp32c3';
    try {
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
        const data = new Uint8Array(msg.firmware);
        emulator.load_firmware(data);
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
            // Receive Ethernet frame from TAP proxy → push into emulator WiFi RX
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

    // wifi_tx_drain returns length-prefixed frames: [u32 len][frame bytes]...
    const buf = emulator.wifi_tx_drain();
    if (buf.length === 0) return;

    let offset = 0;
    while (offset + 4 <= buf.length) {
        const len = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
        offset += 4;
        if (offset + len > buf.length) break;
        // Copy into a new ArrayBuffer to avoid sending the entire backing buffer
        const frame = new Uint8Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + len));
        ws.send(frame.buffer);
        offset += len;
    }
}

// Handle messages from main thread
onmessage = function(e) {
    const msg = e.data;

    switch (msg.type) {
        case 'init':
            initWasm(msg.wasmUrl);
            break;

        case 'load':
            if (!wasm) {
                pendingLoad = msg;
                postMessage({ type: 'error', message: 'WASM still loading, please wait...' });
            } else {
                handleLoad(msg);
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
                if (output) postMessage({ type: 'uart_output', data: output });
                output = '';
                try {
                    emulator.restart();
                    postMessage({ type: 'restarted' });
                } catch (err) {
                    postMessage({ type: 'error', message: `Restart failed: ${err}` });
                }
            }
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
    let allOutput = '';

    // Run multiple batches per animation frame for throughput
    while (running) {
        const output = emulator.run_batch(batchSize);
        allOutput += output;
        totalCycles += batchSize;

        // Handle software restart (esp_restart / OTA reboot)
        if (emulator.needs_restart()) {
            // Flush output before restart
            if (allOutput.length > 0) {
                postMessage({ type: 'uart_output', data: allOutput });
                allOutput = '';
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

        // Yield every ~16ms for responsiveness
        if (performance.now() - startTime > 12) break;
    }

    if (allOutput.length > 0) {
        postMessage({ type: 'uart_output', data: allOutput });
    }

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
