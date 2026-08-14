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
        'spiTransferByte', 'spiTransferByteNL', 'spiTransferBytes', 'spiTransferBytesNL',
        'spiWriteNL', 'spiWritePixelsNL', 'spiWriteByteNL', 'spiWriteShortNL', 'spiWriteLongNL',
        'spiTransferBits', 'spiTransaction', 'spiStartBus', 'spiStopBus',
        'spiSetClockDivider', 'spiSetBitOrder', 'spiSetDataMode',
    ],
    'idf-i2c-v5': [
        'i2c_master_transmit', 'i2c_master_receive', 'i2c_master_transmit_receive',
        'i2c_master_probe', 'i2c_master_bus_add_device', 'i2c_new_master_bus',
    ],
    'idf-i2c-legacy': [
        'i2c_master_write_to_device', 'i2c_master_read_from_device',
        'i2c_master_cmd_begin', 'i2c_param_config', 'i2c_driver_install',
    ],
    'idf-spi': [
        'spi_device_transmit', 'spi_device_polling_transmit',
        'spi_bus_add_device', 'spi_bus_initialize',
    ],
};

/**
 * Decide which tier to patch for each bus. Prefers the Arduino HAL when present.
 * Returns { i2c: {tier, hooks}|null, spi: {tier, hooks}|null }.
 */
export function planHooks(elf) {
    const pick = (tiers) => {
        for (const tier of tiers) {
            const { found } = elf.resolve(HOOK_TARGETS[tier]);
            if (found.length) return { tier, hooks: found };
        }
        return null;
    };
    return {
        i2c: pick(['arduino-i2c', 'idf-i2c-v5', 'idf-i2c-legacy']),
        spi: pick(['arduino-spi', 'idf-spi']),
    };
}
