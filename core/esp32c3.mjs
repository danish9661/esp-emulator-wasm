// Unified MCU Core Engine for ESP32 RISC-V (esp-rv32-js)
// Provides rp2040js-style JavaScript API for CPU execution, memory access,
// load-time binary patching, and on-chip peripheral buses.

import { Elf32, planHooks, prepareSpiShims, prepareIdfShims } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS, relocateShimsForChip } from '../shims.mjs';
import { prepareBleShims } from './ble_shims.mjs';
import { prepareThreadShims } from './thread_shims.mjs';
import { ThreadController } from './thread_controller.mjs';
import { GPIOController } from './gpio.mjs';
import { I2CBus } from './i2c.mjs';
import { SPIBus } from './spi.mjs';
import { ADCController } from './adc.mjs';
import { PWMController } from './pwm.mjs';
import { I2SController } from './i2s.mjs';
import { TWAIController } from './twai.mjs';
import { NeoPixelController } from './neopixel.mjs';
import { UARTController } from './uart.mjs';
import { TouchController } from './touch.mjs';
import { DACController } from './dac.mjs';
import { SDMMCController } from './sdmmc.mjs';
import { CameraController } from './camera.mjs';
import { LCDController } from './lcd.mjs';

// Node-side wasm module counter for per-instance isolation (see create()).
let wasmInstanceCounter = 0;

export class ESP32C3 {
    /**
     * @param {object} wasmInstance - Initialized WasmEmulator instance
     * @param {WebAssembly.Memory} wasmMemory - WASM linear memory export
     * @param {string} [chip='esp32c3'] - Target chip
     */
    constructor(wasmInstance, wasmMemory, chip = 'esp32c3') {
        this.emu = wasmInstance;
        this.memory = wasmMemory;
        this.chip = chip;
        this.running = false;

        // On-chip peripheral controllers
        this.gpio = new GPIOController();
        this.gpio.bindMemory(this.memory);

        this.i2c = new I2CBus();
        this.spi = new SPIBus();
        this.adc = new ADCController();
        this.pwm = new PWMController();
        this.i2s = new I2SController();
        this.twai = new TWAIController();
        this.neopixel = new NeoPixelController();
        this.touch = new TouchController();
        this.dac = new DACController();
        this.sdmmc = new SDMMCController();
        this.camera = new CameraController();
        this.lcd = new LCDController();
        this.thread = new ThreadController();
        this.uart0 = new UARTController(this.emu);
        this.uart0.bindMemory(this.memory);

        this._patchedHooks = [];
    }

    /**
     * Factory: Create and initialize an ESP32 MCU instance.
     * @param {object} [options]
     * @param {string} [options.chip='esp32c3'] - 'esp32c3', 'esp32c6', 'esp32h2', 'esp32c5', 'esp32p4', 'esp32s31'
     * @param {boolean} [options.bootFromRom=true] - Enable ROM boot sequence
     * @param {string | URL} [options.wasmModuleUrl] - Custom path to esp_emu.js / wasm
     * @returns {Promise<ESP32C3>}
     */
    static async create(options = {}) {
        const chip = options.chip || 'esp32c3';
        const bootFromRom = options.bootFromRom !== false;

        let wasmExports, WasmEmulator;
        const isBrowser = typeof window !== 'undefined' || (typeof self !== 'undefined' && typeof process === 'undefined');

        if (isBrowser) {
            const mod = await import('../pkg/esp_emu.js');
            wasmExports = await mod.default(options.wasmModuleUrl);
            WasmEmulator = mod.WasmEmulator;
        } else {
            const { readFileSync } = await import('node:fs');
            const { fileURLToPath } = await import('node:url');
            const { dirname, join } = await import('node:path');
            const here = dirname(fileURLToPath(import.meta.url));
            const pkgPath = join(here, '..', 'pkg');
            // Isolate each MCU in a FRESH wasm module instance. initSync
            // caches `wasm` per module, so all MCUs would otherwise share one
            // dlmalloc heap — and pkg 0.42 corrupts it deterministically
            // across runs (3rd instance aborts; see issue.md #3). The query
            // string busts Node's ESM cache; costs one wasm compile/create.
            wasmInstanceCounter += 1;
            const { pathToFileURL } = await import('node:url');
            const glueUrl = pathToFileURL(join(pkgPath, 'esp_emu.js')).href +
                `?instance=${wasmInstanceCounter}`;
            const mod = await import(glueUrl);
            const wasmBytes = readFileSync(join(pkgPath, 'esp_emu_bg.wasm'));
            wasmExports = mod.initSync({ module: wasmBytes });
            WasmEmulator = mod.WasmEmulator;
        }

        const emu = new WasmEmulator(chip);
        if (bootFromRom && emu.load_default_rom) {
            try {
                if (chip === 'esp32p4') {
                    // The embedded default P4 ROM (eco5) uses a different
                    // trampoline layout than Arduino/IDF bootloaders. Use the
                    // bundled rev0 ROM ELF instead (same path as the working
                    // C3/C6/H2 default-rom boot).
                    const { readFileSync } = await import('node:fs');
                    const { fileURLToPath } = await import('node:url');
                    const { dirname, join } = await import('node:path');
                    const here = dirname(fileURLToPath(import.meta.url));
                    const romElf = readFileSync(join(here, '..', 'samples', 'p4', 'esp32p4_rev0_rom.elf'));
                    emu.load_rom_elf(new Uint8Array(romElf));
                } else {
                    emu.load_default_rom();
                }
                emu.set_boot_from_rom(true);
            } catch (_) {}
        }

        return new ESP32C3(emu, wasmExports.memory, chip);
    }

