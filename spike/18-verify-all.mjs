// Comprehensive Verification Suite for esp-emu Virtual Peripherals (I2C, SPI, GPIO, SSD1306, ST7789, NeoPixel, SDCard)
import { readFileSync } from 'node:fs';
import { Elf32, planHooks, prepareSpiShims, prepareIdfShims } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SPIBus, SSD1306Device, ST7789Device, NeoPixelStrip, MPU6050Device, VirtualSDCard, VirtualADC, VirtualPWM, VirtualI2S, VirtualTWAI } from '../peripherals.mjs';
import { boot } from './harness.mjs';

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;

async function runTest(testName, binPath, elfPath, customVerify) {
    console.log(`\n========================================`);
    console.log(`TEST: ${testName}`);
    console.log(`========================================`);

    const flash = new Uint8Array(readFileSync(binPath));
    const elf = new Elf32(readFileSync(elfPath));
    const hookPlan = planHooks(elf);
    const allHooks = []
        .concat(hookPlan?.i2c?.hooks || [])
        .concat(hookPlan?.spi?.hooks || [])
        .concat(hookPlan?.neopixel?.hooks || [])
        .concat(hookPlan?.adc?.hooks || [])
        .concat(hookPlan?.pwm?.hooks || [])
        .concat(hookPlan?.i2s?.hooks || [])
        .concat(hookPlan?.twai?.hooks || [])
        .concat(hookPlan?.touch?.hooks || [])
        .concat(hookPlan?.dac?.hooks || [])
        .concat(hookPlan?.sdmmc?.hooks || [])
        .concat(hookPlan?.camera?.hooks || [])
        .concat(hookPlan?.lcd?.hooks || []);

    const hooks = Object.fromEntries(allHooks.map(h => [h.name, h]));
    const effectiveShims = prepareSpiShims(elf, SHIMS);
    const idfPair = prepareIdfShims(elf, effectiveShims);
    Object.assign(effectiveShims, idfPair.shims);

    const img = new EspImage(flash);
    const patched = [];
    for (const [fn, shim] of Object.entries(effectiveShims)) {
        if (hooks[fn] && shim.length <= hooks[fn].size) {
            img.writeAtVaddr(hooks[fn].addr, shim);
            patched.push(fn);
        }
    }
    for (const ex of idfPair.extra) {
        try { img.writeAtVaddr(ex.addr, ex.bytes); patched.push('idf:' + ex.addr.toString(16)); } catch (_) {}
    }
    if (patched.length > 0) {
        await img.reseal();
        console.log(`✓ Auto-patched shims: ${patched.join(', ')}`);
    } else {
        console.log(`✓ No shims needed (pure GPIO/CPU)`);
    }

    const i2cBus = new I2CBus();
    const spiBus = new SPIBus();
    const oled = new SSD1306Device(128, 64);
    const tft = new ST7789Device(240, 240);
    const neoPixel = new NeoPixelStrip(8);
    const mpu = new MPU6050Device();
    const sd = new VirtualSDCard();
    const adc = new VirtualADC();
    const pwm = new VirtualPWM();
    const i2s = new VirtualI2S();
    const twai = new VirtualTWAI();
    i2cBus.register(0x3c, oled);
    i2cBus.register(0x3d, oled);
    i2cBus.register(0x68, mpu);
    spiBus.register('tft', tft);
    spiBus.register('sd', sd);

    const { emu, memory } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

    let streamBuffer = '', cleanConsole = '';

    function processStream(chunk) {
        streamBuffer += chunk;
        while (true) {
            const m = streamBuffer.match(APC);
            if (m) {
                cleanConsole += streamBuffer.slice(0, m.index);
                const [frame, kind, body] = m;
                if (kind === 'W') {
                    const addr = body.charCodeAt(0);
                    const hex = [...body.slice(1)].map(c => c.charCodeAt(0) - 97);
                    const bytes = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                    i2cBus.write(addr, bytes);
                } else if (kind === 'R') {
                    const addr = body.charCodeAt(0);
                    const len = body.charCodeAt(1);
                    const data = i2cBus.read(addr, len);
                    emu.uart_input(new Uint8Array(data));
                } else if (kind === 'S') {
                    if (body[0] === 'W') {
                        const len = body.charCodeAt(1) & 0x7f;
                        const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
                        const bytes = [];
                        for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                        spiBus.write(bytes);
                        if (len === 64) emu.uart_input(new Uint8Array([0]));
                    } else if (body[0] === 'X') {
                        const lenHi = body.charCodeAt(1) & 0x7f;
                        const lenLo = body.charCodeAt(2) & 0x7f;
                        const len = (lenHi << 7) | lenLo;
                        const hex = [...body.slice(3)].map(c => c.charCodeAt(0) - 97);
                        const bytes = [];
                        for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                        const replies = [];
                        for (const b of bytes) replies.push(spiBus.transferByte(b));
                        emu.uart_input(new Uint8Array(replies));
                    } else {
                        const hi = body.charCodeAt(0) - 97;
                        const lo = body.charCodeAt(1) - 97;
                        const txByte = ((hi & 15) << 4) | (lo & 15);
                        const reply = spiBus.transferByte(txByte);
                        emu.uart_input(new Uint8Array([reply]));
                    }
                } else if (kind === 'N') {
                    const pin = body.charCodeAt(0);
                    const len = body.charCodeAt(1);
                    const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
                    const bytes = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                    neoPixel.update(pin, bytes);
                } else if (kind === 'A') {
                    const pin = body.charCodeAt(0) & 0x7F;
                    const val = adc.readRaw(pin);
                    emu.uart_input(new Uint8Array([(val >> 8) & 0xFF, val & 0xFF]));
                } else if (kind === 'V') {
                    const pin = body.charCodeAt(0) & 0x7F;
                    const val = adc.readMilliVolts(pin);
                    emu.uart_input(new Uint8Array([(val >> 8) & 0xFF, val & 0xFF]));
                } else if (kind === 'P') {
                    const pin = body.charCodeAt(0) & 0x7F;
                    const dutyHi = body.charCodeAt(1) & 0x7F;
                    const dutyLo = body.charCodeAt(2) & 0x7F;
                    const duty = (dutyHi << 7) | dutyLo;
                    pwm.update(pin, duty);
                } else if (kind === 'I') {
                    const lenHi = body.charCodeAt(0) & 0x7f;
                    const lenLo = body.charCodeAt(1) & 0x7f;
                    const len = (lenHi << 7) | lenLo;
                    const bytes = [];
                    for (let i = 0; i < len && 2 + i < body.length; i++) bytes.push(body.charCodeAt(2 + i) & 0xff);
                    i2s.writePcm(bytes);
                } else if (kind === 'C') {
                    if (body === 'R') {
                        const resp = twai.popRxFrame() || new Uint8Array([0]);
                        emu.uart_input(resp);
                    } else {
                        const flags = body.charCodeAt(0) & 0x7f;
                        const dlc = body.charCodeAt(1) & 0x0f;
                        const id = ((body.charCodeAt(2) & 0x7f) << 21) |
                                   ((body.charCodeAt(3) & 0x7f) << 14) |
                                   ((body.charCodeAt(4) & 0x7f) << 7) |
                                   (body.charCodeAt(5) & 0x7f);
                        const data = [];
                        for (let i = 0; i < dlc && 6 + i < body.length; i++) data.push(body.charCodeAt(6 + i) & 0xff);
                        twai.transmit({ id, extd: (flags & 1) !== 0, rtr: (flags & 2) !== 0, dlc, data });
                    }
                }
                streamBuffer = streamBuffer.slice(m.index + frame.length);
            } else {
                const partialIdx = streamBuffer.lastIndexOf('\x1b_');
                if (partialIdx !== -1) {
                    cleanConsole += streamBuffer.slice(0, partialIdx);
                    streamBuffer = streamBuffer.slice(partialIdx);
                } else {
                    cleanConsole += streamBuffer;
                    streamBuffer = '';
                }
                break;
            }
        }
    }

    await customVerify({
        stepBatches: (count, size = 50000) => {
            for (let i = 0; i < count; i++) {
                const raw = emu.run_batch(size);
                if (raw) processStream(raw);
            }
            return cleanConsole;
        },
        memory,
        i2cBus,
        spiBus,
        oled,
        tft,
        neoPixel,
        mpu,
        sd,
        adc,
        pwm,
        i2s,
        twai,
        getConsole: () => cleanConsole,
    });
}

