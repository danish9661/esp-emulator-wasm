// Minimal ELF32 (little-endian, RISC-V) reader.
// Phase 1 of AGENT.md: resolve firmware symbols so the load-time patcher knows
// which addresses to trampoline. Read-only — no patching happens here.

const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;
const PT_LOAD = 1;

const EM_RISCV = 243;

function cstr(buf, off) {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    return new TextDecoder().decode(buf.subarray(off, end));
}

export class Elf32 {
    constructor(bytes) {
        this.buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);

        const magic = this.buf.subarray(0, 4);
        if (magic[0] !== 0x7f || magic[1] !== 0x45 || magic[2] !== 0x4c || magic[3] !== 0x46) {
            throw new Error('not an ELF (bad magic)');
        }
        if (this.buf[4] !== 1) throw new Error('not ELF32');
        if (this.buf[5] !== 1) throw new Error('not little-endian');

        this.machine = this.u16(0x12);
        if (this.machine !== EM_RISCV) {
            throw new Error(`unexpected machine ${this.machine} (expected RISC-V ${EM_RISCV})`);
        }

        this.entry = this.u32(0x18);
        this.sections = this.#readSections();
        this.segments = this.#readSegments();
    }

    u16(o) { return this.view.getUint16(o, true); }
    u32(o) { return this.view.getUint32(o, true); }

    #readSections() {
        const shoff = this.u32(0x20);
        const shentsize = this.u16(0x2e);
        const shnum = this.u16(0x30);
        const shstrndx = this.u16(0x32);
        if (!shoff || !shnum) return [];

        const raw = [];
        for (let i = 0; i < shnum; i++) {
            const o = shoff + i * shentsize;
            raw.push({
                nameOff: this.u32(o), type: this.u32(o + 4), addr: this.u32(o + 12),
                offset: this.u32(o + 16), size: this.u32(o + 20),
                link: this.u32(o + 24), entsize: this.u32(o + 36),
            });
        }
        const strBase = raw[shstrndx]?.offset ?? 0;
        for (const s of raw) s.name = strBase ? cstr(this.buf, strBase + s.nameOff) : '';
        return raw;
    }

    #readSegments() {
        const phoff = this.u32(0x1c);
        const phentsize = this.u16(0x2a);
        const phnum = this.u16(0x2c);
        const out = [];
        for (let i = 0; i < phnum; i++) {
            const o = phoff + i * phentsize;
            out.push({
                type: this.u32(o), offset: this.u32(o + 4), vaddr: this.u32(o + 8),
                filesz: this.u32(o + 16), memsz: this.u32(o + 20), flags: this.u32(o + 24),
            });
        }
        return out;
    }

    /** All defined function/object symbols, as a Map name -> {value, size}. */
    symbols() {
        if (this.#symCache) return this.#symCache;
        const map = new Map();
        for (const sec of this.sections) {
            if (sec.type !== SHT_SYMTAB && sec.type !== SHT_DYNSYM) continue;
            const strtab = this.sections[sec.link];
            if (!strtab) continue;
            const entsize = sec.entsize || 16;
            for (let o = sec.offset; o + entsize <= sec.offset + sec.size; o += entsize) {
                const nameOff = this.u32(o);
                const value = this.u32(o + 4);
                const size = this.u32(o + 8);
                const shndx = this.u16(o + 14);
                if (!nameOff || shndx === 0) continue;          // unnamed or undefined
                const name = cstr(this.buf, strtab.offset + nameOff);
                if (name && !map.has(name)) map.set(name, { value, size });
            }
        }
        this.#symCache = map;
        return map;
    }
    #symCache = null;

    /** Translate a virtual address to an offset in this ELF file, or null. */
    vaddrToFileOffset(vaddr) {
        for (const p of this.segments) {
            if (p.type !== PT_LOAD) continue;
            if (vaddr >= p.vaddr && vaddr < p.vaddr + p.filesz) {
                return p.offset + (vaddr - p.vaddr);
            }
        }
        return null;
    }

    /** Look up `names`; returns {found: [...], missing: [...]}. */
    resolve(names) {
        const syms = this.symbols();
        const found = [], missing = [];
        for (const n of names) {
            const s = syms.get(n);
            if (s) found.push({ name: n, addr: s.value, size: s.size, fileOffset: this.vaddrToFileOffset(s.value) });
            else missing.push(n);
        }
        return { found, missing };
    }
}

