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
        if (this.dirty) {
            this.notifyFrame();
        }
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

/**
 * Calculates CCITT CRC-16 checksum (polynomial 0x1021, initial 0x0000) for SD Card CSD and sector data.
 */
export function calcCrc16(data) {
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
        crc = (crc ^ (data[i] << 8)) & 0xFFFF;
        for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            else crc = (crc << 1) & 0xFFFF;
        }
    }
    return crc;
}

/**
 * Generates a valid 1MB FAT16 filesystem image with MBR, VBR, FAT tables, and /README.TXT.
 */
export function createDefaultFat16Image() {
    const SECTOR_SIZE = 512;
    const TOTAL_SECTORS = 2048; // 1MB
    const SECTORS_PER_CLUSTER = 1;
    const RESERVED_SECTORS = 1;
    const FAT_COPIES = 2;
    const ROOT_DIR_ENTRIES = 512;
    const FAT_SIZE_SECTORS = 16;

    const disk = new Uint8Array(TOTAL_SECTORS * SECTOR_SIZE);
    const view = new DataView(disk.buffer);

    // VBR (Sector 0)
    disk[0] = 0xeb; disk[1] = 0x3c; disk[2] = 0x90;
    const oem = new TextEncoder().encode('MSDOS5.0');
    disk.set(oem, 3);
    view.setUint16(11, SECTOR_SIZE, true);
    disk[13] = SECTORS_PER_CLUSTER;
    view.setUint16(14, RESERVED_SECTORS, true);
    disk[16] = FAT_COPIES;
    view.setUint16(17, ROOT_DIR_ENTRIES, true);
    view.setUint16(19, TOTAL_SECTORS, true);
    disk[21] = 0xF8;
    view.setUint16(22, FAT_SIZE_SECTORS, true);
    view.setUint16(24, 63, true);
    view.setUint16(26, 255, true);
    disk[36] = 0x80;
    disk[38] = 0x29;
    view.setUint32(39, 0x12345678, true);
    const label = new TextEncoder().encode('NO NAME    ');
    disk.set(label, 43);
    const fstype = new TextEncoder().encode('FAT16   ');
    disk.set(fstype, 54);
    disk[510] = 0x55; disk[511] = 0xaa;

    // FAT1 & FAT2
    const fat1Off = RESERVED_SECTORS * SECTOR_SIZE;
    const fat2Off = (RESERVED_SECTORS + FAT_SIZE_SECTORS) * SECTOR_SIZE;
    view.setUint16(fat1Off, 0xFFF8, true);
    view.setUint16(fat1Off + 2, 0xFFFF, true);
    view.setUint16(fat1Off + 4, 0xFFFF, true); // Cluster 2 EOF
    view.setUint16(fat2Off, 0xFFF8, true);
    view.setUint16(fat2Off + 2, 0xFFFF, true);
    view.setUint16(fat2Off + 4, 0xFFFF, true);

    // Root Directory
    const rootDirOff = (RESERVED_SECTORS + FAT_COPIES * FAT_SIZE_SECTORS) * SECTOR_SIZE;
    const readmeContent = new TextEncoder().encode('Hello from Virtual SD Card!\n\nThis is a virtual FAT16 disk mounted on SPI bus.\n');
    
    // Entry for README.TXT (8s 3s B B B H H H H H H H I)
    const name = new TextEncoder().encode('README  TXT');
    disk.set(name, rootDirOff);
    disk[rootDirOff + 11] = 0x20; // Archive
    view.setUint16(rootDirOff + 26, 2, true); // Cluster 2
    view.setUint32(rootDirOff + 28, readmeContent.length, true); // Size

    // Cluster 2 Data (Sector 65)
    const cluster2Sector = RESERVED_SECTORS + FAT_COPIES * FAT_SIZE_SECTORS + (ROOT_DIR_ENTRIES * 32 / SECTOR_SIZE);
    const cluster2Off = cluster2Sector * SECTOR_SIZE;
    disk.set(readmeContent, cluster2Off);

    return disk;
}

