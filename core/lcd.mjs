// Virtual MIPI-DSI / parallel LCD panel controller (RGB565 bitmap blits).

export class LCDController {
    constructor(width = 240, height = 240) {
        this.width = width;
        this.height = height;
        this.rgbaBuffer = new Uint8Array(width * height * 4);
        this._frameListeners = new Set();
        this.drawCount = 0;
        for (let i = 3; i < this.rgbaBuffer.length; i += 4) this.rgbaBuffer[i] = 255;
    }

    onFrame(callback) {
        this._frameListeners.add(callback);
        return () => this._frameListeners.delete(callback);
    }

    drawBitmap(x1, y1, x2, y2, rgb565Bytes) {
        // Little-endian guest-memory order (see VirtualLcdPanel).
        x1 = Math.max(0, Math.min(this.width - 1, x1 | 0));
        y1 = Math.max(0, Math.min(this.height - 1, y1 | 0));
        x2 = Math.max(x1, Math.min(this.width - 1, x2 | 0));
        y2 = Math.max(y1, Math.min(this.height - 1, y2 | 0));
        const px = rgb565Bytes instanceof Uint8Array ? rgb565Bytes : Uint8Array.from(rgb565Bytes || []);
        let p = 0;
        for (let y = y1; y <= y2 && p + 1 < px.length; y++) {
            for (let x = x1; x <= x2 && p + 1 < px.length; x++) {
                const c = (px[p + 1] << 8) | px[p];
                p += 2;
                const idx = (y * this.width + x) * 4;
                this.rgbaBuffer[idx] = Math.round((((c >> 11) & 0x1f) * 255) / 31);
                this.rgbaBuffer[idx + 1] = Math.round((((c >> 5) & 0x3f) * 255) / 63);
                this.rgbaBuffer[idx + 2] = Math.round((((c) & 0x1f) * 255) / 31);
                this.rgbaBuffer[idx + 3] = 255;
            }
        }
        this.drawCount++;
        for (const l of this._frameListeners) {
            try {
                l({ width: this.width, height: this.height, buffer: this.rgbaBuffer.slice(), draws: this.drawCount });
            } catch (_) {}
        }
        return { x1, y1, x2, y2, draws: this.drawCount };
    }
}
