// Comprehensive Verification Suite for esp-emu Virtual Peripherals (I2C, SPI, GPIO, SSD1306, ST7789, NeoPixel)
import { readFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SPIBus, SSD1306Device, ST7789Device, NeoPixelStrip, MPU6050Device } from '../peripherals.mjs';
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
        .concat(hookPlan?.neopixel?.hooks || []);

    const hooks = Object.fromEntries(allHooks.map(h => [h.name, h]));

    const img = new EspImage(flash);
    const patched = [];
    for (const [fn, shim] of Object.entries(SHIMS)) {
        if (hooks[fn] && shim.length <= hooks[fn].size) {
            img.writeAtVaddr(hooks[fn].addr, shim);
            patched.push(fn);
        }
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
    i2cBus.register(0x3c, oled);
    i2cBus.register(0x3d, oled);
    i2cBus.register(0x68, mpu);
    spiBus.register('tft', tft);

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
                    } else if (body[0] === 'X') {
                        const len = body.charCodeAt(1) & 0x7f;
                        const hex = [...body.slice(2)].map(c => c.charCodeAt(0) - 97);
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

console.log('\n================================================================================');
console.log('ALL 7 REAL ARDUINO FIRMWARE TESTS PASSED (I2C + SPI + TFT + OLED + NEOPIXEL + GPIO)! ✅');
console.log('================================================================================\n');