// Driver entry points the shim can intercept (AGENT.md §7).
//
// Two tiers exist, and the Arduino tier is strongly preferred where present:
//
//   arduino-*  esp32-hal-i2c.c / esp32-hal-spi.c. Flat C signatures that carry the
//              device address as a plain argument, so no handle->address map is
//              needed. Arduino's Wire calls i2cWrite/i2cRead; Arduino's SPI does
//              NOT use the IDF spi_master driver at all.
//   idf-*      Raw ESP-IDF projects. Address is buried in an opaque handle.
//
// Signatures (Arduino tier):
//   esp_err_t i2cWrite(uint8_t num, uint16_t address, const uint8_t* buff,
//                      size_t size, uint32_t timeOutMillis)
//   esp_err_t i2cRead (uint8_t num, uint16_t address, uint8_t* buff, size_t size,
//                      uint32_t timeOutMillis, size_t* readCount)
//   uint8_t   spiTransferByte(spi_t* spi, uint8_t data)
export const HOOK_TARGETS = {
    'arduino-i2c': ['i2cWrite', 'i2cRead', 'i2cWriteReadNonStop', 'i2cInit', 'i2cSetClock'],
    'arduino-spi': [
        'spiTransferByte', 'spiTransferByteNL', 'spiWriteByte', 'spiWriteByteNL',
        'spiTransferBytes', 'spiTransferBytesNL',
        'spiTransferShortNL', 'spiWriteShortNL', 'spiTransferLongNL', 'spiWriteLongNL',
        'spiTransferWord', 'spiWriteWord', 'spiTransferLong', 'spiWriteLong',
        'spiWriteNL', 'spiWritePixelsNL',
        'spiTransaction', 'spiEndTransaction', 'spiSimpleTransaction',
        'spiStartBus', 'spiStopBus', 'spiGetClockDiv',
        'spiSetClockDivider', 'spiSetBitOrder', 'spiSetDataMode',
    ],
    'arduino-neopixel': [
        'espShow', 'neopixelWrite', 'rmtInit', '_rmtWrite', 'rmtWrite', '_rmtDetachBus',
    ],
    'arduino-adc': [
        'analogRead', '__analogRead', 'analogReadMilliVolts', '__analogReadMilliVolts',
        '__analogInit', 'analogSetWidth', '__analogSetWidth',
        'analogSetAttenuation', '__analogSetAttenuation',
        'analogSetPinAttenuation', '__analogSetPinAttenuation',
        'read_cal_channel', 'read_cal_channel_done',
    ],
    'arduino-pwm': [
        'analogWrite', 'ledcWrite', 'ledcAttach', 'ledcAttachChannel', 'ledcDetachBus',
    ],
    'mp-adc': [
        'adc_oneshot_new_unit', 'adc_oneshot_config_channel',
        'adc_oneshot_read', 'adc_oneshot_del_unit',
    ],
    'mp-pwm': [
        'ledc_timer_config', 'ledc_channel_config', 'ledc_set_duty',
        'ledc_update_duty', 'ledc_stop', 'ledc_timer_pause', 'ledc_timer_resume',
        'ledc_set_freq', 'ledc_timer_rst', 'esp_clk_tree_src_get_freq_hz',
    ],
    'idf-usb': [
        'usb_serial_jtag_driver_install', 'usb_serial_jtag_write_bytes',
        'usb_serial_jtag_read_bytes', 'usb_serial_jtag_wait_tx_done',
        'usb_serial_jtag_driver_uninstall', 'usb_serial_jtag_is_connected',
    ],
    'idf-i2s': [
        'i2s_driver_install', 'i2s_set_pin', 'i2s_start', 'i2s_stop',
        'i2s_driver_uninstall', 'i2s_write',
    ],
    'idf-twai': [
        'twai_driver_install', 'twai_driver_install_v2',
        'twai_start', 'twai_start_v2',
        'twai_stop', 'twai_driver_uninstall',
        'twai_transmit', 'twai_transmit_v2',
        'twai_receive', 'twai_receive_v2',
    ],
    // Virtualized in this SDK via sketch-provided symbols (the C3/C6/H2/P4
    // Arduino cores gate touch/DAC/SDMMC behind SOC_*_SUPPORTED, so sketches
    // define `extern "C"` fallbacks which the loader overwrites with shims).
    'virtual-touch': [
        'touchRead', 'touchAttachInterrupt', 'touchDetachInterrupt',
    ],
    'virtual-dac': [
        'dacWrite', 'dacDisable',
    ],
    'virtual-sdmmc': [
        'emuSdmmcReadSectors', 'emuSdmmcWriteSectors',
    ],
    'virtual-camera': [
        'emuCameraReadBand',
    ],
    'virtual-lcd': [
        'emuLcdDraw',
    ],
    'idf-i2c-v5': [
        'i2c_master_transmit', 'i2c_master_receive', 'i2c_master_transmit_receive',
        'i2c_master_probe', 'i2c_master_bus_add_device', 'i2c_new_master_bus',
        'i2c_master_device_change_address', 'i2c_master_bus_rm_device', 'i2c_del_master_bus',
        'i2c_master_execute_defined_operations',
    ],
    'idf-i2c-legacy': [
        'i2c_master_write_to_device', 'i2c_master_read_from_device',
        'i2c_master_cmd_begin', 'i2c_master_cmd_begin_static',
        'i2c_param_config', 'i2c_driver_install',
    ],
    'idf-spi': [
        'spi_device_transmit', 'spi_device_polling_transmit',
        'spi_bus_add_device', 'spi_bus_initialize',
    ],
    'thread-15d4': [
        'esp_ieee802154_enable', 'esp_ieee802154_disable',
        'otPlatRadioReceive', 'otPlatRadioGetState', 'otPlatRadioTransmit',
        'otPlatRadioEnergyScan', 'otPlatRadioTxDone', 'otPlatRadioEnergyScanDone',
        'otPlatRadioReceiveDone', 'ieee802154_mac_init', 'ieee802154_transmit',
        'ieee802154_transmit_at',
    ],
};