/**
 * Virtual SD Card (FAT16/FAT32 SPI Mode Peripheral)
 */
export class VirtualSDCard {
    constructor(diskBuffer = null) {
        this.disk = diskBuffer instanceof Uint8Array ? diskBuffer : createDefaultFat16Image();
        this.cmdBuf = [];
        this.replyQueue = [];
        this.appCmd = false;
        this.inIdle = true;
        this.isSdhc = true;
        this.listeners = new Set();
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    loadDisk(buffer) {
        this.disk = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        this.replyQueue = [];
        this.cmdBuf = [];
        this.#emit('mounted', { size: this.disk.length, sectors: Math.floor(this.disk.length / 512) });
    }

    getDisk() {
        return this.disk;
    }

    onWrite(bytes) {
        if (!bytes) return;
        for (const b of bytes) this.#processByte(b);
    }

    onTransferByte(b) {
        this.#processByte(b);
        if (this.replyQueue.length > 0) {
            return this.replyQueue.shift();
        }
        return 0xFF;
    }

    #processByte(b) {
        if (this.cmdBuf.length === 0 && (b & 0xC0) !== 0x40) return;
        this.cmdBuf.push(b);
        if (this.cmdBuf.length === 6) {
            const cmd = this.cmdBuf[0] & 0x3F;
            const arg = ((this.cmdBuf[1] << 24) | (this.cmdBuf[2] << 16) | (this.cmdBuf[3] << 8) | this.cmdBuf[4]) >>> 0;
            const crc = this.cmdBuf[5];
            this.cmdBuf = [];
            this.#handleCommand(cmd, arg, crc);
        }
    }

    #handleCommand(cmd, arg, crc) {
        if (this.appCmd) {
            this.appCmd = false;
            if (cmd === 41) {
                this.inIdle = false;
                this.replyQueue.push(0x00);
                this.#emit('cmd', { cmd: 'ACMD41', arg, status: 'READY' });
                return;
            }
            if (cmd === 42) {
                this.replyQueue.push(0x00);
                this.#emit('cmd', { cmd: 'ACMD42', arg });
                return;
            }
        }

        if (cmd === 0) {
            this.inIdle = true;
            this.replyQueue.push(0x01);
            this.#emit('cmd', { cmd: 'CMD0 (GO_IDLE)', status: 'IDLE' });
        } else if (cmd === 59) {
            this.replyQueue.push(this.inIdle ? 0x01 : 0x00);
            this.#emit('cmd', { cmd: 'CMD59 (CRC_ON_OFF)', arg });
        } else if (cmd === 8) {
            this.replyQueue.push(0x01, 0x00, 0x00, 0x01, 0xAA);
            this.#emit('cmd', { cmd: 'CMD8 (SEND_IF_COND)', arg });
        } else if (cmd === 55) {
            this.appCmd = true;
            this.replyQueue.push(this.inIdle ? 0x01 : 0x00);
            this.#emit('cmd', { cmd: 'CMD55 (APP_CMD)' });
        } else if (cmd === 58) {
            const r1 = this.inIdle ? 0x01 : 0x00;
            const ocr = this.inIdle ? [0x00, 0xFF, 0x80, 0x00] : [0xC0, 0xFF, 0x80, 0x00];
            this.replyQueue.push(r1, ...ocr);
            this.#emit('cmd', { cmd: 'CMD58 (READ_OCR)' });
        } else if (cmd === 9) {
            this.replyQueue.push(0x00, 0xFE);
            // 1MB CSD
            const csd = [0x40, 0x0E, 0x00, 0x32, 0x5B, 0x59, 0x00, 0x00, 0x00, 0x01, 0x7F, 0x80, 0x0A, 0x40, 0x00, 0x00];
            const c = calcCrc16(csd);
            this.replyQueue.push(...csd, (c >> 8) & 0xFF, c & 0xFF);
            this.#emit('cmd', { cmd: 'CMD9 (SEND_CSD)' });
        } else if (cmd === 10) {
            this.replyQueue.push(0x00, 0xFE);
            const cid = [0x03, 0x53, 0x44, 0x53, 0x44, 0x30, 0x31, 0x4D, 0x80, 0x00, 0x00, 0x00, 0x01, 0x12, 0x01, 0x00];
            const c = calcCrc16(cid);
            this.replyQueue.push(...cid, (c >> 8) & 0xFF, c & 0xFF);
            this.#emit('cmd', { cmd: 'CMD10 (SEND_CID)' });
        } else if (cmd === 13) {
            this.replyQueue.push(0x00, 0x00);
        } else if (cmd === 16) {
            this.replyQueue.push(0x00);
            this.#emit('cmd', { cmd: 'CMD16 (SET_BLOCKLEN)', blockLen: arg });
        } else if (cmd === 17) {
            const lba = this.isSdhc ? arg : Math.floor(arg / 512);
            this.replyQueue.push(0x00, 0xFE);
            const offset = lba * 512;
            const chunk = [];
            for (let i = 0; i < 512; i++) {
                chunk.push(offset + i < this.disk.length ? this.disk[offset + i] : 0x00);
            }
            const c = calcCrc16(chunk);
            this.replyQueue.push(...chunk, (c >> 8) & 0xFF, c & 0xFF);
            this.#emit('read_sector', { lba, offset });
        } else if (cmd === 18) {
            const lba = this.isSdhc ? arg : Math.floor(arg / 512);
            this.replyQueue.push(0x00, 0xFE);
            const offset = lba * 512;
            const chunk = [];
            for (let i = 0; i < 512; i++) {
                chunk.push(offset + i < this.disk.length ? this.disk[offset + i] : 0x00);
            }
            const c = calcCrc16(chunk);
            this.replyQueue.push(...chunk, (c >> 8) & 0xFF, c & 0xFF);
            this.#emit('read_multiple', { lba, offset });
        } else {
            this.replyQueue.push(0x00);
        }
    }
}

