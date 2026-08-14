// Virtual Peripheral Layer for esp-emu (I2C Bus, SPI Bus, NeoPixel Strip, SSD1306 OLED, ST7789 Color TFT, MPU6050)

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
 * Virtual SPI Bus with multi-device and display dispatch.
 */
export class SPIBus {
    constructor() {
        this.devices = new Map();
        this.defaultDevice = new GenericSPIDevice();
        this.activityListeners = new Set();
    }

    register(name, device) {
        this.devices.set(name, device);
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
        let reply = 0x00;
        for (const dev of this.devices.values()) {
            if (typeof dev.onTransferByte === 'function') {
                reply = dev.onTransferByte(data);
            }
        }
        if (this.devices.size === 0) {
            reply = this.defaultDevice.onTransferByte(data);
        }
        this.#emit('byte', [data], [reply]);
        return reply & 0xff;
    }

    write(bytes) {
        for (const dev of this.devices.values()) {
            if (typeof dev.onWrite === 'function') {
                dev.onWrite(bytes);
            }
        }
        if (this.devices.size === 0) {
            this.defaultDevice.onWrite(bytes);
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
        return (b ^ 0x55) & 0xff;
    }

    onWrite(bytes) {
        this.rxCount += bytes.length;
    }
}

/**
 * Virtual WS2812 / NeoPixel RGB LED Strip
 */
export class NeoPixelStrip {
    constructor(numPixels = 8) {
        this.numPixels = numPixels;
        this.pixels = Array.from({ length: numPixels }, () => ({ r: 0, g: 0, b: 0 }));
        this.onFrameCallback = null;
    }

    onFrame(cb) {
        this.onFrameCallback = cb;
    }

    update(pin, rawBytes, isGrb = true) {
        for (let i = 0; i < this.numPixels; i++) {
            const offset = i * 3;
            if (offset + 2 < rawBytes.length) {
                if (isGrb) {
                    this.pixels[i] = {
                        g: rawBytes[offset],
                        r: rawBytes[offset + 1],
                        b: rawBytes[offset + 2],
                    };
                } else {
                    this.pixels[i] = {
                        r: rawBytes[offset],
                        g: rawBytes[offset + 1],
                        b: rawBytes[offset + 2],
                    };
                }
            }
        }
        if (this.onFrameCallback) {
            this.onFrameCallback({
                pin,
                pixels: this.pixels.map(p => ({ ...p })),
            });
        }
    }
}

/**
 * Emulates the ST7789 240x240 16-bit RGB565 Color TFT Display Controller.
 */
export class ST7789Device {
    constructor(width = 240, height = 240) {
        this.width = width;
        this.height = height;
        this.rgbaBuffer = new Uint8Array(width * height * 4);

        this.colStart = 0;
        this.colEnd = width - 1;
        this.rowStart = 0;
        this.rowEnd = height - 1;
        this.colPtr = 0;
        this.rowPtr = 0;

        this.displayOn = false;
        this.curCommand = 0;
        this.paramQueue = [];
        this.inRamWrite = false;
        this.highByte = null;

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
                buffer: this.rgbaBuffer.slice(),
                displayOn: this.displayOn,
            });
        }
        this.dirty = false;
    }

    onTransferByte(b) {
        this.#processByte(b);
        return 0x00;
    }

    onWrite(bytes) {
        if (!bytes || bytes.length === 0) return;
        for (let i = 0; i < bytes.length; i++) {
            this.#processByte(bytes[i]);
        }
        if (this.dirty) {
            this.notifyFrame();
        }
    }

    #processByte(b) {
        if (this.paramQueue.length > 0) {
            const handler = this.paramQueue.shift();
            handler(b);
            return;
        }

        if (this.inRamWrite) {
            if (this.highByte === null) {
                this.highByte = b;
            } else {
                const rgb565 = (this.highByte << 8) | b;
                this.highByte = null;
                this.#writePixelRgb565(rgb565);
                this.dirty = true;
            }
            return;
        }

        // Parse commands
        if (b === 0x01) {
            this.inRamWrite = false;
            this.highByte = null;
        } else if (b === 0x11) {
            this.inRamWrite = false;
        } else if (b === 0x29) {
            this.displayOn = true;
            this.inRamWrite = false;
            this.dirty = true;
            this.notifyFrame();
        } else if (b === 0x28) {
            this.displayOn = false;
            this.inRamWrite = false;
        } else if (b === 0x2a) {
            this.inRamWrite = false;
            this.paramQueue.push((x0h) => {
                this.paramQueue.push((x0l) => {
                    this.paramQueue.push((x1h) => {
                        this.paramQueue.push((x1l) => {
                            this.colStart = Math.min((x0h << 8) | x0l, this.width - 1);
                            this.colEnd = Math.min((x1h << 8) | x1l, this.width - 1);
                            this.colPtr = this.colStart;
                        });
                    });
                });
            });
        } else if (b === 0x2b) {
            this.inRamWrite = false;
            this.paramQueue.push((y0h) => {
                this.paramQueue.push((y0l) => {
                    this.paramQueue.push((y1h) => {
                        this.paramQueue.push((y1l) => {
                            this.rowStart = Math.min((y0h << 8) | y0l, this.height - 1);
                            this.rowEnd = Math.min((y1h << 8) | y1l, this.height - 1);
                            this.rowPtr = this.rowStart;
                        });
                    });
                });
            });
        } else if (b === 0x2c) {
            this.inRamWrite = true;
            this.highByte = null;
            this.colPtr = this.colStart;
            this.rowPtr = this.rowStart;
        } else if (b === 0x36 || b === 0x3a) {
            this.inRamWrite = false;
            this.paramQueue.push(() => {});
        }
    }

    #writePixelRgb565(c) {
        if (this.rowPtr < this.height && this.colPtr < this.width) {
            const idx = (this.rowPtr * this.width + this.colPtr) * 4;
            const r5 = (c >> 11) & 0x1f;
            const g6 = (c >> 5) & 0x3f;
            const b5 = c & 0x1f;

            this.rgbaBuffer[idx] = Math.round((r5 * 255) / 31);
            this.rgbaBuffer[idx + 1] = Math.round((g6 * 255) / 63);
            this.rgbaBuffer[idx + 2] = Math.round((b5 * 255) / 31);
            this.rgbaBuffer[idx + 3] = 255;
        }

        this.colPtr++;
        if (this.colPtr > this.colEnd) {
            this.colPtr = this.colStart;
            this.rowPtr++;
            if (this.rowPtr > this.rowEnd) {
                this.rowPtr = this.rowStart;
            }
        }
    }
}

/**
 * Emulates the SSD1306 128x64 Monochrome OLED Display Controller.
 */
export class SSD1306Device {
    constructor(width = 128, height = 64) {
        this.width = width;
        this.height = height;
        this.pages = Math.ceil(height / 8);
        this.buffer = new Uint8Array(this.width * this.pages);

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
        this.regs[0x75] = 0x68;

        this.regs[0x3f] = 0x40;
        this.regs[0x40] = 0x00;
        this.regs[0x41] = 0x09;
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