    /**
     * Load firmware into flash and optionally apply automatic ELF symbol patching.
     * @param {Uint8Array | ArrayBuffer} flashBinary - Merged flash image (.bin)
     * @param {Uint8Array | ArrayBuffer | null} [elfBinary=null] - App ELF for symbol patching
     * @returns {Promise<{ patched: string[] }>}
     */
    async loadFirmware(flashBinary, elfBinary = null) {
        let flashBuf = flashBinary instanceof Uint8Array ? flashBinary : new Uint8Array(flashBinary);
        this._patchedHooks = [];
        // Fresh boot image: forget any cached BLE mirror mapping.
        if (this.uart0 && this.uart0.bleMirror) this.uart0.bleMirror.clear();
        if (this.thread) this.thread.reset();

        if (elfBinary) {
            try {
                const elfBuf = elfBinary instanceof Uint8Array ? elfBinary : new Uint8Array(elfBinary);
                const elf = new Elf32(elfBuf);
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
                    .concat(hookPlan?.usb?.hooks || [])
                    .concat(hookPlan?.thread?.hooks || []);

                const hooks = Object.fromEntries(allHooks.map(h => [h.name, h]));
                const effectiveShims = prepareSpiShims(elf, relocateShimsForChip(SHIMS, this.chip));
                const idfExtras = [];

                // IDF raw-driver shims (SPI transaction trampolines park a body
                // in dead init space; I2C shims patch inline). Warn for tiers
                // that resolve but still lack bytecode (e.g. cmd-link API).
                {
                    const idf = prepareIdfShims(elf, effectiveShims);
                    for (const [fn, shim] of Object.entries(idf.shims)) effectiveShims[fn] = shim;
                    idfExtras.push(...idf.extra);
                }
                for (const [bus, plan] of Object.entries(hookPlan || {})) {
                    if (!plan || !plan.tier || !plan.tier.startsWith('idf-') ||
                        (bus !== 'i2c' && bus !== 'spi')) continue;
                    const uncovered = (plan.hooks || []).filter(h => !effectiveShims[h.name]);
                    if (uncovered.length) {
                        console.warn(`[ESP32C3] ${bus} tier ${plan.tier} unpatched: ${uncovered.map(h => h.name).join(', ')}`);
                    }
                }

                // BLE interception shims (JS-side VHCI controller). The 4 trivial
                // functions are inlined; esp_vhci_host_send_packet parks a large shim
                // in the dead body of esp_bt_controller_init via a trampoline.
                const ble = prepareBleShims(elf, this.chip);
                for (const [fn, shim] of Object.entries(ble.shims)) effectiveShims[fn] = shim;
                for (const h of ble.hooks || []) hooks[h.name] = h;

                // 802.15.4 / Thread radio shims (soft: missing/small skips).
                // The EnergyScan parked body travels via th.extra (written
                // below alongside the BLE/IDF extras).
                try {
                    const th = prepareThreadShims(elf, this.chip);
                    for (const [fn, shim] of Object.entries(th.shims)) effectiveShims[fn] = shim;
                    for (const h of th.hooks || []) hooks[h.name] = h;
                    idfExtras.push(...(th.extra || []));
                } catch (e) {
                    console.warn('[ESP32C3] thread shim prep skipped:', e?.message || e);
                }

                const img = new EspImage(flashBuf);
                for (const [fn, shim] of Object.entries(effectiveShims)) {
                    if (hooks[fn] && shim.length <= hooks[fn].size) {
                        try {
                            img.writeAtVaddr(hooks[fn].addr, shim);
                            this._patchedHooks.push(fn);
                        } catch (e) {
                            // One unlocatable hook (ROM-absolute symbol, or
                            // XIP code missing from a partial flash image)
                            // must not nuke the rest of the patch set.
                            console.warn(`[ESP32C3] skip ${fn}: ${e.message}`);
                        }
                    } else if (hooks[fn] && shim.length > hooks[fn].size) {
                        console.warn(`[ESP32C3] skip ${fn}: shim ${shim.length}B > func ${hooks[fn].size}B`);
                    }
                }
                for (const ex of ble.extra || []) {
                    try {
                        img.writeAtVaddr(ex.addr, ex.bytes);
                        this._patchedHooks.push('ble:' + ex.addr.toString(16));
                    } catch (_) {}
                }
                for (const ex of idfExtras || []) {
                    try {
                        img.writeAtVaddr(ex.addr, ex.bytes);
                        this._patchedHooks.push('idf:' + ex.addr.toString(16));
                    } catch (_) {}
                }

                if (this._patchedHooks.length > 0) {
                    await img.reseal();
                }
            } catch (err) {
                console.warn('[ESP32C3] Warning: ELF patching skipped due to error:', err);
            }
        }

        this.emu.load_firmware(flashBuf);
        return { patched: this._patchedHooks };
    }

