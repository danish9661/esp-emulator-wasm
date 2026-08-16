// On-Chip SAR ADC Controller for ESP32 RISC-V (ADC1 Channels / Pins)
// Supports 12-bit analog sampling (0..4095) and millivolt conversion (0..3300 mV).

export class ADCController {
    constructor(referenceVoltage = 3.3, maxRaw = 4095) {
        this.refVoltage = referenceVoltage;
        this.maxRaw = maxRaw;
        this.voltages = new Map(); // pin -> voltage in volts
        this._sampleListeners = new Set();
    }

    /**
     * Set the simulated analog input voltage on a GPIO pin.
     * @param {number} pin - GPIO pin number (e.g. GPIO 0..5)
     * @param {number} voltage - Voltage in Volts (0.0 to 3.3V)
     */
    setVoltage(pin, voltage) {
        const clamped = Math.max(0.0, Math.min(this.refVoltage, voltage));
        this.voltages.set(pin, clamped);
    }

    /**
     * Set the raw 12-bit ADC value directly.
     * @param {number} pin - GPIO pin number
     * @param {number} raw - Raw integer (0..4095)
     */
    setRaw(pin, raw) {
        const clamped = Math.max(0, Math.min(this.maxRaw, raw));
        this.voltages.set(pin, (clamped / this.maxRaw) * this.refVoltage);
    }

    /**
     * Read the voltage set on a pin.
     * @param {number} pin
     * @returns {number}
     */
    getVoltage(pin) {
        return this.voltages.get(pin) || 0.0;
    }

    /**
     * Read the raw 12-bit integer sampled by the ADC (0..4095).
     * @param {number} pin
     * @returns {number}
     */
    readRaw(pin) {
        const v = this.getVoltage(pin);
        const raw = Math.round((v / this.refVoltage) * this.maxRaw);

        for (const listener of this._sampleListeners) {
            try {
                listener({ pin, raw, voltage: v, milliVolts: Math.round(v * 1000) });
            } catch (_) {}
        }

        return raw;
    }

    /**
     * Read the millivolt value sampled by the ADC (0..3300 mV).
     * @param {number} pin
     * @returns {number}
     */
    readMilliVolts(pin) {
        const v = this.getVoltage(pin);
        const mv = Math.round(v * 1000);

        for (const listener of this._sampleListeners) {
            try {
                listener({ pin, raw: Math.round((v / this.refVoltage) * this.maxRaw), voltage: v, milliVolts: mv });
            } catch (_) {}
        }

        return mv;
    }

    /**
     * Listen for ADC sampling events initiated by guest firmware.
     * @param {(sample: { pin: number, raw: number, voltage: number, milliVolts: number }) => void} callback
     */
    onSample(callback) {
        this._sampleListeners.add(callback);
        return () => this._sampleListeners.delete(callback);
    }
}
