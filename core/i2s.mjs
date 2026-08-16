// On-Chip I2S Digital Audio Controller for ESP32 RISC-V
// Receives 16-bit stereo/mono PCM streams and converts to normalized Float32 audio with RMS volume levels.

export class I2SController {
    constructor(sampleRate = 16000, channels = 2) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.currentVolume = 0;
        this._audioListeners = new Set();
    }

    /**
     * Listen for I2S audio PCM chunk arrivals.
     * @param {(data: { samples: Float32Array, sampleRate: number, channels: number, volume: number }) => void} callback
     */
    onAudio(callback) {
        this._audioListeners.add(callback);
        return () => this._audioListeners.delete(callback);
    }

    /**
     * Internal: Receive raw 16-bit signed PCM byte stream from guest firmware.
     * @param {number[] | Uint8Array} rawBytes
     */
    writePcm(rawBytes) {
        const u8 = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
        const numSamples = Math.floor(u8.length / 2);
        if (numSamples <= 0) return;

        const floatSamples = new Float32Array(numSamples);
        const dataView = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

        let sumSquares = 0;
        for (let i = 0; i < numSamples; i++) {
            const int16 = dataView.getInt16(i * 2, true); // Little endian
            const floatVal = int16 / 32768.0;
            floatSamples[i] = floatVal;
            sumSquares += floatVal * floatVal;
        }

        const rms = Math.sqrt(sumSquares / numSamples);
        this.currentVolume = Math.min(100, Math.round(rms * 100 * 2)); // Scaled volume %

        const payload = {
            samples: floatSamples,
            sampleRate: this.sampleRate,
            channels: this.channels,
            volume: this.currentVolume,
        };

        for (const listener of this._audioListeners) {
            try {
                listener(payload);
            } catch (err) {
                console.error('Error in I2S onAudio listener:', err);
            }
        }
    }
}
