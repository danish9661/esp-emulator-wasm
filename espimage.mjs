// ESP-IDF application image surgery (AGENT.md Phase 2).
//
// Locates the app image inside a merged flash image, maps guest virtual addresses
// to byte offsets, applies patches, and re-seals the image (checksum + SHA256).
//
// Image layout:
//   [24B header][segment0 hdr 8B][segment0 data]...[pad][1B checksum][32B SHA256?]
// Checksum is XOR of every segment DATA byte, seeded with 0xEF, and is placed so it
// lands on the last byte of a 16-byte-aligned block. The SHA256, when
// header.hash_appended is set, covers everything from image start through checksum.

const MAGIC = 0xe9;
const HDR_LEN = 24;
const SEG_HDR_LEN = 8;
const CHECKSUM_SEED = 0xef;

/** Offsets where an app image may start in a merged flash image. */
const APP_OFFSET_CANDIDATES = [0x10000, 0x100000, 0x20000, 0x8000, 0x1000, 0x0];

export class EspImage {
    /**
     * @param {Uint8Array} flash  merged flash image (or a bare app image)
     * @param {number} [base]     offset of the app image; auto-detected if omitted
     */
    constructor(flash, base = null) {
        this.flash = flash instanceof Uint8Array ? flash : new Uint8Array(flash);
        this.base = base ?? EspImage.findApp(this.flash);
        if (this.base === null) throw new Error('no ESP app image found (magic 0xE9)');

        const v = new DataView(this.flash.buffer, this.flash.byteOffset, this.flash.byteLength);
        this.view = v;
        this.segmentCount = this.flash[this.base + 1];
        this.entry = v.getUint32(this.base + 4, true);
        this.chipId = v.getUint16(this.base + 12, true);
        this.hashAppended = this.flash[this.base + 23] === 1;
        this.segments = this.#readSegments();

        const last = this.segments[this.segments.length - 1];
        const end = last.dataOffset + last.length;
        // checksum byte sits at the end of the 16-byte block containing `end`
        this.checksumOffset = end + ((16 - ((end - this.base + 1) % 16)) % 16);
        this.hashOffset = this.hashAppended ? this.checksumOffset + 1 : null;
    }

    static findApp(flash) {
        for (const off of APP_OFFSET_CANDIDATES) {
            if (off + HDR_LEN < flash.length && flash[off] === MAGIC) {
                const segs = flash[off + 1];
                if (segs > 0 && segs <= 16) return off;
            }
        }
        return null;
    }

    #readSegments() {
        const segs = [];
        let o = this.base + HDR_LEN;
        for (let i = 0; i < this.segmentCount; i++) {
            const loadAddr = this.view.getUint32(o, true);
            const length = this.view.getUint32(o + 4, true);
            segs.push({ index: i, loadAddr, length, dataOffset: o + SEG_HDR_LEN });
            o += SEG_HDR_LEN + length;
        }
        return segs;
    }

    /** Map a guest virtual address to a byte offset in the flash image, or null. */
    vaddrToOffset(vaddr) {
        for (const s of this.segments) {
            if (vaddr >= s.loadAddr && vaddr < s.loadAddr + s.length) {
                return s.dataOffset + (vaddr - s.loadAddr);
            }
        }
        return null;
    }

    /** Write bytes at a guest virtual address. Throws if it does not land in a segment. */
    writeAtVaddr(vaddr, bytes) {
        const off = this.vaddrToOffset(vaddr);
        if (off === null) throw new Error(`vaddr 0x${vaddr.toString(16)} is not in any segment`);
        const seg = this.segments.find(s => vaddr >= s.loadAddr && vaddr < s.loadAddr + s.length);
        if (vaddr + bytes.length > seg.loadAddr + seg.length) {
            throw new Error(`write at 0x${vaddr.toString(16)} would run past segment ${seg.index}`);
        }
        this.flash.set(bytes, off);
        return off;
    }

    computeChecksum() {
        let ck = CHECKSUM_SEED;
        for (const s of this.segments) {
            for (let i = 0; i < s.length; i++) ck ^= this.flash[s.dataOffset + i];
        }
        return ck & 0xff;
    }

    storedChecksum() { return this.flash[this.checksumOffset]; }

    /** Recompute checksum and SHA256 in place. Call after any writeAtVaddr(). */
    async reseal() {
        this.flash[this.checksumOffset] = this.computeChecksum();
        if (!this.hashAppended) return;
        const body = this.flash.subarray(this.base, this.checksumOffset + 1);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
        this.flash.set(digest, this.hashOffset);
    }

    /** Verify the image as it currently stands. Used to validate format assumptions. */
    async verify() {
        const ckOk = this.storedChecksum() === this.computeChecksum();
        let hashOk = null;
        if (this.hashAppended) {
            const body = this.flash.subarray(this.base, this.checksumOffset + 1);
            const want = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
            const got = this.flash.subarray(this.hashOffset, this.hashOffset + 32);
            hashOk = want.every((b, i) => b === got[i]);
        }
        return { checksum: ckOk, sha256: hashOk };
    }
}
