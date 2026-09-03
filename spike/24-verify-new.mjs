// Verification suite for newly virtualized peripherals:
// Touch (T), DAC (D), SDMMC 4-bit (M), Camera (F), LCD panel (L).
// Mirrors spike/18-verify-all.mjs: patches real Arduino firmware with RV32
// shims, boots headless, routes APC frames to virtual devices, asserts
// firmware-printed markers. Run: node spike/24-verify-new.mjs
import { readFileSync } from 'node:fs';
import { Elf32, planHooks, prepareSpiShims, prepareIdfShims } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import {
    VirtualTouch, VirtualDAC, VirtualSDMMC, VirtualCamera, VirtualLcdPanel,
} from '../peripherals.mjs';
import { ReplyDribbler } from '../reply_queue.mjs';
import { boot } from './harness.mjs';

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;

function nibbleVal(ch) {
    return (ch.charCodeAt(0) - 97) & 0xF;
}

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

    const touch = new VirtualTouch();
    const dac = new VirtualDAC();
    const sdmmc = new VirtualSDMMC();
    const camera = new VirtualCamera();
    const lcd = new VirtualLcdPanel(240, 240);
    // Paced host->firmware replies (HW RX FIFO drops large bursts).
    const dribbler = new ReplyDribbler();
    const pump = () => dribbler.pump((b) => emu.uart_input(b));

    const { emu, memory } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

    let streamBuffer = '', cleanConsole = '';

    function processStream(chunk) {
        pump(); // flush previously queued replies (polling shims are silent)
        streamBuffer += chunk;
        while (true) {
            const m = streamBuffer.match(APC);
            if (m) {
                cleanConsole += streamBuffer.slice(0, m.index);
                const [frame, kind, body] = m;
                if (kind === 'T') {
                    const pin = body.charCodeAt(0) & 0x7F;
                    const raw = touch.read(pin);
                    emu.uart_input(new Uint8Array([(raw >> 8) & 0xFF, raw & 0xFF]));
                } else if (kind === 'D') {
                    const pin = body.charCodeAt(0) & 0x7F;
                    const value = (((body.charCodeAt(1) - 97) & 0xF) << 4) | ((body.charCodeAt(2) - 97) & 0xF);
                    dac.write(pin, value);
                } else if (kind === 'M') {
                    const op = body[0];
                    let lba = 0;
                    for (let i = 1; i <= 8; i++) lba = (lba << 4) | nibbleVal(body[i]);
                    let count = 0;
                    for (let i = 9; i <= 12; i++) count = (count << 4) | nibbleVal(body[i]);
                    count = Math.max(0, Math.min(64, count));
                    if (op === 'R') {
                        dribbler.push(sdmmc.readSectors(lba >>> 0, count));
                    } else if (op === 'W') {
                        // Chunked writes (see shim_sdmmc_write).
                        const bytes = [];
                        for (let i = 13; i + 1 < body.length; i += 2) {
                            bytes.push((nibbleVal(body[i]) << 4) | nibbleVal(body[i + 1]));
                        }
                        sdmmc.writeChunk(lba >>> 0, count, new Uint8Array(bytes));
                    }
                } else if (kind === 'F') {
                    let off = 0;
                    for (let i = 0; i < 8; i++) off = (off << 4) | nibbleVal(body[i]);
                    let count = 0;
                    for (let i = 8; i < 12; i++) count = (count << 4) | nibbleVal(body[i]);
                    count = Math.max(0, Math.min(1024, count));
                    const fr = camera.readBand(off >>> 0, count);
                    const out = new Uint8Array(4 + fr.length);
                    out[0] = (fr.length >>> 24) & 0xFF;
                    out[1] = (fr.length >>> 16) & 0xFF;
                    out[2] = (fr.length >>> 8) & 0xFF;
                    out[3] = fr.length & 0xFF;
                    out.set(fr, 4);
                    dribbler.push(out);
                } else if (kind === 'L') {
                    const rd16 = (o) => (nibbleVal(body[o]) << 12) | (nibbleVal(body[o + 1]) << 8) | (nibbleVal(body[o + 2]) << 4) | nibbleVal(body[o + 3]);
                    const x1 = rd16(0), y1 = rd16(4), x2 = rd16(8), y2 = rd16(12);
                    let len = 0;
                    for (let i = 16; i < 24; i++) len = (len << 4) | nibbleVal(body[i]);
                    len = Math.max(0, Math.min(240 * 240 * 2, len));
                    const bytes = new Uint8Array(len);
                    for (let i = 0, o = 24; i < len && o + 1 < body.length; i++, o += 2) {
                        bytes[i] = (nibbleVal(body[o]) << 4) | nibbleVal(body[o + 1]);
                    }
                    lcd.drawBitmap(x1, y1, x2, y2, bytes);
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
        pump(); // release newly queued reply bytes in the same batch
    }

    await customVerify({
        stepBatches: (count, size = 50000) => {
            for (let i = 0; i < count; i++) {
                const raw = emu.run_batch(size);
                if (raw) {
                    processStream(raw);
                } else {
                    pump(); // keep dribbled replies flowing on silent batches
                }
            }
            return cleanConsole;
        },
        memory,
        touch,
        dac,
        sdmmc,
        camera,
        lcd,
        getConsole: () => cleanConsole,
    });
}

// 1. Touch: released pad reads 1200, touched pad reads 300.
await runTest('TouchDemo (virtual touch pad)', 'samples/touch_demo.merged.bin', 'samples/touch_demo.elf', async ({ stepBatches, touch, getConsole }) => {
    stepBatches(600);
    let cons = getConsole();
    const released = cons.includes('initial raw=1200');
    console.log(`Released pad reads 1200: ${released ? 'PASS' : 'FAIL'}`);
    if (!released) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('TouchDemo released test failed');
    }
    touch.setTouched(4, true);
    stepBatches(400);
    cons = getConsole();
    const touched = cons.includes('raw=300') && cons.includes('touch-done');
    console.log(`Touched pad reads 300 + touch-done: ${touched ? 'PASS' : 'FAIL'}`);
    if (!touched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('TouchDemo touched test failed');
    }
});

// 2. DAC: 8-bit writes map to 0..3.3V, final level 255 latched.
await runTest('DACDemo (virtual DAC output)', 'samples/dac_demo.merged.bin', 'samples/dac_demo.elf', async ({ stepBatches, dac, getConsole }) => {
    let updates = 0;
    dac.onActivity((act) => {
        if (act.type === 'dac_update') updates++;
    });
    stepBatches(800);
    const cons = getConsole();
    const ch = dac.getChannel(25);
    const matched = cons.includes('dac-done') && updates >= 5 && ch.value === 255;
    console.log(`DAC writes (${updates}) latched 255 (~3.30V=${ch.voltage.toFixed(2)}V): ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('DACDemo test failed');
    }
});

// 3. SDMMC: VBR signature, FAT README content, sector writeback.
await runTest('SDMMCDemo (virtual SDMMC 4-bit)', 'samples/sdmmc_demo.merged.bin', 'samples/sdmmc_demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1500);
    const cons = getConsole();
    const matched = cons.includes('vbr rc=0 sig=OK') &&
        cons.includes('Hello from Virtual SD Card!') &&
        cons.includes('writeback=OK') &&
        cons.includes('sdmmc-done');
    console.log(`VBR sig + FAT README + writeback: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-600));
        throw new Error('SDMMCDemo test failed');
    }
});

