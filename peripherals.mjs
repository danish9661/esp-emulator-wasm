// Virtual Peripheral Layer for esp-emu (I2C Bus, SPI Bus, SSD1306 OLED, ST7789 TFT, MPU6050)

export class I2CBus {
    constructor() {
        this.devices = new Map();
        this.activityListeners = new Set();
    }

    register(addr, device) {
        this.devices.set(addr & 0x7f, device);
        device.bus = this;
        device.address = addr & 0x7f;
    }

    unregister(addr) {
        this.devices.delete(addr & 0x7f);
    }

    onActivity(listener) {
        this.activityListeners.add(listener);
        return () => this.activityListeners.delete(listener);
    }

    #emit(type, addr, data) {
        for (const listener of this.activityListeners) {
            try {
                listener({ type, addr, data, timestamp: Date.now() });
            } catch (e) {
                console.error('I2C activity listener error:', e);
            }
        }
    }

    write(addr, data) {
        const address = addr & 0x7f;
        this.#emit('write', address, data);
        const dev = this.devices.get(address);
        if (dev && typeof dev.onWrite === 'function') {
            return dev.onWrite(data);
        }
        return false;
    }

    read(addr, length) {
        const address = addr & 0x7f;
        let response = [];
        const dev = this.devices.get(address);
        if (dev && typeof dev.onRead === 'function') {
            response = dev.onRead(length);
        } else {
            response = new Array(length).fill(0xff);
        }
        this.#emit('read', address, response);
        return response;
    }
}

/**
 * Virtual SPI Bus (AGENT.md Phase 4).
 */
export class SPIBus {
    constructor() {
        this.devices = new Map();
        this.defaultDevice = new GenericSPIDevice();
        this.activityListeners = new Set();
    }

    register(csPin, device) {
        this.devices.set(csPin, device);
        device.bus = this;
    }

    onActivity(listener) {
        this.activityListeners.add(listener);
        return () => this.activityListeners.delete(listener);
    }

    #emit(type, data, reply) {
        for (const listener of this.activityListeners) {
            try {
                listener({ type, data, reply, timestamp: Date.now() });
            } catch (e) {
                console.error('SPI activity listener error:', e);
            }
        }
    }

    transferByte(data) {
        const dev = this.devices.size > 0 ? this.devices.values().next().value : this.defaultDevice;
        const reply = dev ? dev.onTransferByte(data) : 0x00;
        this.#emit('byte', [data], [reply]);
        return reply & 0xff;
    }

    write(bytes) {
        const dev = this.devices.size > 0 ? this.devices.values().next().value : this.defaultDevice;
        if (dev && typeof dev.onWrite === 'function') {
            dev.onWrite(bytes);
        }
        this.#emit('write', bytes, []);
    }
}

export class GenericSPIDevice {
    constructor() {
        this.rxCount = 0;
    }

    onTransferByte(b) {
        this.rxCount++;
        // Return complementary or echo response
        return (b ^ 0x55) & 0xff;
    }

    onWrite(bytes) {
        this.rxCount += bytes.length;
    }
}

/**
 * Emulates the SSD1306 128x64 / 128x32 Monochrome OLED Display Controller.
 */
export class SSD1306Device {
    constructor(width = 128, height = 64) {
        this.width = width;
        this.height = height;
        this.pages = Math.ceil(height / 8);
        this.buffer = new Uint8Array(this.width * this.pages); // 1024 bytes for 128x64

        this.colStart = 0;
        this.colEnd = width - 1;
        this.pageStart = 0;
        this.pageEnd = this.pages - 1;
        this.colPtr = 0;
        this.pagePtr = 0;
        this.addressingMode = 0;

        this.displayOn = false;
        this.inverted = false;
        this.contrast = 0x7f;

        this.cmdQueue = [];
        this.onFrameCallback = null;
        this.dirty = false;
    }

    onFrame(cb) {
        this.onFrameCallback = cb;
    }

    notifyFrame() {
        if (this.onFrameCallback) {
            this.onFrameCallback({
                width: this.width,
                height: this.height,
                buffer: this.buffer.slice(),
                inverted: this.inverted,
                displayOn: this.displayOn,
            });
        }
        this.dirty = false;
    }

    onWrite(bytes) {
        if (!bytes || bytes.length === 0) return true;

        let i = 0;
        while (i < bytes.length) {
            const ctrl = bytes[i++];
            if (i >= bytes.length) break;

            const isData = (ctrl & 0x40) !== 0;
            const isContinuation = (ctrl & 0x80) === 0;

            if (isData) {
                const chunk = isContinuation ? [bytes[i++]] : bytes.slice(i);
                if (!isContinuation) i = bytes.length;

                for (const b of chunk) {
                    this.#writeDataByte(b);
                }
                this.dirty = true;
            } else {
                const cmd = bytes[i++];
                this.#processCommand(cmd);
            }
        }

        if (this.dirty) {
            this.notifyFrame();
        }
        return true;
    }

