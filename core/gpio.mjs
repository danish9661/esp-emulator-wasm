// On-Chip GPIO Controller for ESP32 RISC-V (per-chip pin count)
// Provides per-pin listeners, direction detection, input injection,
// and dynamic memory auto-calibration inside WASM linear memory.
//
// Pin counts are per-chip (datasheet + app.js CHIP_GPIO_COUNT):
// esp32c3: 22, esp32c6: 30, esp32h2: 19, esp32c5: 29, esp32p4: 56,
// esp32s31: 60. The controller models the low 32 mask bits; pins above 31
// are accepted by the API (pin()/setInput()/listeners) but only contribute
// to the raw masks until the core exposes wider GPIO words. Always construct
// via ESP32C3 (which passes the chip) — never `new GPIOController()` bare
// for a non-C3 target.

export class GPIOPin {
    constructor(pinNumber, controller) {
        this.pin = pinNumber;
        this._controller = controller;
        this.value = false;
        this.isOutput = false;
        this._listeners = new Set();
    }

    /**
     * Add a listener callback invoked when the pin state changes.
     * @param {(level: boolean, isOutput: boolean) => void} callback
     */
    addListener(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    removeListener(callback) {
        this._listeners.delete(callback);
    }

    /**
     * Set the input voltage level (for external buttons, sensors, pull-ups).
     * @param {boolean | number} level - true/1 (HIGH) or false/0 (LOW)
     */
    setInput(level) {
        this._controller.setInput(this.pin, Boolean(level));
    }

    _notify(level, isOutput) {
        this.value = level;
        this.isOutput = isOutput;
        for (const listener of this._listeners) {
            try {
                listener(level, isOutput);
            } catch (err) {
                console.error(`Error in GPIOPin ${this.pin} listener:`, err);
            }
        }
    }
}

export const CHIP_GPIO_COUNT = {
    esp32c3: 22,
    esp32c6: 30,
    esp32h2: 19,
    esp32c5: 29,
    esp32p4: 56,
    esp32s31: 60,
};

export class GPIOController {
    constructor(chip = 'esp32c3') {
        this.chip = chip;
        this.pinCount = CHIP_GPIO_COUNT[chip] || 22;
        this.pins = Array.from({ length: this.pinCount }, (_, i) => new GPIOPin(i, this));
        this._inputMask = 0;
        this._lastOutMask = -1;
        this._lastEnableMask = -1;
        this._gpioOutAddr = null;
        this._gpioEnableAddr = null;
        this._gpioInAddr = null;
        this._memory = null;
        this._listeners = new Set();
    }

    /**
     * Bind the WASM linear memory for hardware register reads/writes.
     * @param {WebAssembly.Memory} memory
     */
    bindMemory(memory) {
        this._memory = memory;
    }

    /**
     * Access a specific pin (0..pinCount-1).
     * @param {number} pinNumber
     * @returns {GPIOPin|undefined} undefined when out of range for this chip
     */
    pin(pinNumber) {
        return this.pins[pinNumber];
    }

    /**
     * Set the digital input state for a pin.
     * @param {number} pin - GPIO pin number (0..pinCount-1)
     * @param {boolean | number} level - true/1 (HIGH) or false/0 (LOW)
     */
    setInput(pin, level) {
        if (pin < 0 || pin >= this.pinCount) return;
        const bit = 1 << pin;
        if (level) {
            this._inputMask |= bit;
        } else {
            this._inputMask &= ~bit;
        }

        // If in-memory register is discovered, write immediately
        if (this._memory && this._gpioInAddr !== null) {
            try {
                const u32 = new Uint32Array(this._memory.buffer);
                u32[this._gpioInAddr >> 2] = this._inputMask;
            } catch (_) {}
        }

        // Notify pin listener if not currently driven as output
        if (!this.pins[pin].isOutput) {
            this.pins[pin]._notify(Boolean(level), false);
        }
    }

    /**
     * Read the current digital level of a pin.
     * @param {number} pin
     * @returns {boolean}
     */
    getPinLevel(pin) {
        if (pin < 0 || pin >= this.pinCount) return false;
        return this.pins[pin].value;
    }

    /**
     * Check if a pin is configured as output.
     * @param {number} pin
     * @returns {boolean}
     */
    isOutput(pin) {
        if (pin < 0 || pin >= this.pinCount) return false;
        return this.pins[pin].isOutput;
    }

    /**
     * Add a global listener for any GPIO activity.
     * @param {(outMask: number, enableMask: number) => void} callback
     */
    onActivity(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    /**
     * Seed register addresses from an out-of-band probe (see
     * spike/gpio_probe.mjs). Overrides the zero-pattern heuristic: required
     * for firmwares that keep UART0 TX output-enabled (the ENABLE word is
     * then never all-zero, so the heuristic can never match the true base
     * and latches onto garbage). Arduino suites keep the heuristic path.
     */
    setBaseAddrs({ out, enable, input }) {
        this._gpioOutAddr = out;
        this._gpioEnableAddr = enable;
        this._gpioInAddr = input;
        this._lastOutMask = -1;
        this._lastEnableMask = -1;
    }

    /**
     * Synchronize and auto-calibrate GPIO register states from WASM linear memory.
     */
    sync() {
        if (!this._memory) return;
        const u32 = new Uint32Array(this._memory.buffer);

        // Dynamic auto-calibration for register offsets
        if (this._gpioOutAddr === null) {
            this._autoCalibrate(u32);
            if (this._gpioOutAddr === null) return;
        }

        const outMask = u32[this._gpioOutAddr >> 2];
        const enableMask = u32[this._gpioEnableAddr >> 2];

        // Maintain simulated input state in GPIO_IN register
        if (this._gpioInAddr !== null) {
            u32[this._gpioInAddr >> 2] = (outMask & enableMask) | (this._inputMask & ~enableMask);
        }

        if (outMask !== this._lastOutMask || enableMask !== this._lastEnableMask) {
            this._lastOutMask = outMask;
            this._lastEnableMask = enableMask;

            for (let i = 0; i < this.pinCount; i++) {
                const isOut = ((enableMask >> i) & 1) === 1;
                const level = isOut ? ((outMask >> i) & 1) === 1 : ((this._inputMask >> i) & 1) === 1;
                if (this.pins[i].value !== level || this.pins[i].isOutput !== isOut) {
                    this.pins[i]._notify(level, isOut);
                }
            }

            for (const listener of this._listeners) {
                try {
                    listener(outMask, enableMask);
                } catch (err) {
                    console.error('Error in GPIOController activity listener:', err);
                }
            }
        }
    }

    _autoCalibrate(u32) {
        // Known base address range for esp-emulator GPIO peripheral
        for (let i = 0x820000 >> 2; i < 0x830000 >> 2; i++) {
            // Pattern check: GPIO_OUT (offset 0x04), GPIO_ENABLE (offset 0x20), GPIO_IN (offset 0x3C)
            if (u32[i] === 0 && u32[i + 7] === 0) {
                this._gpioOutAddr = (i + 1) << 2;
                this._gpioEnableAddr = (i + 8) << 2;
                this._gpioInAddr = (i + 15) << 2;
                break;
            }
        }
        if (this._gpioOutAddr === null) {
            // Fallback default offsets
            this._gpioOutAddr = 0x827854;
            this._gpioEnableAddr = 0x827870;
            this._gpioInAddr = 0x82788c;
        }
    }
}
