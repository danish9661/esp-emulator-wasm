// Virtual Peripheral Layer for esp-emu (I2C Bus, SSD1306 OLED, MPU6050 / Sensors)

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
            // Default response: ACK with 0xFF or 0x00 for unmapped devices
            response = new Array(length).fill(0xff);
        }
        this.#emit('read', address, response);
        return response;
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
        this.addressingMode = 0; // 0 = Horizontal, 1 = Vertical, 2 = Page

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
                // All remaining bytes or single byte are display RAM data
                const chunk = isContinuation ? [bytes[i++]] : bytes.slice(i);
                if (!isContinuation) i = bytes.length;

                for (const b of chunk) {
                    this.#writeDataByte(b);
                }
                this.dirty = true;
            } else {
                // Command byte
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
            // Horizontal addressing mode
            this.colPtr++;
            if (this.colPtr > this.colEnd) {
                this.colPtr = this.colStart;
                this.pagePtr++;
                if (this.pagePtr > this.pageEnd) {
                    this.pagePtr = this.pageStart;
                }
            }
        } else if (this.addressingMode === 1) {
            // Vertical addressing mode
            this.pagePtr++;
            if (this.pagePtr > this.pageEnd) {
                this.pagePtr = this.pageStart;
                this.colPtr++;
                if (this.colPtr > this.colEnd) {
                    this.colPtr = this.colStart;
                }
            }
        } else {
            // Page addressing mode
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
            // Set Memory Addressing Mode (next byte: 0, 1, or 2)
            this.cmdQueue.push((val) => { this.addressingMode = val & 0x03; });
        } else if (cmd === 0x21) {
            // Set Column Address (next 2 bytes: start, end)
            this.cmdQueue.push((start) => {
                this.cmdQueue.push((end) => {
                    this.colStart = Math.min(start, this.width - 1);
                    this.colEnd = Math.min(end, this.width - 1);
                    this.colPtr = this.colStart;
                });
            });
        } else if (cmd === 0x22) {
            // Set Page Address (next 2 bytes: start, end)
            this.cmdQueue.push((start) => {
                this.cmdQueue.push((end) => {
                    this.pageStart = Math.min(start, this.pages - 1);
                    this.pageEnd = Math.min(end, this.pages - 1);
                    this.pagePtr = this.pageStart;
                });
            });
        } else if (cmd >= 0xb0 && cmd <= 0xb7) {
            // Set Page Start Address for Page Addressing Mode
            this.pagePtr = Math.min(cmd & 0x07, this.pages - 1);
        } else if ((cmd & 0xf0) === 0x00) {
            // Set Lower Column Start Address (0x00-0x0F)
            this.colPtr = (this.colPtr & 0xf0) | (cmd & 0x0f);
        } else if ((cmd & 0xf0) === 0x10) {
            // Set Higher Column Start Address (0x10-0x1F)
            this.colPtr = (this.colPtr & 0x0f) | ((cmd & 0x0f) << 4);
        } else if (cmd === 0x81) {
            // Set Contrast Control (next byte: 0-255)
            this.cmdQueue.push((val) => { this.contrast = val; });
        } else if (cmd === 0xa6) {
            // Normal display
            this.inverted = false;
        } else if (cmd === 0xa7) {
            // Inverted display
            this.inverted = true;
        } else if (cmd === 0xae) {
            // Display OFF
            this.displayOn = false;
        } else if (cmd === 0xaf) {
            // Display ON
            this.displayOn = true;
            this.dirty = true;
        } else if (cmd === 0x8d || cmd === 0xd5 || cmd === 0xd9 || cmd === 0xda || cmd === 0xdb || cmd === 0xd3) {
            // Multi-byte hardware configuration commands — skip their next parameter byte
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

        // Default mock sensor reading (Acc X=0, Y=0, Z=1g (~16384), Temp=25C, Gyro=0)
        // 0x3B: Accel X (H, L) = 0x00, 0x00
        // 0x3D: Accel Y (H, L) = 0x00, 0x00
        // 0x3F: Accel Z (H, L) = 0x40, 0x00 (16384)
        // 0x41: Temp (H, L)    = 0x09, 0x80 (25.0 C)
        // 0x43: Gyro X (H, L)  = 0x00, 0x00
        // 0x45: Gyro Y (H, L)  = 0x00, 0x00
        // 0x47: Gyro Z (H, L)  = 0x00, 0x00
        this.regs[0x3f] = 0x40;
        this.regs[0x40] = 0x00;
        this.regs[0x41] = 0x09;
        this.regs[0x42] = 0x80;

        // Custom default mock stream for bare requestFrom(0x68, 3) (matching AGENT.md)
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
                // If register hasn't been set by write yet, fall back to defaultRawBytes
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
