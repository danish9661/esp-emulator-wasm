// ESP-EMU Browser Application with Virtual Peripherals, OLED, ST7789 Color TFT, NeoPixel, and Real Arduino Support

(function() {
    'use strict';

    // --- State ---
    let worker = null;
    let terminal = null;
    let fitAddon = null;
    let isRunning = false;
    let firmwareLoaded = false;
    let wasmReady = false;

    let customBinData = null;
    let customElfData = null;
    let customBinName = null;
    let customElfName = null;

    let netConnected = false;
    const gpioInputStates = new Uint8Array(22);

    // OLED rendering (128x64)
    let oledCanvas = null;
    let oledCtx = null;
    let oledImageData = null;
    let oledFramesRendered = 0;
    let lastOledFpsUpdate = performance.now();
    let oledFps = 0;

    // TFT rendering (240x240 Color)
    let tftCanvas = null;
    let tftCtx = null;
    let tftImageData = null;
    let tftFramesRendered = 0;
    let lastTftFpsUpdate = performance.now();
    let tftFps = 0;

    // Register names for RISC-V RV32
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
                background: '#05080f',
                foreground: '#f3f4f6',
                cursor: '#3b82f6',
                selectionBackground: '#1d4ed8',
                black: '#000000',
                red: '#f43f5e',
                green: '#10b981',
                yellow: '#f59e0b',
                blue: '#3b82f6',
                magenta: '#8b5cf6',
                cyan: '#06b6d4',
                white: '#ffffff',
            },
            fontFamily: "'Fira Code', 'Menlo', 'Consolas', monospace",
            fontSize: 12,
            lineHeight: 1.2,
            convertEol: true,
            cursorBlink: true,
            scrollback: 10000,
        });

        fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(document.getElementById('terminal-container'));
        fitAddon.fit();

        terminal.onData(data => {
            if (worker && firmwareLoaded) {
                const encoder = new TextEncoder();
                worker.postMessage({
                    type: 'uart_input',
                    data: Array.from(encoder.encode(data)),
                });
            }
        });

        window.addEventListener('resize', () => {
            if (fitAddon) fitAddon.fit();
        });

        terminal.writeln('\x1b[1;36m╔════════════════════════════════════════════════════════════════════════════╗');
        terminal.writeln('║   ESP-EMU RISC-V Emulator v0.39.0                                          ║');
        terminal.writeln('║   Virtual Peripherals: ST7789 TFT, SSD1306 OLED, WS2812 NeoPixels, SPI/I2C ║');
        terminal.writeln('║   Dynamic GPIO Auto-Calibration • Load Demo Firmware to start              ║');
        terminal.writeln('╚════════════════════════════════════════════════════════════════════════════╝\x1b[0m\r\n');
    }

    // --- Initialize Displays ---
    function initDisplays() {
        // OLED (128x64)
        oledCanvas = document.getElementById('oled-canvas');
        if (oledCanvas) {
            oledCtx = oledCanvas.getContext('2d', { alpha: false });
            oledImageData = oledCtx.createImageData(128, 64);
            clearOledDisplay();
        }

        // Color TFT (240x240)
        tftCanvas = document.getElementById('tft-canvas');
        if (tftCanvas) {
            tftCtx = tftCanvas.getContext('2d', { alpha: false });
            tftImageData = tftCtx.createImageData(240, 240);
            clearTftDisplay();
        }

        // Initialize NeoPixel 8-LED Strip
        initNeoPixels();
    }

    function initNeoPixels() {
        const strip = document.getElementById('neopixel-strip');
        if (!strip) return;
        strip.innerHTML = '';
        for (let i = 0; i < 8; i++) {
            const led = document.createElement('div');
            led.id = `neopixel-led-${i}`;
            led.style.width = '20px';
            led.style.height = '20px';
            led.style.borderRadius = '50%';
            led.style.backgroundColor = '#111827';
            led.style.border = '2px solid #374151';
            led.style.boxShadow = '0 0 4px rgba(0, 0, 0, 0.5)';
            led.style.transition = 'all 0.08s ease-out';
            led.title = `LED ${i}`;
            strip.appendChild(led);
        }
    }

    function renderNeoPixels(msg) {
        const pinBadge = document.getElementById('neopixel-pin-badge');
        if (pinBadge && typeof msg.pin === 'number') {
            pinBadge.textContent = `Pin: G${msg.pin}`;
        }
        if (!msg.pixels) return;
        for (let i = 0; i < msg.pixels.length && i < 8; i++) {
            const led = document.getElementById(`neopixel-led-${i}`);
            if (!led) continue;
            const { r, g, b } = msg.pixels[i];
            led.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
            const isLit = r > 10 || g > 10 || b > 10;
            if (isLit) {
                led.style.boxShadow = `0 0 10px rgb(${r}, ${g}, ${b}), 0 0 20px rgba(${r}, ${g}, ${b}, 0.5)`;
                led.style.borderColor = `rgba(255, 255, 255, 0.8)`;
            } else {
                led.style.boxShadow = `0 0 4px rgba(0, 0, 0, 0.5)`;
                led.style.borderColor = `#374151`;
            }
        }
    }

    function clearOledDisplay() {
        if (!oledImageData || !oledCtx) return;
        const data = oledImageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 3; data[i + 1] = 8; data[i + 2] = 13; data[i + 3] = 255;
        }
        oledCtx.putImageData(oledImageData, 0, 0);
    }

    function clearTftDisplay() {
        if (!tftImageData || !tftCtx) return;
        const data = tftImageData.data;
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 10; data[i + 1] = 10; data[i + 2] = 15; data[i + 3] = 255;
        }
        tftCtx.putImageData(tftImageData, 0, 0);
    }

    function renderOledFrame(msg) {
        if (!oledCtx || !oledImageData) return;
        const buf = msg.buffer;
        const width = msg.width || 128;
        const height = msg.height || 64;
        const pages = Math.ceil(height / 8);
        const data = oledImageData.data;

        for (let page = 0; page < pages; page++) {
            for (let col = 0; col < width; col++) {
                const byte = buf[page * width + col] || 0;
                for (let bit = 0; bit < 8; bit++) {
                    const y = page * 8 + bit;
                    if (y >= height) continue;
                    const idx = (y * width + col) * 4;
                    const isOn = (byte & (1 << bit)) !== 0;

                    if (isOn) {
                        data[idx] = 0; data[idx + 1] = 255; data[idx + 2] = 255;
                    } else {
                        data[idx] = 3; data[idx + 1] = 8; data[idx + 2] = 13;
                    }
                    data[idx + 3] = 255;
                }
            }
        }

        oledCtx.putImageData(oledImageData, 0, 0);
        oledFramesRendered++;

        const now = performance.now();
        if (now - lastOledFpsUpdate >= 1000) {
            oledFps = Math.round((oledFramesRendered * 1000) / (now - lastOledFpsUpdate));
            const el = document.getElementById('oled-fps');
            if (el) el.textContent = `${oledFps} FPS`;
            oledFramesRendered = 0;
            lastOledFpsUpdate = now;
        }
    }

    function renderTftFrame(msg) {
        if (!tftCtx || !tftImageData) return;
        const buf = msg.buffer;
        tftImageData.data.set(buf);
        tftCtx.putImageData(tftImageData, 0, 0);
        tftFramesRendered++;

        const now = performance.now();
        if (now - lastTftFpsUpdate >= 1000) {
            tftFps = Math.round((tftFramesRendered * 1000) / (now - lastTftFpsUpdate));
            const el = document.getElementById('tft-fps');
            if (el) el.textContent = `${tftFps} FPS`;
            tftFramesRendered = 0;
            lastTftFpsUpdate = now;
        }

        const statusEl = document.getElementById('display-status');
        if (statusEl) {
            statusEl.textContent = 'ST7789 Color TFT ACTIVE';
            statusEl.style.color = '#10b981';
        }
    }

    // --- Initialize GPIO Grid ---
    function initGpioPanel() {
        const grid = document.getElementById('gpio-grid');
        grid.innerHTML = '';
        for (let i = 0; i < 22; i++) {
            const pin = document.createElement('div');
            pin.className = 'gpio-pin dir-in';
            pin.id = `gpio-${i}`;
            pin.innerHTML = `
                <span class="pin-num">G${i}</span>
                <div class="pin-indicator"></div>
                <span class="pin-dir">IN</span>
            `;
            pin.title = `GPIO ${i} (Click to toggle input level)`;
            pin.addEventListener('click', () => toggleGpioInput(i, pin));
            grid.appendChild(pin);
        }
    }

    function toggleGpioInput(pin, el) {
        gpioInputStates[pin] = gpioInputStates[pin] ? 0 : 1;
        if (worker) {
            worker.postMessage({
                type: 'gpio_set',
                pin: pin,
                level: gpioInputStates[pin],
            });
        }
        updatePinUi(pin, gpioInputStates[pin] === 1, false);
    }

    function updateGpioState(outMask, enableMask) {
        for (let i = 0; i < 22; i++) {
            const isOutput = ((enableMask >> i) & 1) === 1;
            const level = isOutput ? ((outMask >> i) & 1) === 1 : (gpioInputStates[i] === 1);
            updatePinUi(i, level, isOutput);
        }
    }

    function updatePinUi(pinIndex, isHigh, isOutput) {
        const el = document.getElementById(`gpio-${pinIndex}`);
        if (!el) return;
        if (isHigh) {
            el.classList.add('high');
        } else {
            el.classList.remove('high');
        }

        const dirEl = el.querySelector('.pin-dir');
        if (isOutput) {
            el.classList.remove('dir-in');
            el.classList.add('dir-out');
            if (dirEl) dirEl.textContent = 'OUT';
        } else {
            el.classList.remove('dir-out');
            el.classList.add('dir-in');
            if (dirEl) dirEl.textContent = 'IN';
        }
    }

    // --- I2C & SPI Activity Log ---
    function logI2cActivity(act) {
        const box = document.getElementById('i2c-log');
        if (!box) return;
        if (box.children.length === 1 && box.children[0].textContent.includes('No transactions')) {
            box.innerHTML = '';
        }
        const row = document.createElement('div');
        row.className = 'i2c-entry';
        const hexAddr = '0x' + act.addr.toString(16).toUpperCase().padStart(2, '0');
        const hexBytes = (act.data || []).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        const opClass = act.op === 'write' ? 'op-write' : 'op-read';
        const opName = act.op.toUpperCase();

        row.innerHTML = `
            <span class="${opClass}">[I2C:${opName}]</span>
            <span class="addr">${hexAddr}</span>
            <span class="bytes">${hexBytes.slice(0, 30)}${hexBytes.length > 30 ? '...' : ''}</span>
        `;
        box.appendChild(row);
        while (box.children.length > 80) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
    }

    function logSpiActivity(act) {
        const box = document.getElementById('i2c-log');
        if (!box) return;
        if (box.children.length === 1 && box.children[0].textContent.includes('No transactions')) {
            box.innerHTML = '';
        }
        const row = document.createElement('div');
        row.className = 'i2c-entry';
        const hexData = (act.data || []).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        const hexReply = (act.reply || []).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
        row.innerHTML = `
            <span style="color: #8b5cf6; font-weight: 600;">[SPI]</span>
            <span style="color: var(--accent-amber);">TX:${hexData.slice(0, 20)}</span>
            <span style="color: var(--accent-green);">RX:${hexReply.slice(0, 20)}</span>
        `;
        box.appendChild(row);
        while (box.children.length > 80) box.removeChild(box.firstChild);
        box.scrollTop = box.scrollHeight;
    }

    // --- Register Table ---
    function initRegTable() {
        const table = document.getElementById('reg-table');
        const tbody = document.createElement('tbody');
        const pcRow = document.createElement('tr');
        pcRow.innerHTML = `<td class="name">pc</td><td class="val" id="reg-pc">00000000</td><td class="name"></td><td class="val"></td>`;
        tbody.appendChild(pcRow);

        for (let i = 0; i < 16; i++) {
            const row = document.createElement('tr');
            const j = i + 16;
            row.innerHTML = `
                <td class="name">x${i} (${REG_NAMES[i]})</td><td class="val" id="reg-${i}">00000000</td>
                <td class="name">x${j} (${REG_NAMES[j]})</td><td class="val" id="reg-${j}">00000000</td>
            `;
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

    // --- Initialize Web Worker ---
    function initWorker() {
        try {
            worker = new Worker('worker.js', { type: 'module' });
        } catch (e) {
            terminal.writeln(`\x1b[31m[Error] Failed to create Web Worker: ${e.message}\x1b[0m`);
            return;
        }

        worker.onerror = function(e) {
            terminal.writeln(`\x1b[31m[Error] Worker exception: ${e.message || e}\x1b[0m`);
        };

        worker.onmessage = function(e) {
            const msg = e.data;
            switch (msg.type) {
                case 'ready':
                    wasmReady = true;
                    document.getElementById('status-text').textContent = 'WASM Ready';
                    document.getElementById('load-preset-btn').disabled = false;
                    terminal.writeln('\x1b[32m[System] WASM Emulator Core initialized.\x1b[0m');
                    // Automatically load NeoPixel Demo on launch!
                    loadPresetFirmware('neopixel_demo');
                    break;

                case 'calibrated':
                    terminal.writeln(`\x1b[35m[Auto-Calibrate] Dynamic GPIO offsets: OUT=0x${msg.out.toString(16)}, EN=0x${msg.enable.toString(16)}, IN=0x${msg.in.toString(16)}\x1b[0m`);
                    break;

                case 'loaded':
                    firmwareLoaded = true;
                    isRunning = false;
                    updateButtons();
                    document.getElementById('status-dot').className = 'status-dot';
                    document.getElementById('status-text').textContent = 'Loaded (Ready)';
                    terminal.writeln(`\x1b[32m[System] Firmware loaded successfully, initial PC = 0x${msg.pc.toString(16)}\x1b[0m\r\n`);
                    break;

                case 'patched': {
                    const statusEl = document.getElementById('patch-status');
                    if (statusEl && msg.patched) {
                        const i2cTier = msg.plan?.i2c?.tier || 'none';
                        const spiTier = msg.plan?.spi?.tier || 'none';
                        const neoTier = msg.plan?.neopixel?.tier || 'none';
                        const syms = msg.patched.map(p => `${p.name}`).join(', ');
                        statusEl.innerHTML = `
                            <div style="color: #10b981; margin-bottom: 2px;">✓ Tiers: I2C (${i2cTier}), SPI (${spiTier}), NeoPixel (${neoTier})</div>
                            <div style="color: #06b6d4;">Shims: ${syms}</div>
                        `;
                        terminal.writeln(`\x1b[36m[Patcher] Applied RISC-V shims: ${syms}\x1b[0m`);
                    }
                    break;
                }

                case 'uart_output':
                    terminal.write(msg.data);
                    break;

                case 'oled_frame':
                    renderOledFrame(msg);
                    break;

                case 'tft_frame':
                    renderTftFrame(msg);
                    break;

                case 'neopixel_frame':
                    renderNeoPixels(msg);
                    break;

                case 'gpio_update':
                    updateGpioState(msg.out, msg.enable);
                    break;

                case 'i2c_activity':
                    logI2cActivity(msg);
                    break;

                case 'spi_activity':
                    logSpiActivity(msg);
                    break;

                case 'sd_activity': {
                    const dot = document.getElementById('sd-act-dot');
                    if (dot) {
                        dot.style.background = '#10b981';
                        dot.style.boxShadow = '0 0 8px rgba(16, 185, 129, 0.6)';
                        setTimeout(() => {
                            dot.style.background = '#374151';
                            dot.style.boxShadow = 'none';
                        }, 120);
                    }
                    const opEl = document.getElementById('sd-last-op');
                    if (opEl) {
                        if (msg.type === 'read_sector') {
                            opEl.textContent = `Read Sec ${msg.lba}`;
                        } else if (msg.type === 'read_multiple') {
                            opEl.textContent = `Read Mult Sec ${msg.lba}`;
                        } else if (msg.cmd) {
                            opEl.textContent = `${msg.cmd}`;
                        }
                    }
                    break;
                }

                case 'sd_disk_data': {
                    if (msg.buffer) {
                        const blob = new Blob([msg.buffer], { type: 'application/octet-stream' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'sdcard.img';
                        a.click();
                        URL.revokeObjectURL(url);
                        terminal.writeln('\x1b[32m[SD] Virtual SD Card disk image exported (sdcard.img).\x1b[0m');
                    }
                    break;
                }

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
                    terminal.writeln('\x1b[33m\r\n[System] Software reset detected (esp_restart)\x1b[0m\r\n');
                    break;

                case 'reset':
                    terminal.clear();
                    isRunning = false;
                    clearOledDisplay();
                    clearTftDisplay();
                    initNeoPixels();
                    if (msg.reloaded) {
                        terminal.writeln('\x1b[33m[System] Emulator reset completed\x1b[0m');
                        firmwareLoaded = true;
                        document.getElementById('status-text').textContent = 'Ready';
                    } else {
                        firmwareLoaded = false;
                        document.getElementById('status-text').textContent = 'Reset';
                    }
                    updateButtons();
                    break;

                case 'mem_data': {
                    const disp = document.getElementById('mem-display');
                    if (msg.bytes) {
                        let text = '';
                        for (let i = 0; i < msg.bytes.length; i += 16) {
                            const chunk = msg.bytes.slice(i, i + 16);
                            const hex = chunk.map(b => b.toString(16).padStart(2, '0')).join(' ');
                            const ascii = chunk.map(b => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.')).join('');
                            text += `0x${(msg.addr + i).toString(16).padStart(8, '0')}:  ${hex.padEnd(48, ' ')}  |${ascii}|\n`;
                        }
                        disp.textContent = text;
                    } else {
                        disp.textContent = `Error: ${msg.error}`;
                    }
                    break;
                }

                case 'error':
                    terminal.writeln(`\x1b[31m[Error] ${msg.message}\x1b[0m`);
                    break;
            }
        };

        worker.postMessage({ type: 'init', wasmUrl: './pkg/esp_emu.js' });
    }

    // --- Load Preset Firmware Demo ---
    async function loadPresetFirmware(key) {
        if (!worker || !wasmReady) return;
        const btn = document.getElementById('load-preset-btn');
        btn.disabled = true;
        btn.textContent = '⏳ Loading Demo...';

        const filenames = {
            neopixel_demo: { bin: 'samples/neopixel_demo.merged.bin', elf: 'samples/neopixel_demo.elf', title: 'Adafruit NeoPixel 8-LED Strip' },
            sdcard_demo: { bin: 'samples/sdcard_demo.merged.bin', elf: 'samples/sdcard_demo.elf', title: 'Virtual SD Card FAT16 (SPI CS=7)' },
            st7789_demo: { bin: 'samples/st7789_demo.merged.bin', elf: 'samples/st7789_demo.elf', title: 'Adafruit ST7789 Color TFT Demo (240x240)' },
            oled_demo: { bin: 'samples/oled_demo.merged.bin', elf: 'samples/oled_demo.elf', title: 'Adafruit SSD1306 OLED Demo (128x64)' },
            blink: { bin: 'samples/blink.merged.bin', elf: 'samples/blink.elf', title: 'Blink GPIO2 Demo' },
            i2cread: { bin: 'samples/i2cread.merged.bin', elf: 'samples/i2cread.elf', title: 'I2C Sensor Read (0x68)' },
            spidemo: { bin: 'samples/spidemo.merged.bin', elf: 'samples/spidemo.elf', title: 'SPI Master Transfer' },
            busprobe: { bin: 'samples/busprobe.merged.bin', elf: 'samples/busprobe.elf', title: 'Dual Bus Probe (I2C + SPI)' },
        };

        const target = filenames[key] || filenames.neopixel_demo;
        terminal.writeln(`\x1b[35m[Preset] Fetching ${target.title}...\x1b[0m`);

        try {
            const [binRes, elfRes] = await Promise.all([
                fetch(target.bin),
                fetch(target.elf),
            ]);

            if (!binRes.ok || !elfRes.ok) {
                throw new Error(`Failed to fetch preset files: ${binRes.statusText} / ${elfRes.statusText}`);
            }

            const binBuf = await binRes.arrayBuffer();
            const elfBuf = await elfRes.arrayBuffer();

            terminal.writeln(`\x1b[35m[Preset] ${target.title} loaded (${binBuf.byteLength} B Flash, ${elfBuf.byteLength} B ELF)\x1b[0m`);

            const chip = document.getElementById('chip-select').value;
            const bootRom = document.getElementById('boot-rom-chk').checked;

            worker.postMessage({
                type: 'load',
                chip: chip,
                firmware: binBuf,
                elf: elfBuf,
                skipRom: !bootRom,
            });

            setTimeout(() => {
                if (firmwareLoaded && !isRunning) {
                    startExecution();
                }
            }, 300);

        } catch (err) {
            terminal.writeln(`\x1b[31m[Error] Failed to load preset: ${err.message}\x1b[0m`);
        } finally {
            btn.disabled = false;
            btn.textContent = '⚡ Load Demo Firmware';
        }
    }

    // --- Execution Controls ---
    function startExecution() {
        if (!firmwareLoaded) return;
        isRunning = true;
        updateButtons();
        document.getElementById('status-dot').className = 'status-dot active';
        document.getElementById('status-text').textContent = 'Running';
        worker.postMessage({ type: 'start' });
    }

    function pauseExecution() {
        isRunning = false;
        updateButtons();
        document.getElementById('status-dot').className = 'status-dot paused';
        document.getElementById('status-text').textContent = 'Paused';
        worker.postMessage({ type: 'stop' });
    }

    function updateButtons() {
        document.getElementById('run-btn').disabled = !firmwareLoaded || isRunning;
        document.getElementById('pause-btn').disabled = !isRunning;
        document.getElementById('step-btn').disabled = !firmwareLoaded || isRunning;
        document.getElementById('reset-btn').disabled = !firmwareLoaded;
    }

    // --- Setup UI Event Listeners ---
    function setupControls() {
        document.getElementById('load-preset-btn').addEventListener('click', () => {
            const key = document.getElementById('preset-select').value;
            loadPresetFirmware(key);
        });

        document.getElementById('firmware-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            customBinData = await file.arrayBuffer();
            customBinName = file.name;
            document.getElementById('upload-bin-btn').textContent = `FW: ${file.name}`;
            terminal.writeln(`\x1b[36m[Upload] Selected Flash binary: ${file.name} (${customBinData.byteLength} bytes)\x1b[0m`);
            triggerCustomLoadIfReady();
        });

        document.getElementById('elf-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            customElfData = await file.arrayBuffer();
            customElfName = file.name;
            document.getElementById('upload-elf-btn').textContent = `ELF: ${file.name}`;
            terminal.writeln(`\x1b[36m[Upload] Selected ELF symbols: ${file.name} (${customElfData.byteLength} bytes)\x1b[0m`);
            triggerCustomLoadIfReady();
        });

        function triggerCustomLoadIfReady() {
            if (!customBinData || !worker) return;
            const chip = document.getElementById('chip-select').value;
            const bootRom = document.getElementById('boot-rom-chk').checked;

            terminal.writeln(`\x1b[36m[System] Loading custom firmware into ${chip}...\x1b[0m`);
            worker.postMessage({
                type: 'load',
                chip: chip,
                firmware: customBinData.slice(0),
                elf: customElfData ? customElfData.slice(0) : null,
                skipRom: !bootRom,
            });
        }

        document.getElementById('run-btn').addEventListener('click', startExecution);
        document.getElementById('pause-btn').addEventListener('click', pauseExecution);
        document.getElementById('step-btn').addEventListener('click', () => {
            if (worker) worker.postMessage({ type: 'step' });
        });
        document.getElementById('reset-btn').addEventListener('click', () => {
            if (worker) {
                const chip = document.getElementById('chip-select').value;
                worker.postMessage({ type: 'reset', chip: chip });
            }
        });

        document.getElementById('clear-term-btn').addEventListener('click', () => {
            if (terminal) terminal.clear();
        });
        document.getElementById('clear-i2c-btn').addEventListener('click', () => {
            document.getElementById('i2c-log').innerHTML = '<div style="color: var(--text-dim);">Log cleared.</div>';
        });

        const sdDownBtn = document.getElementById('sd-download-btn');
        if (sdDownBtn) {
            sdDownBtn.addEventListener('click', () => {
                if (worker) worker.postMessage({ type: 'sd_download_img' });
            });
        }

        document.getElementById('mem-read-btn').addEventListener('click', () => {
            const addrStr = document.getElementById('mem-addr').value.trim();
            const addr = parseInt(addrStr, 16);
            if (isNaN(addr)) {
                document.getElementById('mem-display').textContent = 'Invalid hex address';
                return;
            }
            if (worker) {
                worker.postMessage({ type: 'mem_read', addr: addr, length: 64 });
            }
        });
    }

    // --- Init ---
    document.addEventListener('DOMContentLoaded', () => {
        initTerminal();
        initDisplays();
        initGpioPanel();
        initRegTable();
        setupControls();
        initWorker();
    });
})();
