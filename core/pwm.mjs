// On-Chip PWM / LEDC Controller for ESP32 RISC-V
// Tracks PWM duty cycles, channels, and percentage levels per pin.

export class PWMController {
    constructor() {
        this.duties = new Map(); // pin -> { duty, maxDuty, percent }
        this._updateListeners = new Set();
    }

    /**
     * Get the raw duty cycle for a pin.
     * @param {number} pin
     * @returns {number}
     */
    getDuty(pin) {
        const state = this.duties.get(pin);
        return state ? state.duty : 0;
    }

    /**
     * Get the percentage duty cycle (0.0 to 100.0%) for a pin.
     * @param {number} pin
     * @returns {number}
     */
    getPercent(pin) {
        const state = this.duties.get(pin);
        return state ? state.percent : 0.0;
    }

    /**
     * Internal: Update pin duty cycle from guest firmware PWM instruction.
     * @param {number} pin
     * @param {number} duty
     * @param {number} [maxDuty=255]
     */
    update(pin, duty, maxDuty = 255) {
        const percent = Math.min(100.0, Math.max(0.0, +(duty / maxDuty * 100).toFixed(1)));
        const state = { duty, maxDuty, percent };
        this.duties.set(pin, state);

        for (const listener of this._updateListeners) {
            try {
                listener({ pin, duty, maxDuty, percent });
            } catch (err) {
                console.error(`Error in PWM onUpdate listener for pin ${pin}:`, err);
            }
        }
    }

    /**
     * Listen for PWM / LEDC duty cycle changes.
     * @param {(event: { pin: number, duty: number, maxDuty: number, percent: number }) => void} callback
     */
    onUpdate(callback) {
        this._updateListeners.add(callback);
        return () => this._updateListeners.delete(callback);
    }
}