// 1. Test Blink
await runTest('Blink (GPIO2 Output)', 'samples/blink.merged.bin', 'samples/blink.elf', async ({ stepBatches, memory }) => {
    stepBatches(300);
    const view = new DataView(memory.buffer);
    const enVal = view.getBigUint64(0x827858, true);
    const pin2Enabled = ((enVal >> 2n) & 1n) === 1n;

    let saw0 = false, saw4 = false;
    for (let i = 0; i < 20; i++) {
        stepBatches(10);
        const v = view.getUint32(0x827850, true);
        if ((v & 4) === 4) saw4 = true;
        if ((v & 4) === 0) saw0 = true;
    }
    console.log(`GPIO2 Output Enabled: ${pin2Enabled}, Toggling Observed: ${saw0 && saw4 ? 'PASS' : 'FAIL'}`);
    if (!pin2Enabled || !saw4) throw new Error('Blink test failed');
});

// 2. Test I2CRead
await runTest('I2C Sensor Read (0x68 IMU)', 'samples/i2cread.merged.bin', 'samples/i2cread.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(600);
    const cons = getConsole();
    const matched = cons.includes('got=3:DEADBE');
    console.log(`Received mock sensor bytes 'got=3:DEADBE': ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) throw new Error('I2CRead test failed');
});

// 3. Test OLEDDemo
await runTest('Adafruit SSD1306 OLED Demo (128x64)', 'samples/oled_demo.merged.bin', 'samples/oled_demo.elf', async ({ stepBatches, oled, getConsole }) => {
    let frameCount = 0;
    oled.onFrame(() => frameCount++);
    stepBatches(1200);
    console.log(`OLED frames rendered: ${frameCount} -> ${frameCount >= 5 ? 'PASS' : 'FAIL'}`);
    if (frameCount < 5) throw new Error('OLEDDemo test failed');
});

// 4. Test SPIDemo
await runTest('SPIDemo (Full Duplex Transfer)', 'samples/spidemo.merged.bin', 'samples/spidemo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(600);
    const cons = getConsole();
    const matched = cons.includes('Single byte: TX=0x42') && cons.includes('Block transfer:') && cons.includes('spi-done');
    console.log(`SPI Transfer Result Verified: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) throw new Error('SPIDemo test failed');
});

