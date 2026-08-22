// On-Chip UART0 Controller & APC Frame Parser for ESP32 RISC-V
// Separates normal serial terminal text from high-speed peripheral APC escape frames.

const APC_REGEX = /\x1b_(.)([\s\S]*?)\x1b\\/;

import { BLEController } from './ble_controller.mjs';

export class UARTController {
        constructor(wasmEmu) {
        this.emu = wasmEmu;
        this.streamBuffer = '';
        this._dataListeners = new Set();
        this.ble = new BLEController();
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

        return cleanText;
    }

    _routeApcFrame(kind, body, { i2c, spi, neopixel, adc, pwm, i2s, twai, ble }) {
        switch (kind) {
            case 'B': { // BLE HCI command -> virtual controller -> event
                if (!ble) break;
                const hex = [...body].map(c => c.charCodeAt(0) - 97);
                const bytes = [];
                for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                const event = ble.handle(new Uint8Array(bytes));
                let out = '\x1b_E';
                const len = event.length;
                out += String.fromCharCode(97 + ((len >> 4) & 0xf), 97 + (len & 0xf));
                for (const b of event) out += String.fromCharCode(97 + ((b >> 4) & 0xf), 97 + (b & 0xf));
                out += '\x1b\\';
                this.write(out);
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
            case 'S': { // SPI Transfer
                if (!spi) break;
                if (body[0] === 'W') {
                    const len = body.charCodeAt(1) & 0x7F;
                    const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
                    const bytes = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                    spi.write(bytes);
                    if (len === 64) this.write(new Uint8Array([0]));
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
                    const hi = body.charCodeAt(0) - 97;
                    const lo = body.charCodeAt(1) - 97;
                    const txByte = ((hi & 15) << 4) | (lo & 15);
                    const reply = spi.transferByte(txByte);
                    this.write(new Uint8Array([reply]));
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
        }
    }
}
