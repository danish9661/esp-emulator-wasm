// Virtual SDMMC host controller (4-bit SD bus, sector-level emulation).
// Backed by a FAT disk image; shares its on-disk format with VirtualSDCard.

import { createDefaultFat16Image } from '../peripherals.mjs';

export class SDMMCController {
    constructor(diskBuffer = null) {
        this.disk = diskBuffer instanceof Uint8Array ? diskBuffer : createDefaultFat16Image();
        this._listeners = new Set();
    }

    onActivity(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    #emit(type, data) {
        for (const l of this._listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (_) {}
        }
    }

    get sectorCount() {
        return Math.floor(this.disk.length / 512);
    }

    readSectors(lba, count) {
        const out = new Uint8Array(count * 512);
        for (let i = 0; i < out.length; i++) {
            const off = lba * 512 + i;
            out[i] = off < this.disk.length ? this.disk[off] : 0x00;
        }
        this.#emit('read', { lba, count });
        return out;
    }

    writeSectors(lba, data) {
        const count = Math.floor(data.length / 512);
        for (let i = 0; i < count * 512; i++) {
            const off = lba * 512 + i;
            if (off < this.disk.length) this.disk[off] = data[i];
        }
        this.#emit('write', { lba, count });
        return 0;
    }

    /**
     * Accumulate one `M W` chunk frame; applies the write once all
     * `count*512` bytes have arrived (see VirtualSDMMC.writeChunk).
     * @returns {number} 0 when the write applied, -1 while still accumulating.
     */
    writeChunk(lba, count, chunk) {
        const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk || []);
        const key = (lba >>> 0) + ':' + count;
        if (!this._pending || this._pending.key !== key) {
            this._pending = { key, lba: lba >>> 0, count, parts: [], total: 0 };
        }
        this._pending.parts.push(bytes);
        this._pending.total += bytes.length;
        if (this._pending.total >= count * 512) {
            const full = new Uint8Array(count * 512);
            let off = 0;
            for (const part of this._pending.parts) {
                const take = Math.min(part.length, full.length - off);
                full.set(part.subarray(0, take), off);
                off += take;
                if (off >= full.length) break;
            }
            this._pending = null;
            return this.writeSectors(lba, full);
        }
        return -1;
    }
}
