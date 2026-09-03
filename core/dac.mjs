// Virtual DAC output controller (Arduino `dacWrite` API, 8-bit 0..255).

export class DACController {
    constructor(referenceVoltage = 3.3) {
        this.refVoltage = referenceVoltage;
        this.channels = new Map();
        this._listeners = new Set();
    }

    onActivity(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    write(pin, value) {
        const v = Math.max(0, Math.min(255, value | 0));
        const voltage = (v / 255) * this.refVoltage;
        this.channels.set(pin, { value: v, voltage });
        for (const l of this._listeners) {
            try { l({ type: 'dac_update', pin, value: v, voltage, timestamp: Date.now() }); } catch (_) {}
        }
        return true;
    }

    getChannel(pin) {
        return this.channels.get(pin) || { value: 0, voltage: 0 };
    }
}