    #writeDataByte(byte) {
        const offset = this.pagePtr * this.width + this.colPtr;
        if (offset < this.buffer.length) {
            this.buffer[offset] = byte;
        }

        if (this.addressingMode === 0) {
            this.colPtr++;
            if (this.colPtr > this.colEnd) {
                this.colPtr = this.colStart;
                this.pagePtr++;
                if (this.pagePtr > this.pageEnd) {
                    this.pagePtr = this.pageStart;
                }
            }
        } else if (this.addressingMode === 1) {
            this.pagePtr++;
            if (this.pagePtr > this.pageEnd) {
                this.pagePtr = this.pageStart;
                this.colPtr++;
                if (this.colPtr > this.colEnd) {
                    this.colPtr = this.colStart;
                }
            }
        } else {
            this.colPtr++;
            if (this.colPtr > this.colEnd) {
                this.colPtr = this.colStart;
            }
        }
    }

    #processCommand(cmd) {
        if (this.cmdQueue.length > 0) {
            const pending = this.cmdQueue.shift();
            pending(cmd);
            return;
        }

        if (cmd === 0x20) {
            this.cmdQueue.push((val) => { this.addressingMode = val & 0x03; });
        } else if (cmd === 0x21) {
            this.cmdQueue.push((start) => {
                this.cmdQueue.push((end) => {
                    this.colStart = Math.min(start, this.width - 1);
                    this.colEnd = Math.min(end, this.width - 1);
                    this.colPtr = this.colStart;
                });
            });
        } else if (cmd === 0x22) {
            this.cmdQueue.push((start) => {
                this.cmdQueue.push((end) => {
                    this.pageStart = Math.min(start, this.pages - 1);
                    this.pageEnd = Math.min(end, this.pages - 1);
                    this.pagePtr = this.pageStart;
                });
            });
        } else if (cmd >= 0xb0 && cmd <= 0xb7) {
            this.pagePtr = Math.min(cmd & 0x07, this.pages - 1);
        } else if ((cmd & 0xf0) === 0x00) {
            this.colPtr = (this.colPtr & 0xf0) | (cmd & 0x0f);
        } else if ((cmd & 0xf0) === 0x10) {
            this.colPtr = (this.colPtr & 0x0f) | ((cmd & 0x0f) << 4);
        } else if (cmd === 0x81) {
            this.cmdQueue.push((val) => { this.contrast = val; });
        } else if (cmd === 0xa6) {
            this.inverted = false;
        } else if (cmd === 0xa7) {
            this.inverted = true;
        } else if (cmd === 0xae) {
            this.displayOn = false;
        } else if (cmd === 0xaf) {
            this.displayOn = true;
            this.dirty = true;
        } else if (cmd === 0x8d || cmd === 0xd5 || cmd === 0xd9 || cmd === 0xda || cmd === 0xdb || cmd === 0xd3) {
            this.cmdQueue.push(() => {});
        }
    }

    onRead(length) {
        return new Array(length).fill(0x00);
    }
}

/**
 * Emulates MPU6050 IMU / Generic Sensor Device (Address 0x68).
 */
export class MPU6050Device {
    constructor() {
        this.regPointer = 0;
        this.regs = new Uint8Array(128);
        this.regs[0x75] = 0x68; // WHO_AM_I default

        this.regs[0x3f] = 0x40; // Accel Z
        this.regs[0x40] = 0x00;
        this.regs[0x41] = 0x09; // Temp
        this.regs[0x42] = 0x80;

        this.defaultRawBytes = [0xde, 0xad, 0xbe, 0xca, 0xfe, 0x01];
    }

    onWrite(bytes) {
        if (!bytes || bytes.length === 0) return true;
        this.regPointer = bytes[0] & 0x7f;
        for (let i = 1; i < bytes.length; i++) {
            const reg = (this.regPointer + i - 1) & 0x7f;
            this.regs[reg] = bytes[i];
        }
        return true;
    }

    onRead(length) {
        const out = [];
        for (let i = 0; i < length; i++) {
            if (this.regPointer < this.regs.length) {
                const b = this.regs[this.regPointer] || this.defaultRawBytes[i % this.defaultRawBytes.length];
                out.push(b);
                this.regPointer = (this.regPointer + 1) & 0x7f;
            } else {
                out.push(this.defaultRawBytes[i % this.defaultRawBytes.length]);
            }
        }
        return out;
    }
}