/**
 * Emulates the ESP32-C3 SAR ADC1 (6 Channels: GPIO0, 1, 2, 3, 4, 5) with 12-bit resolution.
 */
export class VirtualADC {
    constructor() {
        // Pins 0..5 default to 1.65V (midpoint)
        this.voltages = new Map([
            [0, 1.65],
            [1, 0.0],
            [2, 3.3],
            [3, 0.825],
            [4, 2.475],
            [5, 1.65],
        ]);
        this.listeners = new Set();
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    setVoltage(pin, volts) {
        const v = Math.max(0.0, Math.min(3.3, Number(volts) || 0.0));
        this.voltages.set(pin, v);
        this.#emit('set_voltage', { pin, voltage: v, raw: this.getRaw(pin), mv: this.getMilliVolts(pin) });
    }

    getVoltage(pin) {
        return this.voltages.get(pin) ?? 0.0;
    }

    getRaw(pin) {
        const v = this.getVoltage(pin);
        const raw = Math.round((v / 3.3) * 4095);
        return Math.max(0, Math.min(4095, raw));
    }

    getMilliVolts(pin) {
        const v = this.getVoltage(pin);
        const mv = Math.round(v * 1000);
        return Math.max(0, Math.min(3300, mv));
    }

    readRaw(pin) {
        const raw = this.getRaw(pin);
        this.#emit('read_raw', { pin, raw, voltage: this.getVoltage(pin) });
        return raw;
    }

    readMilliVolts(pin) {
        const mv = this.getMilliVolts(pin);
        this.#emit('read_mv', { pin, mv, voltage: this.getVoltage(pin) });
        return mv;
    }
}

/**
 * Emulates the ESP32-C3 LEDC / PWM controller.
 */
export class VirtualPWM {
    constructor() {
        this.channels = new Map(); // pin -> { duty, maxDuty, percent }
        this.listeners = new Set();
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    update(pin, duty) {
        // Standard Arduino analogWrite is 8-bit (0..255) or LEDC (0..8191)
        const maxDuty = duty > 255 ? (duty > 1023 ? 8191 : 1023) : 255;
        const percent = Math.min(100, Math.max(0, (duty / maxDuty) * 100));
        this.channels.set(pin, { duty, maxDuty, percent });
        this.#emit('pwm_update', { pin, duty, maxDuty, percent: Number(percent.toFixed(1)) });
    }

    getChannel(pin) {
        return this.channels.get(pin) || { duty: 0, maxDuty: 255, percent: 0 };
    }
}

/**
 * Emulates the ESP32-C3 I2S Digital Audio Controller (PCM audio stream & Web Audio synthesis).
 */
export class VirtualI2S {
    constructor(sampleRate = 16000) {
        this.sampleRate = sampleRate;
        this.listeners = new Set();
    }