export function makeJal(fromAddr, toAddr) {
    const diff = toAddr - fromAddr;
    const imm20 = (diff >> 20) & 1;
    const imm10_1 = (diff >> 1) & 0x3ff;
    const imm11 = (diff >> 11) & 1;
    const imm19_12 = (diff >> 12) & 0xff;
    const jalInstr = (imm20 << 31) | (imm10_1 << 21) | (imm11 << 20) | (imm19_12 << 12) | 0x6f;
    return new Uint8Array([jalInstr & 0xff, (jalInstr >> 8) & 0xff, (jalInstr >> 16) & 0xff, (jalInstr >> 24) & 0xff]);
}

/**
 * Prepares effective shims for SPI with dynamic jump patching for trampolines.
 */
export function prepareSpiShims(elf, shims) {
    const syms = elf.resolve([
        'spiTransferBytes', 'spiTransferBytesNL',
        'spiTransferByte', 'spiTransferByteNL',
        'spiWriteByte', 'spiWriteByteNL',
        'spiTransferWord', 'spiTransferShortNL',
        'spiWriteWord', 'spiWriteShortNL',
        'spiTransferLong', 'spiTransferLongNL',
        'spiWriteLong', 'spiWriteLongNL',
    ]);
    const map = {};
    for (const s of syms.found) map[s.name] = s;
    const effectiveShims = { ...shims };

    const pair = (symA, symB, defaultShim) => {
        const a = map[symA];
        const b = map[symB];
        const shim = defaultShim;
        if (!shim) return;

        if (a && b) {
            if (b.size >= shim.length) {
                effectiveShims[symB] = shim;
                effectiveShims[symA] = makeJal(a.addr, b.addr);
            } else if (a.size >= shim.length) {
                effectiveShims[symA] = shim;
                effectiveShims[symB] = makeJal(b.addr, a.addr);
            }
        } else if (a && a.size >= shim.length) {
            effectiveShims[symA] = shim;
        } else if (b && b.size >= shim.length) {
            effectiveShims[symB] = shim;
        }
    };

    pair('spiTransferBytes', 'spiTransferBytesNL', shims.spiTransferBytesNL);
    pair('spiTransferByte', 'spiTransferByteNL', shims.spiTransferByteNL);
    pair('spiWriteByte', 'spiWriteByteNL', shims.spiTransferByteNL || shims.spiWriteByteNL);
    pair('spiTransferWord', 'spiTransferShortNL', shims.spiTransferShortNL);
    pair('spiWriteWord', 'spiWriteShortNL', shims.spiTransferShortNL || shims.spiWriteShortNL);
    pair('spiTransferLong', 'spiTransferLongNL', shims.spiTransferLongNL);
    pair('spiWriteLong', 'spiWriteLongNL', shims.spiTransferLongNL || shims.spiWriteLongNL);

    return effectiveShims;
}

