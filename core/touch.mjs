// Virtual capacitive touch pad controller (Arduino `touchRead` API).

export class TouchController {
    constructor(touchedValue = 300, releasedValue = 1200) {
        this.touchedValue = touchedValue;
        this.releasedValue = releasedValue;
        this.touched = new Map();
        this.thresholds = new Map();
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

    setTouched(pin, touched) {
        const was = this.touched.get(pin) || false;
        this.touched.set(pin, !!touched);
        if (!!touched !== was) {
            this.#emit('touch_event', { pin, touched: !!touched, raw: this.getRaw(pin) });
        }
    }

    attachInterrupt(pin, threshold) {
        this.thresholds.set(pin, threshold);
        this.#emit('attach', { pin, threshold });
    }

    detachInterrupt(pin) {
        this.thresholds.delete(pin);
        this.#emit('detach', { pin });
    }

    getRaw(pin) {
        return this.touched.get(pin) ? this.touchedValue : this.releasedValue;
    }

    read(pin) {
        const raw = this.getRaw(pin);
        this.#emit('read', { pin, raw, touched: !!this.touched.get(pin) });
        return raw;
    }
}
