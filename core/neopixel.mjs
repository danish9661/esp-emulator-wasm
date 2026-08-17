// On-Chip NeoPixel / WS2812 RMT Controller for ESP32 RISC-V
// Tracks the latest RGB pixel frame per pin.

export class NeoPixelController {
    constructor() {
        this.frames = new Map(); // pin -> { pixels: [{r,g,b}], bytes: number[] }
        this._frameListeners = new Set();
    }

    /**
     * Get the latest RGB pixel frame for a pin (GRB order).
     * @param {number} pin
     * @returns {{ pixels: {r: number, g: number, b: number}[], bytes: number[] } | undefined}
     */
    getFrame(pin) {
        return this.frames.get(pin);
    }

    /**
     * Internal: Update the pixel frame from guest firmware RMT instruction.
     * @param {number} pin
     * @param {number[]} rawBytes - GRB byte stream
     */
    update(pin, rawBytes) {
        const pixels = [];
        for (let i = 0; i + 2 < rawBytes.length; i += 3) {
            pixels.push({ g: rawBytes[i], r: rawBytes[i + 1], b: rawBytes[i + 2] });
        }
        const frame = { pixels, bytes: rawBytes };
        this.frames.set(pin, frame);

        for (const listener of this._frameListeners) {
            try {
                listener({ pin, pixels, bytes: rawBytes });
            } catch (err) {
                console.error(`Error in NeoPixel onFrame listener for pin ${pin}:`, err);
            }
        }
    }

    /**
     * Listen for NeoPixel frame updates.
     * @param {(event: { pin: number, pixels: {r: number, g: number, b: number}[], bytes: number[] }) => void} callback
     */
    onFrame(callback) {
        this._frameListeners.add(callback);
        return () => this._frameListeners.delete(callback);
    }
}