    /**
     * Execute N instructions and process peripheral I/O.
     * @param {number} [instructionCount=100000] - Instructions to step
     * @returns {string} Clean serial console output
     */
    step(instructionCount = 100000) {
        const rawOutput = this.emu.run_batch(instructionCount);
        this.gpio.sync();

        return this.uart0.processOutputChunk(rawOutput, {
            i2c: this.i2c,
            spi: this.spi,
            neopixel: this.neopixel,
            adc: this.adc,
            pwm: this.pwm,
            i2s: this.i2s,
            twai: this.twai,
            ble: this.uart0.ble,
            touch: this.touch,
            dac: this.dac,
            sdmmc: this.sdmmc,
            camera: this.camera,
            lcd: this.lcd,
            thread: this.thread,
        });
    }

    /**
     * Get the current CPU Program Counter.
     * @returns {number}
     */
    get pc() {
        return this.emu.pc();
    }

    /**
     * Get total CPU cycles executed.
     * @returns {number}
     */
    get cycles() {
        return this.emu.cycles();
    }

    /**
     * Get a specific RISC-V register value (x0..x31).
     * @param {number} regIndex
     * @returns {number}
     */
    getRegister(regIndex) {
        return this.emu.get_reg(regIndex);
    }

    /**
     * Read an array of bytes from emulator memory space.
     * @param {number} address
     * @param {number} length
     * @returns {Uint8Array}
     */
    readMemory(address, length) {
        const u8 = new Uint8Array(this.memory.buffer);
        if (address < 0 || address + length > u8.length) {
            throw new Error(`Memory read out of bounds: 0x${address.toString(16)} (len: ${length})`);
        }
        return u8.slice(address, address + length);
    }

    /**
     * Write an array of bytes into emulator memory space.
     * @param {number} address
     * @param {Uint8Array | number[]} bytes
     */
    writeMemory(address, bytes) {
        const u8 = new Uint8Array(this.memory.buffer);
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (address < 0 || address + data.length > u8.length) {
            throw new Error(`Memory write out of bounds: 0x${address.toString(16)} (len: ${data.length})`);
        }
        u8.set(data, address);
    }

    /**
     * Trigger a software reset.
     */
    restart() {
        this.emu.restart();
    }
}
