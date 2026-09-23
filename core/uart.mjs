// On-Chip UART0 Controller & APC Frame Parser for ESP32 RISC-V
// Separates normal serial terminal text from high-speed peripheral APC escape frames.

const APC_REGEX = /\x1b_(.)([\s\S]*?)\x1b\\/;

import { BLEController } from './ble_controller.mjs';
import { ReplyDribbler } from '../reply_queue.mjs';
import { BLEMirror } from './ble_mirror.mjs';

export class UARTController {
        constructor(wasmEmu) {
        this.emu = wasmEmu;
        this.streamBuffer = '';
        this._dataListeners = new Set();
        this.ble = new BLEController();
        // Paced host->firmware replies (see reply_queue.mjs): large replies
        // must be dribbled across batches or the HW RX FIFO drops them.
        this.dribbler = new ReplyDribbler();
        // Shared-memory HCI event channel (see ble_mirror.mjs). Memory is
        // bound by ESP32C3 after construction (needs the WASM export).
        this.bleMirror = new BLEMirror(() => this._memoryBuf());
        this._memory = null;
    }

    /** Bind WASM linear memory for the BLE shared-memory channel. */
    bindMemory(memory) {
        this._memory = memory;
    }

    _memoryBuf() {
        if (!this._memory) throw new Error('no memory bound');
        return this._memory.buffer;
    }

    /**
     * Send serial input into the UART0 RX FIFO (e.g. keyboard characters).
     * @param {string | Uint8Array | number[]} input
     */
    write(input) {
        if (!this.emu) return;
        let bytes;
        if (typeof input === 'string') {
            bytes = new TextEncoder().encode(input);
        } else if (input instanceof Uint8Array) {
            bytes = input;
        } else {
            bytes = new Uint8Array(input);
        }
        this.emu.uart_input(bytes);
    }

    /**
     * Listen for clean serial console output (excluding internal APC frames).
     * @param {(text: string) => void} callback
     */
    onData(callback) {
        this._dataListeners.add(callback);
        return () => this._dataListeners.delete(callback);
    }

    /**
     * Internal: Process raw output chunk from WASM emulator, extracting APC frames
     * and forwarding clean text to data listeners.
     */
    processOutputChunk(rawChunk, controllers = {}) {
        // Flush previously queued replies first: a polling shim produces no
        // console output while it waits, so this must run even for empty chunks.
        this.dribbler.pump((b) => this.write(b));
        if (!rawChunk) return '';
        this.streamBuffer += rawChunk;
        let cleanText = '';

        while (true) {
            const m = this.streamBuffer.match(APC_REGEX);
            if (m) {
                const textSlice = this.streamBuffer.slice(0, m.index);
                cleanText += textSlice;

                const [frame, kind, body] = m;
                this._routeApcFrame(kind, body, controllers);

                this.streamBuffer = this.streamBuffer.slice(m.index + frame.length);
            } else {
                const escIdx = this.streamBuffer.lastIndexOf('\x1b');
                if (escIdx !== -1) {
                    cleanText += this.streamBuffer.slice(0, escIdx);
                    this.streamBuffer = this.streamBuffer.slice(escIdx);
                } else {
                    cleanText += this.streamBuffer;
                    this.streamBuffer = '';
                }
                break;
            }
        }

        if (cleanText.length > 0) {
            for (const listener of this._dataListeners) {
                try {
                    listener(cleanText);
                } catch (_) {}
            }
        }

        // Release newly queued reply bytes (if any) in the same batch.
        this.dribbler.pump((b) => this.write(b));

        return cleanText;
    }