    onAudio(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(data) {
        for (const l of this.listeners) {
            try { l(data); } catch (e) {}
        }
    }

    writePcm(bytes) {
        if (!bytes || bytes.length === 0) return;
        // 16-bit stereo PCM
        const numSamples = Math.floor(bytes.length / 2);
        const floatSamples = new Float32Array(numSamples);
        let sumSq = 0;

        for (let i = 0; i < numSamples; i++) {
            const b0 = bytes[i * 2];
            const b1 = bytes[i * 2 + 1];
            let val = (b1 << 8) | b0;
            if (val >= 0x8000) val -= 0x10000;
            const norm = val / 32768.0;
            floatSamples[i] = norm;
            sumSq += norm * norm;
        }

        const rms = Math.sqrt(sumSq / (numSamples || 1));
        const volumePercent = Math.min(100, Math.round(rms * 100 * 2));

        this.#emit({
            sampleRate: this.sampleRate,
            channels: 2,
            samples: Array.from(floatSamples),
            volume: volumePercent,
            byteLength: bytes.length,
            timestamp: Date.now(),
        });
    }
}

/**
 * Emulates the ESP32-C3 TWAI / CAN Bus Controller (ISO 11898-1 Standard/Extended Frames).
 */
export class VirtualTWAI {    constructor() {
        this.listeners = new Set();
        this.rxQueue = [];
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    transmit(frame) {
        this.#emit('tx', {
            id: frame.id,
            extd: frame.extd || false,
            rtr: frame.rtr || false,
            dlc: frame.dlc || 0,
            data: frame.data || [],
        });
    }

    inject(frame) {
        const id = frame.id >>> 0;
        const dlc = Math.min(8, frame.data ? frame.data.length : 0);
        const flags = (frame.extd ? 1 : 0) | (frame.rtr ? 2 : 0);

        this.rxQueue.push({ id, flags, dlc, data: frame.data || [] });

        this.#emit('rx', {
            id,
            extd: !!frame.extd,
            rtr: !!frame.rtr,
            dlc,
            data: frame.data || [],
        });
    }

    popRxFrame() {
        if (this.rxQueue.length === 0) return null;
        const frame = this.rxQueue.shift();
        // 1 + 1 + 4 + 1 + 8 = 15 bytes
        const raw = new Uint8Array(15);
        raw[0] = 1; // status: 1 = frame available
        raw[1] = frame.flags & 0x7f;
        raw[2] = (frame.id >> 21) & 0x7f;
        raw[3] = (frame.id >> 14) & 0x7f;
        raw[4] = (frame.id >> 7) & 0x7f;
        raw[5] = frame.id & 0x7f;
        raw[6] = frame.dlc & 0x0f;
        for (let i = 0; i < 8; i++) {
            raw[7 + i] = (frame.data && i < frame.data.length) ? frame.data[i] : 0x00;
        }
        return raw;
    }
}

/**
 * Virtual capacitive touch pad sensor (Arduino `touchRead` API).
 *
 * The C3/C6/H2/P4 Arduino cores gate touch behind SOC_TOUCH_SENSOR_SUPPORTED,
 * so sketches define an `extern "C"` fallback which the loader overwrites with
 * the `touchRead` shim. Untouched pads read high (~1200); touched pads read
 * low (~300). Threshold crossing fires interrupt listeners.
 */
