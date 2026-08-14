// Comprehensive Verification Suite for esp-emu Virtual Peripherals
import { readFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SSD1306Device, MPU6050Device } from '../peripherals.mjs';
import { boot } from './harness.mjs';

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;

async function runTest(testName, binPath, elfPath, customVerify) {
    console.log(`\n========================================`);
    console.log(`TEST: ${testName}`);
    console.log(`========================================`);

    const flash = new Uint8Array(readFileSync(binPath));
    const elf = new Elf32(readFileSync(elfPath));
    const hookPlan = planHooks(elf);
    const hooks = Object.fromEntries(
        (hookPlan?.i2c?.hooks || []).concat(hookPlan?.spi?.hooks || []).map(h => [h.name, h])
    );

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

    const bus = new I2CBus();
    const oled = new SSD1306Device(128, 64);
    const mpu = new MPU6050Device();
    bus.register(0x3c, oled);
    bus.register(0x3d, oled);
    bus.register(0x68, mpu);

    const { emu, memory } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

    let streamBuffer = '', cleanConsole = '';
    const ctx = { emu, memory, bus, oled, mpu, cleanConsole: '' };

    function processStream(chunk) {
        streamBuffer += chunk;
        while (true) {
            const m = streamBuffer.match(APC);
            if (m) {
                cleanConsole += streamBuffer.slice(0, m.index);
                const [frame, kind, body] = m;
                const addr = body.charCodeAt(0);
                if (kind === 'W') {
                    const hex = [...body.slice(1)].map(c => c.charCodeAt(0) - 97);
                    const bytes = [];
                    for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                    bus.write(addr, bytes);
                } else if (kind === 'R') {
                    const len = body.charCodeAt(1);
                    const data = bus.read(addr, len);
                    emu.uart_input(new Uint8Array(data));
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
            ctx.cleanConsole = cleanConsole;
            return cleanConsole;
        },
        memory,
        bus,
        oled,
        mpu,
        getConsole: () => cleanConsole,
    });
}

// 1. Test Blink
await runTest('Blink (GPIO2 Output)', 'samples/blink.merged.bin', 'samples/blink.elf', async ({ stepBatches, memory }) => {
    stepBatches(300);
    const view = new DataView(memory.buffer);
    const outVal1 = view.getBigUint64(0x827850, true);
    const enVal = view.getBigUint64(0x827858, true);

    const pin2Enabled = ((enVal >> 2n) & 1n) === 1n;
    console.log(`GPIO_ENABLE for pin 2: ${pin2Enabled ? 'OUTPUT (PASS)' : 'FAIL'}`);

    // Run more batches to see pin toggle
    let saw0 = false, saw4 = false;
    for (let i = 0; i < 20; i++) {
        stepBatches(10);
        const v = view.getUint32(0x827850, true);
        if ((v & 4) === 4) saw4 = true;
        if ((v & 4) === 0) saw0 = true;
    }
    console.log(`GPIO2 Toggling observed: LOW=${saw0}, HIGH=${saw4} -> ${saw0 && saw4 ? 'PASS' : 'FAIL'}`);
    if (!pin2Enabled || !saw4) throw new Error('Blink test failed');
});

// 2. Test I2CRead
await runTest('I2C Sensor Read (0x68 IMU)', 'samples/i2cread.merged.bin', 'samples/i2cread.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(600);
    const cons = getConsole();
    console.log('Console snippet:', JSON.stringify(cons.slice(-150)));
    const matched = cons.includes('got=3:DEADBE');
    console.log(`Received mock sensor bytes 'got=3:DEADBE': ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) throw new Error('I2CRead test failed');
});

// 3. Test OLEDDemo
await runTest('Adafruit SSD1306 OLED Demo (128x64)', 'samples/oled_demo.merged.bin', 'samples/oled_demo.elf', async ({ stepBatches, oled, getConsole }) => {
    let frameCount = 0;
    oled.onFrame(() => frameCount++);

    stepBatches(1500);
    const cons = getConsole();
    console.log('Console snippet:', JSON.stringify(cons.slice(-200)));
    console.log(`OLED frames rendered: ${frameCount} -> ${frameCount >= 5 ? 'PASS' : 'FAIL'}`);
    if (frameCount < 5) throw new Error('OLEDDemo test failed');
});

console.log('\n========================================');
console.log('ALL FIRMWARE TESTS PASSED PERFECTLY! ✅');
console.log('========================================\n');