    _routeApcFrame(kind, body, { i2c, spi, gpio, neopixel, adc, pwm, i2s, twai, ble, touch, dac, sdmmc, camera, lcd, thread }) {
        switch (kind) {
            case 'B': { // BLE HCI command -> virtual controller -> event
                if (!ble) break;
                const hex = [...body].map(c => c.charCodeAt(0) - 97);
                const bytes = [];
                for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                const event = ble.handle(new Uint8Array(bytes));
                // Preferred: shared-memory event channel (reliable, no RX).
                // Fallback: legacy E-UART reply (dribbled). Null/empty (e.g.
                // host->controller ACL, observed only) delivers nothing.
                if (event && event.length && !this.bleMirror.deliver(event)) {
                    let out = '\x1b_E';
                    const len = event.length;
                    out += String.fromCharCode(97 + ((len >> 4) & 0xf), 97 + (len & 0xf));
                    for (const b of event) out += String.fromCharCode(97 + ((b >> 4) & 0xf), 97 + (b & 0xf));
                    out += '\x1b\\';
                    this.dribbler.push(new TextEncoder().encode(out));
                }
                break;
            }
            case 'W': { // I2C Write
                if (!i2c) break;
                const addr = body.charCodeAt(0);
                const hex = [...body.slice(1)].map(c => c.charCodeAt(0) - 97);
                const bytes = [];
                for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                i2c.write(addr, bytes);
                break;
            }
            case 'R': { // I2C Read
                if (!i2c) break;
                const addr = body.charCodeAt(0);
                const len = body.charCodeAt(1);
                const data = i2c.read(addr, len);
                this.write(new Uint8Array(data));
                break;
            }
            case 'Q': { // I2C Probe (scan): 1 byte back, 1 = device ACKed
                if (!i2c) break;
                const addr = body.charCodeAt(0) & 0x7f;
                const present = (i2c.devices && i2c.devices.has(addr)) ? 1 : 0;
                this.write(new Uint8Array([present]));
                break;
            }
            case 'S': { // SPI Transfer
                if (!spi) break;
                // Keep TFT DC tracking live: a DC change (gpio.sync) can land
                // after the SPI bytes in the same batch were queued, so route
                // every device's bytes through the current DC level here.
                // (DC is sampled per byte inside ST7789 via the gpio binding.)
                if (gpio && spi.devices) {
                    for (const dev of spi.devices.values()) {
                        if (dev && typeof dev.bindDcGpio === 'function' && !dev._gpio) {
                            try { dev.bindDcGpio(gpio, dev.dcPin ?? 2); } catch (_) {}
                        }
                    }
                }
                if (body[0] === 'W') {
                    // Write-only burst (spiWriteNL/spiWritePixelsNL): the W
                    // shim emits the RAW byte count as one control byte, NOT
                    // masked to 7 bits (0.43 firmware sends 128/132-byte
                    // chunks whose low-7-bits alias to 0/4 — the old
                    // `& 0x7F` + `len === 64` reply gate starved the guest's
                    // RX poll and hung the ST7789 splash). Reply one ACK per
                    // DATA byte delivered (matches the pre-0.43 `len === 64`
                    // behavior for 64B frames: 64 ACKs); the guest's RX poll
                    // consumes one ACK per byte it waits for.
                    const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
                    const bytes = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                    spi.write(bytes);
                    // Paced ACKs (see reply_queue.mjs): a 128B burst pushed
                    // via uart_input at once overflows the guest HW RX FIFO
                    // and the shim's poll spins forever. Drizzle 16B/batch.
                    this.dribbler.push(new Uint8Array(bytes.map(() => 0)));
                } else if (body[0] === 'X') {
                    const lenHi = body.charCodeAt(1) & 0x7F;
                    const lenLo = body.charCodeAt(2) & 0x7F;
                    const len = (lenHi << 7) | lenLo;
                    const hex = [...body.slice(3)].map(c => c.charCodeAt(0) - 97);
                    const bytes = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                    const replies = [];
                    for (const b of bytes) replies.push(spi.transferByte(b));
                    this.write(new Uint8Array(replies));
                } else {
                    // Single-TX-byte poll frames (spiTransferShortNL emits one
                    // `S<xx>` frame per byte and polls RX for each; longer
                    // frames are multi-byte `SX`). Reply per byte keeps the
                    // guest's poll loop moving (ST7789 stalled here: its 2-byte
                    // write16 path got 1 reply byte and spun forever).
                    const hex = [...body].map(c => c.charCodeAt(0) - 97);
                    const replies = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) {
                        replies.push(spi.transferByte(((hex[j] & 15) << 4) | (hex[j + 1] & 15)));
                    }
                    this.write(new Uint8Array(replies));
                }
                break;
            }
            case 'N': { // NeoPixel (RMT)
                if (!neopixel) break;
                const pin = body.charCodeAt(0);
                const len = body.charCodeAt(1);
                const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
                const bytes = [];
                for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                if (typeof neopixel.update === 'function') neopixel.update(pin, bytes);
                break;
            }
            case 'A': { // ADC Read Raw
                if (!adc) break;
                const pin = body.charCodeAt(0) & 0x7F;
                const val = adc.readRaw(pin);
                this.write(new Uint8Array([(val >> 8) & 0xFF, val & 0xFF]));
                break;
            }
            case 'V': { // ADC Read MilliVolts
                if (!adc) break;
                const pin = body.charCodeAt(0) & 0x7F;
                const val = adc.readMilliVolts(pin);
                this.write(new Uint8Array([(val >> 8) & 0xFF, val & 0xFF]));
                break;
            }
            case 'P': { // PWM / LEDC
                if (!pwm) break;
                const pin = body.charCodeAt(0) & 0x7F;
                const dutyHi = body.charCodeAt(1) & 0x7F;
                const dutyLo = body.charCodeAt(2) & 0x7F;
                const duty = (dutyHi << 7) | dutyLo;
                pwm.update(pin, duty);
                break;
            }
            case 'I': { // I2S Digital Audio
                if (!i2s) break;
                const lenHi = body.charCodeAt(0) & 0x7F;
                const lenLo = body.charCodeAt(1) & 0x7F;
                const len = (lenHi << 7) | lenLo;
                const bytes = [];
                for (let i = 0; i < len && 2 + i < body.length; i++) bytes.push(body.charCodeAt(2 + i) & 0xFF);
                i2s.writePcm(bytes);
                break;
            }
            case 'C': { // TWAI / CAN Bus
                if (!twai) break;
                if (body === 'R') {
                    const resp = twai.popRxFrame() || new Uint8Array([0]);
                    this.write(resp);
                } else {
                    const flags = body.charCodeAt(0) & 0x7F;
                    const dlc = body.charCodeAt(1) & 0x0F;
                    const id = ((body.charCodeAt(2) & 0x7F) << 21) |
                               ((body.charCodeAt(3) & 0x7F) << 14) |
                               ((body.charCodeAt(4) & 0x7F) << 7) |
                               (body.charCodeAt(5) & 0x7F);
                    const data = [];
                    for (let i = 0; i < dlc && 6 + i < body.length; i++) data.push(body.charCodeAt(6 + i) & 0xFF);
                    twai.transmit({ id, extd: (flags & 1) !== 0, rtr: (flags & 2) !== 0, dlc, data });
                }
                break;
            }
            case 'T': { // Touch pad read: T<pin>
                if (!touch) break;
                const pin = body.charCodeAt(0) & 0x7F;
                const raw = touch.read(pin);
                this.write(new Uint8Array([(raw >> 8) & 0xFF, raw & 0xFF]));
                break;
            }
            case 'D': { // DAC write: D<pin><vhi><vlo> (nibble-encoded)
                if (!dac) break;
                const pin = body.charCodeAt(0) & 0x7F;
                const value = (((body.charCodeAt(1) - 97) & 0xF) << 4) | ((body.charCodeAt(2) - 97) & 0xF);
                dac.write(pin, value);
                break;
            }
            case 'M': { // SDMMC sector transfer: M<R|W><lba:8nib><count:4nib>[nibbles...]
                if (!sdmmc) break;
                const op = body[0];
                const nib = (c) => (c.charCodeAt(0) - 97) & 0xF;
                let lba = 0;
                for (let i = 1; i <= 8; i++) lba = (lba << 4) | nib(body[i]);
                let count = 0;
                for (let i = 9; i <= 12; i++) count = (count << 4) | nib(body[i]);
                count = Math.max(0, Math.min(64, count));
                if (op === 'R') {
                    // 512B+ replies exceed the HW RX FIFO: dribble across batches.
                    this.dribbler.push(sdmmc.readSectors(lba >>> 0, count));
                } else if (op === 'W') {
                    // Chunked writes (see shim_sdmmc_write): reassembled by the
                    // device; emits 'write' only once the sector is complete.
                    const bytes = [];
                    for (let i = 13; i + 1 < body.length; i += 2) {
                        bytes.push((nib(body[i]) << 4) | nib(body[i + 1]));
                    }
                    sdmmc.writeChunk(lba >>> 0, count, new Uint8Array(bytes));
                }
                break;
            }
            case 'F': { // Camera band: F<off:8nib><len:4nib> -> len + bytes
                if (!camera) break;
                const nib = (c) => (c.charCodeAt(0) - 97) & 0xF;
                let off = 0;
                for (let i = 0; i < 8; i++) off = (off << 4) | nib(body[i]);
                let count = 0;
                for (let i = 8; i < 12; i++) count = (count << 4) | nib(body[i]);
                count = Math.max(0, Math.min(1024, count));
                const frame = camera.readBand(off >>> 0, count);
                const hdr = new Uint8Array(4);
                hdr[0] = (frame.length >>> 24) & 0xFF;
                hdr[1] = (frame.length >>> 16) & 0xFF;
                hdr[2] = (frame.length >>> 8) & 0xFF;
                hdr[3] = frame.length & 0xFF;
                const out = new Uint8Array(4 + frame.length);
                out.set(hdr, 0);
                out.set(frame, 4);
                // Band replies are small (<=1KB); dribble anyway (HW RX FIFO).
                this.dribbler.push(out);
                break;
            }
            case 'L': { // LCD panel blit: L<x1:4><y1:4><x2:4><y2:4><len:8><nibbles...>
                if (!lcd) break;
                const nib = (c) => (c.charCodeAt(0) - 97) & 0xF;
                const rd16 = (o) => (nib(body[o]) << 12) | (nib(body[o + 1]) << 8) | (nib(body[o + 2]) << 4) | nib(body[o + 3]);
                const x1 = rd16(0), y1 = rd16(4), x2 = rd16(8), y2 = rd16(12);
                let len = 0;
                for (let i = 16; i < 24; i++) len = (len << 4) | nib(body[i]);
                len = Math.max(0, Math.min(240 * 240 * 2, len));
                const bytes = new Uint8Array(len);
                for (let i = 0, o = 24; i < len && o + 1 < body.length; i++, o += 2) {
                    bytes[i] = (nib(body[o]) << 4) | nib(body[o + 1]);
                }
                lcd.drawBitmap(x1, y1, x2, y2, bytes);
                break;
            }
            case 'G': { // 802.15.4 TX tap: G<ch><len><psdu nibbles>
                if (thread && typeof thread.handle === 'function') thread.handle(body);
                break;
            }
            case 'H': { // 802.15.4 energy-scan tap: H<ch>
                if (thread && typeof thread.handleScan === 'function') thread.handleScan(body);
                break;
            }
        }
    }
}