// 4. Camera: 96x96 gray frame, length + checksum verified against model.
await runTest('CameraDemo (virtual camera frame)', 'samples/camera_demo.merged.bin', 'samples/camera_demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1500);
    const cons = getConsole();
    // Recompute the expected test-pattern checksum (must match VirtualCamera).
    const w = 96, h = 96;
    let sum = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const bar = ((x >> 3) & 1) ? 0x70 : 0x00;
            sum += ((((x * 255) / (w - 1)) | 0) ^ bar ^ ((y * 31) & 0xff)) & 0xff;
        }
    }
    const expect = `frame len=9216 sum=${sum & 0xFFFF}`;
    const matched = cons.includes(expect) && cons.includes('cam-done');
    console.log(`Camera frame (${expect}): ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('CameraDemo test failed');
    }
});

// 5. LCD: three RGB565 blits land on the virtual panel.
await runTest('LCDDemo (virtual LCD panel)', 'samples/lcd_demo.merged.bin', 'samples/lcd_demo.elf', async ({ stepBatches, lcd, getConsole }) => {
    stepBatches(2500);
    const cons = getConsole();
    // Red bar occupies rows 0..39 at full width: check a pixel is pure red.
    const idx = (20 * 240 + 120) * 4;
    const px = lcd.rgbaBuffer;
    const isRed = px[idx] > 200 && px[idx + 1] < 60 && px[idx + 2] < 60;
    const matched = cons.includes('lcd-done') && lcd.drawCount >= 3 && isRed;
    console.log(`LCD draws=${lcd.drawCount} red pixel check: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('LCDDemo test failed');
    }
});

console.log('\n================================================================================');
console.log('ALL 5 NEW-PERIPHERAL FIRMWARE TESTS PASSED (TOUCH + DAC + SDMMC + CAMERA + LCD)! ✅');
console.log('================================================================================\n');
