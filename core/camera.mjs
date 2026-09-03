// Virtual camera controller (grayscale test-pattern frames).

export class CameraController {
    constructor() {
        this._frameListeners = new Set();
        this.frameCount = 0;
    }

    onFrame(callback) {
        this._frameListeners.add(callback);
        return () => this._frameListeners.delete(callback);
    }

    capture(w, h, fmt = 0) {
        w = Math.max(1, Math.min(320, w | 0));
        h = Math.max(1, Math.min(240, h | 0));
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const bar = ((x >> 3) & 1) ? 0x70 : 0x00;
                data[y * w + x] = (((x * 255) / Math.max(1, w - 1)) | 0) ^ bar ^ ((y * 31) & 0xff);
            }
        }
        this.frameCount++;
        for (const l of this._frameListeners) {
            try { l({ width: w, height: h, fmt, buffer: data.slice(), frame: this.frameCount }); } catch (_) {}
        }
        return data;
    }

    /**
     * Slice [offset, offset+len) of the canonical 96x96 grayscale frame.
     * Backs banded transfers (`emuCameraReadBand`).
     */
    readBand(offset, len, w = 96, h = 96) {
        const full = this.capture(w, h, 0);
        return full.subarray(offset >>> 0, Math.min(full.length, (offset >>> 0) + len));
    }
}