export class VirtualTouch {
    constructor(touchedValue = 300, releasedValue = 1200) {
        this.touchedValue = touchedValue;
        this.releasedValue = releasedValue;
        this.touched = new Map(); // pin -> bool
        this.thresholds = new Map(); // pin -> threshold
        this.listeners = new Set();
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    setTouched(pin, touched) {
        const was = this.touched.get(pin) || false;
        this.touched.set(pin, !!touched);
        const raw = this.getRaw(pin);
        if (!!touched !== was) {
            this.#emit('touch_event', { pin, touched: !!touched, raw });
            const th = this.thresholds.get(pin);
            if (th !== undefined && !!touched && raw < th) {
                this.#emit('interrupt', { pin, raw, threshold: th });
            }
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

/**
 * Virtual DAC output (Arduino `dacWrite` API, 8-bit 0..255 -> 0..3.3V).
 *
 * Same sketch-fallback pattern as touch: C3/C6/H2 Arduino cores provide no
 * `dacWrite`, so sketches define an `extern "C"` fallback patched at load.
 */
export class VirtualDAC {
    constructor(referenceVoltage = 3.3) {
        this.refVoltage = referenceVoltage;
        this.channels = new Map(); // pin -> { value, voltage }
        this.listeners = new Set();
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    write(pin, value) {
        const v = Math.max(0, Math.min(255, value | 0));
        const voltage = (v / 255) * this.refVoltage;
        this.channels.set(pin, { value: v, voltage });
        this.#emit('dac_update', { pin, value: v, voltage });
        return true;
    }

    getChannel(pin) {
        return this.channels.get(pin) || { value: 0, voltage: 0 };
    }
}

/**
 * Virtual SDMMC host (4-bit SD bus, sector-level emulation).
 *
 * Firmware calls `emuSdmmcReadSectors` / `emuSdmmcWriteSectors` (sketch-defined
 * symbols patched at load). Backed by a FAT disk image shared in format with
 * VirtualSDCard so the same /README.TXT content is visible on both buses.
 */
export class VirtualSDMMC {
    constructor(diskBuffer = null) {
        this.disk = diskBuffer instanceof Uint8Array ? diskBuffer : createDefaultFat16Image();
        this.listeners = new Set();
    }

    onActivity(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    #emit(type, data) {
        for (const l of this.listeners) {
            try { l({ type, ...data, timestamp: Date.now() }); } catch (e) {}
        }
    }

    get sectorCount() {
        return Math.floor(this.disk.length / 512);
    }

    readSectors(lba, count) {
        const out = new Uint8Array(count * 512);
        for (let i = 0; i < out.length; i++) {
            const off = lba * 512 + i;
            out[i] = off < this.disk.length ? this.disk[off] : 0x00;
        }
        this.#emit('read', { lba, count });
        return out;
    }

    writeSectors(lba, data) {
        const count = Math.floor(data.length / 512);
        for (let i = 0; i < count * 512; i++) {
            const off = lba * 512 + i;
            if (off < this.disk.length) this.disk[off] = data[i];
        }
        this.#emit('write', { lba, count });
        return 0;
    }

    /**
     * Accumulate one `M W` chunk frame (`lba`, `count`, partial payload).
     * The shim splits sector payloads into ≤128B frames so no single TX frame
     * is large enough to get its tail dropped at batch boundaries (H2); the
     * write applies once all `count*512` bytes have arrived.
     * @returns {number} 0 when the write applied, -1 while still accumulating.
     */
    writeChunk(lba, count, chunk) {
        const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk || []);
        const key = (lba >>> 0) + ':' + count;
        if (!this._pending || this._pending.key !== key) {
            this._pending = { key, lba: lba >>> 0, count, parts: [], total: 0 };
        }
        this._pending.parts.push(bytes);
        this._pending.total += bytes.length;
        if (this._pending.total >= count * 512) {
            const full = new Uint8Array(count * 512);
            let off = 0;
            for (const part of this._pending.parts) {
                const take = Math.min(part.length, full.length - off);
                full.set(part.subarray(0, take), off);
                off += take;
                if (off >= full.length) break;
            }
            this._pending = null;
            return this.writeSectors(lba, full);
        }
        return -1;
    }
}

/**
 * Virtual camera (grayscale test-pattern frames).
 *
 * Firmware calls `int emuCameraFbGet(buf, w, h, fmt)`; the host synthesizes a
 * deterministic gradient + bar pattern so firmware can verify checksum/length.
 * fmt 0 = 8-bit grayscale.
 */
export class VirtualCamera {
    constructor() {
        this.onFrameCallback = null;
        this.frameCount = 0;
    }

    onFrame(cb) {
        this.onFrameCallback = cb;
    }

    capture(w, h, fmt = 0) {
        w = Math.max(1, Math.min(320, w | 0));
        h = Math.max(1, Math.min(240, h | 0));
        const data = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                // Deterministic pattern: horizontal gradient XORed with 8px bars.
                const bar = ((x >> 3) & 1) ? 0x70 : 0x00;
                data[y * w + x] = (((x * 255) / Math.max(1, w - 1)) | 0) ^ bar ^ ((y * 31) & 0xff);
            }
        }
        this.frameCount++;
        if (this.onFrameCallback) {
            this.onFrameCallback({ width: w, height: h, fmt, buffer: data.slice(), frame: this.frameCount });
        }
        return data;
    }

    /**
     * Slice [offset, offset+len) of the canonical 96x96 grayscale frame.
     * Backs banded transfers (`emuCameraReadBand`): each band is small enough
     * for every chip's host->firmware path (see PROTOCOLS.md transport notes).
     */
    readBand(offset, len, w = 96, h = 96) {
        const full = this.capture(w, h, 0);
        return full.subarray(offset >>> 0, Math.min(full.length, (offset >>> 0) + len));
    }
}

/**
 * Virtual MIPI-DSI / parallel LCD panel (RGB565 bitmap blits).
 *
 * Firmware calls `emuLcdDraw(&req)` with {x1,y1,x2,y2,px,len}; the panel keeps
 * a 240x240 RGBA framebuffer (same geometry as ST7789Device) and emits frames.
 */
export class VirtualLcdPanel {
    constructor(width = 240, height = 240) {
        this.width = width;
        this.height = height;
        this.rgbaBuffer = new Uint8Array(width * height * 4);
        this.onFrameCallback = null;
        this.drawCount = 0;
        // Default to opaque black.
        for (let i = 3; i < this.rgbaBuffer.length; i += 4) this.rgbaBuffer[i] = 255;
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
                draws: this.drawCount,
            });
        }
    }

    drawBitmap(x1, y1, x2, y2, rgb565Bytes) {
        // NOTE: bytes are little-endian guest-memory order (uint16_t array as
        // the 'L' shim streams it), unlike ST7789Device which takes big-endian
        // SPI wire order.
        x1 = Math.max(0, Math.min(this.width - 1, x1 | 0));
        y1 = Math.max(0, Math.min(this.height - 1, y1 | 0));
        x2 = Math.max(x1, Math.min(this.width - 1, x2 | 0));
        y2 = Math.max(y1, Math.min(this.height - 1, y2 | 0));
        let p = 0;
        const px = rgb565Bytes instanceof Uint8Array ? rgb565Bytes : Uint8Array.from(rgb565Bytes || []);
        for (let y = y1; y <= y2 && p + 1 < px.length; y++) {
            for (let x = x1; x <= x2 && p + 1 < px.length; x++) {
                const c = (px[p + 1] << 8) | px[p];
                p += 2;
                const idx = (y * this.width + x) * 4;
                this.rgbaBuffer[idx] = Math.round((((c >> 11) & 0x1f) * 255) / 31);
                this.rgbaBuffer[idx + 1] = Math.round((((c >> 5) & 0x3f) * 255) / 63);
                this.rgbaBuffer[idx + 2] = Math.round((((c) & 0x1f) * 255) / 31);
                this.rgbaBuffer[idx + 3] = 255;
            }
        }
        this.drawCount++;
        this.notifyFrame();
        return { x1, y1, x2, y2, draws: this.drawCount };
    }
}