// 5. Test BusProbe
await runTest('BusProbe (Dual Bus I2C + SPI)', 'samples/busprobe.merged.bin', 'samples/busprobe.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(600);
    const cons = getConsole();
    const matched = cons.includes('bus-done');
    console.log(`Dual Bus Execution Completed ('bus-done'): ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) throw new Error('BusProbe test failed');
});

// 6. Test ST7789Demo
await runTest('Adafruit ST7789 Color TFT (240x240 RGB565)', 'samples/st7789_demo.merged.bin', 'samples/st7789_demo.elf', async ({ stepBatches, tft, getConsole }) => {
    let frameCount = 0;
    tft.onFrame(() => frameCount++);
    stepBatches(1500);
    console.log(`ST7789 Color TFT frames rendered: ${frameCount} -> ${frameCount >= 5 ? 'PASS' : 'FAIL'}`);
    if (frameCount < 5) throw new Error('ST7789Demo test failed');
});

// 7. Test NeoPixelDemo
await runTest('Adafruit NeoPixel 8-LED Strip (WS2812 RMT)', 'samples/neopixel_demo.merged.bin', 'samples/neopixel_demo.elf', async ({ stepBatches, neoPixel, getConsole }) => {
    let frameCount = 0;
    neoPixel.onFrame(() => frameCount++);
    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('Rainbow frame:') && frameCount >= 10;
    console.log(`NeoPixel color frames captured: ${frameCount} -> ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) throw new Error('NeoPixelDemo test failed');
});

// 8. Test SDCardDemo (Virtual SD Card FAT16 Filesystem)
await runTest('SDCardDemo (SPI Virtual SD Card FAT16)', 'samples/sdcard_demo.merged.bin', 'samples/sdcard_demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(3500);
    const cons = getConsole();
    const matched = cons.includes('SD Card Initialized Successfully!') && cons.includes('Hello from Virtual SD Card!') && cons.includes('sd-done');
    console.log(`SD Card Initialized & /README.TXT Read: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('SDCardDemo test failed');
    }
});

// 9. Test ADCPWMDemo (ADC Analog Input & PWM Duty Cycle)
await runTest('ADCPWMDemo (ADC analogRead & PWM analogWrite)', 'samples/adcpwm_demo.merged.bin', 'samples/adcpwm_demo.elf', async ({ stepBatches, adc, pwm, getConsole }) => {
    adc.setVoltage(0, 1.65); // 1.65V -> ~2048 raw, 1650 mV
    let pwmCount = 0;
    pwm.onActivity((act) => {
        if (act.type === 'pwm_update') pwmCount++;
    });
    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('Initial ADC Read: raw=2048, mv=1650 mV') &&
                    cons.includes('Duty=255 | ADC raw=2048 | 1650 mV') &&
                    cons.includes('adc-pwm-done') &&
                    pwmCount >= 5;
    console.log(`ADC Read (2048/1650mV) & PWM Updates (${pwmCount}): ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('ADCPWMDemo test failed');
    }
});

