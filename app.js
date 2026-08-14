// ESP-EMU Browser Application
// Orchestrates UI, Web Worker, and terminal

(function() {
    'use strict';

    // --- State ---
    let worker = null;
    let terminal = null;
    let fitAddon = null;
    let isRunning = false;
    let firmwareLoaded = false;
    let romData = null;
    let romFilename = null;
    let netConnected = false;

    // Labels for the embedded default ROMs (mirrors roms/ at build time).
    const ROM_DEFAULTS = {
        esp32c3: 'esp32c3 rev3 (embedded)',
        esp32c6: 'esp32c6 rev0 (embedded)',
        esp32h2: 'esp32h2 rev0 (embedded)',
        esp32p4: 'esp32p4 rev3 (embedded)',
    };

    function updateRomBtnLabel() {
        const btn = document.getElementById('rom-btn');
        if (!btn) return;
        if (romFilename) {
            btn.textContent = 'Custom: ' + romFilename;
        } else {
            const chip = document.getElementById('chip-select').value;
            btn.textContent = ROM_DEFAULTS[chip] || 'Select ROM...';
        }
    }

    // --- Register names ---
    const REG_NAMES = [
        'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
        's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
        'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
        's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
    ];

    // --- Initialize Terminal ---
    function initTerminal() {
        terminal = new Terminal({
            theme: {
                background: '#0a0a1a',
                foreground: '#e0e0e0',
                cursor: '#e94560',
                selectionBackground: '#533483',
            },
            fontFamily: "'Menlo', 'Consolas', 'Courier New', monospace",
            fontSize: 13,
            convertEol: true,
            cursorBlink: true,
            scrollback: 10000,
        });
        fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        // Handle terminal input -> UART RX
        terminal.onData(data => {
            if (worker && firmwareLoaded) {
                const encoder = new TextEncoder();
                worker.postMessage({
                    type: 'uart_input',
                    data: Array.from(encoder.encode(data)),
                });
            }
        });

        // Resize handling
        window.addEventListener('resize', () => {
            if (fitAddon) fitAddon.fit();
        });

        terminal.writeln('\x1b[1;35m╔══════════════════════════════════════╗');
        terminal.writeln('║   ESP-EMU RISC-V Emulator v0.39.0    ║');
        terminal.writeln('║   Load a firmware .bin to begin      ║');
        terminal.writeln('╚══════════════════════════════════════╝\x1b[0m');
        terminal.writeln('');
    }

    // --- Initialize GPIO Panel ---
    function initGpioPanel() {
        const grid = document.getElementById('gpio-grid');
        for (let i = 0; i < 22; i++) {
            const pin = document.createElement('div');
            pin.className = 'gpio-pin low';
            pin.id = `gpio-${i}`;
            pin.textContent = i;
            pin.title = `GPIO ${i}`;
            pin.addEventListener('click', () => toggleGpioInput(i, pin));
            grid.appendChild(pin);
        }
    }

    function toggleGpioInput(pin, el) {
        el.classList.toggle('high');
        el.classList.toggle('low');
        // TODO: Send GPIO input to worker when implemented
    }

    // --- Initialize Register Table ---
    function initRegTable() {
        const table = document.getElementById('reg-table');
        const tbody = document.createElement('tbody');
        // PC row
        const pcRow = document.createElement('tr');
        pcRow.innerHTML = `<td class="name">pc</td><td class="val" id="reg-pc">00000000</td>
                           <td class="name"></td><td class="val"></td>`;
        tbody.appendChild(pcRow);
        // x0-x31 in two columns
        for (let i = 0; i < 16; i++) {
            const row = document.createElement('tr');
            const j = i + 16;
            row.innerHTML = `<td class="name">x${i} (${REG_NAMES[i]})</td><td class="val" id="reg-${i}">00000000</td>` +
                            `<td class="name">x${j} (${REG_NAMES[j]})</td><td class="val" id="reg-${j}">00000000</td>`;
            tbody.appendChild(row);
        }
        table.appendChild(tbody);
    }

    function updateRegisters(regs, pc) {
        const pcEl = document.getElementById('reg-pc');
        if (pcEl) pcEl.textContent = pc.toString(16).padStart(8, '0');
        for (let i = 0; i < 32; i++) {
            const el = document.getElementById(`reg-${i}`);
            if (el) el.textContent = (regs[i] >>> 0).toString(16).padStart(8, '0');
        }
    }

    // --- Initialize Worker ---
    function initWorker() {
        terminal.writeln('\x1b[33m[System] Initializing WASM module...\x1b[0m');

        try {
            worker = new Worker('worker.js', { type: 'module' });
        } catch (e) {
            terminal.writeln(`\x1b[31m[Error] Failed to create worker: ${e.message}\x1b[0m`);
            terminal.writeln('\x1b[31m[Error] Make sure you are serving via HTTP (not file://)\x1b[0m');
            return;
        }

        worker.onerror = function(e) {
            terminal.writeln(`\x1b[31m[Error] Worker failed: ${e.message || e}\x1b[0m`);
            terminal.writeln('\x1b[31m[Error] Check browser console (F12) for details\x1b[0m');
        };

        worker.onmessage = function(e) {
            const msg = e.data;
            switch (msg.type) {
                case 'ready':
                    terminal.writeln('\x1b[32m[System] WASM module loaded\x1b[0m');
                    break;

                case 'loaded':
                    firmwareLoaded = true;
                    updateButtons();
                    terminal.writeln(`\x1b[32m[System] Firmware loaded, PC=0x${msg.pc.toString(16)}\x1b[0m`);
                    terminal.writeln('');
                    document.getElementById('status-text').textContent = 'Ready';
                    break;

                case 'uart_output':
                    terminal.write(msg.data);
                    break;

                case 'status':
                    document.getElementById('mips-display').textContent = `${msg.mips} MIPS`;
                    document.getElementById('cycle-display').textContent = `${Math.floor(msg.cycles)} cycles`;
                    break;

                case 'step':
                    if (msg.output) terminal.write(msg.output);
                    document.getElementById('cycle-display').textContent = `${Math.floor(msg.cycles)} cycles`;
                    break;

                case 'registers':
                    updateRegisters(msg.regs, msg.pc);
                    break;

                case 'restarted':
                    terminal.writeln('\x1b[33m[System] Software restart (esp_restart)\x1b[0m');
                    break;

                case 'reset':
                    terminal.clear();
                    isRunning = false;
                    if (msg.reloaded) {
                        terminal.writeln('\x1b[33m[System] Emulator reset\x1b[0m');
                        terminal.writeln(`\x1b[32m[System] Firmware reloaded, PC=0x${msg.pc.toString(16)}\x1b[0m`);
                        firmwareLoaded = true;
                        document.getElementById('status-text').textContent = 'Ready';
                    } else {
                        terminal.writeln('\x1b[33m[System] Emulator reset (no firmware)\x1b[0m');
                        firmwareLoaded = false;
                        document.getElementById('status-text').textContent = 'Reset';
                    }
                    updateButtons();
                    break;

                case 'net_status':
                    netConnected = msg.connected;
                    const netBtn = document.getElementById('net-btn');
                    if (msg.connected) {
                        terminal.writeln('\x1b[32m[Network] Connected to WebSocket proxy\x1b[0m');
                        netBtn.textContent = 'Disconnect';
                        netBtn.classList.add('primary');
                    } else {
                        terminal.writeln('\x1b[33m[Network] Disconnected\x1b[0m');
                        netBtn.textContent = 'Connect Net';
                        netBtn.classList.remove('primary');
                    }
                    break;

                case 'error':
                    terminal.writeln(`\x1b[31m[Error] ${msg.message}\x1b[0m`);
                    break;
            }
        };

        worker.postMessage({ type: 'init', wasmUrl: './pkg/esp_emu.js' });
    }

    // --- Button Handlers ---
    function updateButtons() {
        document.getElementById('run-btn').disabled = !firmwareLoaded || isRunning;
        document.getElementById('pause-btn').disabled = !isRunning;
        document.getElementById('step-btn').disabled = !firmwareLoaded || isRunning;
        document.getElementById('reset-btn').disabled = !firmwareLoaded;
    }

    function setupControls() {
        // ROM ELF upload (optional — overrides the chip's embedded default)
        document.getElementById('rom-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            romData = await file.arrayBuffer();
            romFilename = file.name;
            terminal.writeln(`\x1b[36m[System] ROM ELF override loaded: ${file.name} (${romData.byteLength} bytes)\x1b[0m`);
            updateRomBtnLabel();
        });

        // Reflect the embedded default in the ROM button when the chip changes.
        document.getElementById('chip-select').addEventListener('change', updateRomBtnLabel);
        updateRomBtnLabel();

        // Firmware upload
        document.getElementById('firmware-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const chip = document.getElementById('chip-select').value;
            const buffer = await file.arrayBuffer();
            terminal.writeln(`\x1b[36m[System] Loading ${file.name} (${buffer.byteLength} bytes) for ${chip}...\x1b[0m`);
            document.getElementById('upload-btn').textContent = 'FW: ' + file.name;

            const transferList = [buffer];
            const msg = {
                type: 'load',
                chip: chip,
                firmware: buffer,
                ssid: document.getElementById('wifi-ssid').value,
                password: document.getElementById('wifi-password').value,
            };
            if (romData) {
                const romCopy = romData.slice(0);
                msg.rom = romCopy;
                transferList.push(romCopy);
            }
            if (worker) {
                worker.postMessage(msg, transferList);
            }
        });

        // Run
        document.getElementById('run-btn').addEventListener('click', () => {
            isRunning = true;
            updateButtons();
            worker.postMessage({ type: 'start' });
            document.getElementById('status-text').textContent = 'Running';
        });

        // Pause
        document.getElementById('pause-btn').addEventListener('click', () => {
            isRunning = false;
            updateButtons();
            worker.postMessage({ type: 'stop' });
            document.getElementById('status-text').textContent = 'Paused';
        });

        // Step
        document.getElementById('step-btn').addEventListener('click', () => {
            worker.postMessage({ type: 'step' });
        });

        // Reset
        document.getElementById('reset-btn').addEventListener('click', () => {
            const chip = document.getElementById('chip-select').value;
            worker.postMessage({ type: 'reset', chip: chip });
        });

        // Network connect/disconnect
        document.getElementById('net-btn').addEventListener('click', () => {
            if (netConnected) {
                worker.postMessage({ type: 'net_disconnect' });
            } else {
                const url = document.getElementById('net-url').value;
                worker.postMessage({ type: 'net_connect', url: url });
            }
        });

        // Memory inspector
        document.getElementById('mem-read-btn').addEventListener('click', () => {
            // Memory reading would need to be added to the worker protocol
            const addrStr = document.getElementById('mem-addr').value;
            document.getElementById('mem-display').textContent = `Memory view at ${addrStr}\n(requires wasm build)`;
        });
    }

    // --- Init ---
    document.addEventListener('DOMContentLoaded', () => {
        initTerminal();
        initGpioPanel();
        initRegTable();
        setupControls();
        initWorker();
    });
})();