/**
 * IDF-SPI out-of-line pairing: spi_device_transmit / spi_device_polling_transmit
 * are thin wrappers (too small for the full-duplex shim), so both get a JAL
 * trampoline into a single body parked in spi_bus_initialize's dead space
 * (which our noop shim replaces with 8 bytes; body starts at +16).
 * @param {object} elf - Elf32 instance
 * @param {Record<string,Uint8Array>} shims - effective (relocated) shims
 * @returns {{ shims: Record<string,Uint8Array>, extra: Array<{addr:number,bytes:Uint8Array}> }}
 */
export function prepareIdfShims(elf, shims) {
    const out = { shims: {}, extra: [] };
    const body = shims.spi_device_transmit;
    if (!body) return out;
    const { found } = elf.resolve(['spi_bus_initialize', 'spi_device_transmit', 'spi_device_polling_transmit']);
    const byName = Object.fromEntries(found.map(s => [s.name, s]));
    const init = byName['spi_bus_initialize'];
    if (!init) return out;
    const park = init.addr + 16;
    if (park + body.length > init.addr + init.size) return out;
    for (const entry of ['spi_device_transmit', 'spi_device_polling_transmit']) {
        const sym = byName[entry];
        if (!sym || sym.size < 4) continue;
        // JAL range is ±1MB; same image is always in range.
        out.shims[entry] = makeJal(sym.addr, park);
    }
    if (Object.keys(out.shims).length) out.extra.push({ addr: park, bytes: body });
    return out;
}

/**
 * Decide which tiers to patch for each bus. Prefers the Arduino HAL when present.
 * Unions ALL matching tiers per bus (symbol sets are disjoint, e.g. a sketch
 * may use both idf-i2c-v5 and idf-i2c-legacy convenience APIs); `tier` names
 * the first (preferred) match for display.
 * Returns { i2c, spi, neopixel, adc, pwm, i2s, twai, ... }.
 */
export function planHooks(elf) {
    const pick = (tiers) => {
        let name = null;
        const hooks = [];
        for (const tier of tiers) {
            const { found } = elf.resolve(HOOK_TARGETS[tier]);
            if (found.length) {
                if (!name) name = tier;
                hooks.push(...found);
            }
        }
        return hooks.length ? { tier: name, hooks } : null;
    };
    return {
        i2c: pick(['arduino-i2c', 'idf-i2c-v5', 'idf-i2c-legacy']),
        spi: pick(['arduino-spi', 'idf-spi']),
        neopixel: pick(['arduino-neopixel']),
        adc: pick(['arduino-adc', 'mp-adc']),
        pwm: pick(['arduino-pwm', 'mp-pwm']),
        i2s: pick(['idf-i2s']),
        twai: pick(['idf-twai']),
        touch: pick(['virtual-touch']),
        dac: pick(['virtual-dac']),
        sdmmc: pick(['virtual-sdmmc']),
        camera: pick(['virtual-camera']),
        lcd: pick(['virtual-lcd']),
        usb: pick(['idf-usb']),
        thread: pick(['thread-15d4']),
    };
}