// 10. Test I2SDemo (I2S Digital Audio PCM output)
await runTest('I2SDemo (I2S Digital Audio 16kHz PCM)', 'samples/i2s_demo.merged.bin', 'samples/i2s_demo.elf', async ({ stepBatches, i2s, getConsole }) => {
    let capturedChunks = 0;
    i2s.onAudio((data) => {
        if (data.samples && data.samples.length > 0) capturedChunks++;
    });
    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('I2S driver installed successfully') &&
                    cons.includes('Wrote 512 bytes of audio PCM (ret=0x0)') &&
                    cons.includes('i2s-audio-done') &&
                    capturedChunks >= 1;
    console.log(`I2S Audio Output (chunks=${capturedChunks}): ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('I2SDemo test failed');
    }
});

// 11. Test TWAIDemo (TWAI / CAN Bus Controller ISO 11898-1)
await runTest('TWAIDemo (TWAI / CAN Bus Controller 500kbps)', 'samples/twai_demo.merged.bin', 'samples/twai_demo.elf', async ({ stepBatches, twai, getConsole }) => {
    let txFrames = [];
    twai.onActivity((act) => {
        if (act.type === 'tx') txFrames.push(act);
    });

    // Inject CAN packet ID=0x777 with data [CA, FE, BA, BE]
    twai.inject({ id: 0x777, extd: false, rtr: false, dlc: 4, data: [0xCA, 0xFE, 0xBA, 0xBE] });

    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('Driver started successfully') &&
                    cons.includes('Transmitted CAN frame ID=0x123 DLC=4 (res=0x0)') &&
                    cons.includes('Received CAN frame ID=0x777 DLC=4 Data=CA FE BA BE') &&
                    cons.includes('twai-bus-done') &&
                    txFrames.length >= 2;
    console.log(`TWAI CAN Bus TX (frames=${txFrames.length}) & RX (ID=0x777): ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('TWAIDemo test failed');
    }
});

// 12. Test NeoPixelDemo (fresh marker build)
await runTest('NeoPixelDemo (marker build)', 'samples/NeoPixelDemo.merged.bin', 'samples/NeoPixelDemo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1500);
    const cons = getConsole();
    const matched = cons.includes('[NeoPixel] NeoPixel strip initialized!');
    console.log(`NeoPixel marker: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('NeoPixelDemo test failed');
    }
});

// 13. Test OLEDDemo (fresh marker build)
await runTest('OLEDDemo (marker build)', 'samples/OLEDDemo.merged.bin', 'samples/OLEDDemo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1500);
    const cons = getConsole();
    const matched = cons.includes('[OLED] Display initialized successfully!') && cons.includes('[OLED] Splash frame sent.');
    console.log(`OLED markers: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('OLEDDemo test failed');
    }
});

// 14. Test ST7789Demo (fresh marker build)
await runTest('ST7789Demo (marker build)', 'samples/ST7789Demo.merged.bin', 'samples/ST7789Demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1500);
    const cons = getConsole();
    const matched = cons.includes('[TFT] ST7789 display initialized successfully!') && cons.includes('[TFT] Color splash screen rendered.');
    console.log(`ST7789 markers: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('ST7789Demo test failed');
    }
});

// 15. Test SDCardDemo (fresh marker build)
await runTest('SDCardDemo (marker build)', 'samples/SDCardDemo.merged.bin', 'samples/SDCardDemo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(4000);
    const cons = getConsole();
    const matched = cons.includes('[SD] before begin') && cons.includes('[SD] sd-done');
    console.log(`SD Card markers: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('SDCardDemo test failed');
    }
});

console.log('\n================================================================================');
console.log('ALL 15 REAL ARDUINO FIRMWARE TESTS PASSED (I2C + SPI + TFT + OLED + NEOPIXEL + SDCARD + ADC + PWM + I2S + TWAI + GPIO)! ✅');
console.log('================================================================================\n');


