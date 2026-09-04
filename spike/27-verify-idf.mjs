// Verification suite for raw ESP-IDF driver shims (no Arduino HAL):
// idf-spi (spi_bus_initialize/add_device, spi_device_transmit/polling_transmit
// with pointer + inline tx_data paths), idf-i2c-v5 (transmit/receive/
// transmit_receive/probe) and idf-i2c-legacy convenience APIs
// (write_to/read_from_device) plus the legacy command-link API
// (i2c_master_cmd_begin, executed in-shim by walking the START/WRITE/READ/
// STOP node list). v5 and legacy live in separate sketches because real IDF
// aborts when both drivers initialize.
// Run: node spike/27-verify-idf.mjs
import { readFileSync } from 'node:fs';
import { Elf32, planHooks, prepareSpiShims, prepareIdfShims } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SPIBus, MPU6050Device, GenericSPIDevice } from '../peripherals.mjs';
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
        .concat(hookPlan?.spi?.hooks || []);

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
    }

    const i2cBus = new I2CBus();
    const spiBus = new SPIBus();
    const mpu = new MPU6050Device();
    i2cBus.register(0x68, mpu);

    const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

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
                        spiBus.write([]);
                        if ((body.charCodeAt(1) & 0x7f) === 64) emu.uart_input(new Uint8Array([0]));
                    } else if (body[0] === 'X') {
                        const hex = [...body.slice(3)].map(c => c.charCodeAt(0) - 97);
                        const bytes = [];
                        for (let j = 0; j + 1 < hex.length; j += 2) bytes.push((hex[j] << 4) | hex[j + 1]);
                        const replies = [];
                        for (const b of bytes) replies.push(spiBus.transferByte(b));
                        emu.uart_input(new Uint8Array(replies));
                    } else {
                        const txByte = (((body.charCodeAt(0) - 97) & 15) << 4) | ((body.charCodeAt(1) - 97) & 15);
                        emu.uart_input(new Uint8Array([spiBus.transferByte(txByte)]));
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
        getConsole: () => cleanConsole,
    });
}

// 1. IDF SPI: pointer + inline full-duplex against the XOR virtual bus.
await runTest('IDFSPIDemo (idf-spi transmit + polling)', 'samples/idfspi_demo.merged.bin', 'samples/idfspi_demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('bus_add_device rc=0') &&
        cons.includes('transmit OK') &&
        cons.includes('polling-inline OK') &&
        cons.includes('idf-spi-done');
    console.log(`IDF SPI pointer + inline duplex: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-600));
        throw new Error('IDFSPIDemo test failed');
    }
});

// 2. IDF I2C v5 against the virtual 0x68 MPU.
await runTest('IDFI2CDemo (idf-i2c-v5)', 'samples/idfi2c_demo.merged.bin', 'samples/idfi2c_demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('probe rc=0') &&
        cons.includes('v5 txrx') && cons.includes('DEADBE') &&
        cons.includes('transmit_receive rc=0') &&
        cons.includes('idf-i2c-done');
    console.log(`IDF I2C v5: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-600));
        throw new Error('IDFI2CDemo test failed');
    }
});

// 3. IDF legacy I2C convenience APIs + command-link API against the virtual
// 0x68 MPU (phase0 write_to/read_from_device, phase1 START+WRITE+START+
// WRITE+READ(n-1)+READ(1)+STOP via i2c_master_cmd_begin).
await runTest('IDFI2CLegacyDemo (idf-i2c-legacy)', 'samples/idfi2c_legacy_demo.merged.bin', 'samples/idfi2c_legacy_demo.elf', async ({ stepBatches, getConsole }) => {
    stepBatches(1000);
    const cons = getConsole();
    const matched = cons.includes('legacy wr=0 rd=0') &&
        cons.includes('DEADBE') &&
        cons.includes('cmdlink rc=0 got=DEADBE') &&
        cons.includes('idf-i2c-cmd-done') &&
        cons.includes('idf-i2c-legacy-done');
    console.log(`IDF legacy I2C: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-600));
        throw new Error('IDFI2CLegacyDemo test failed');
    }
});

console.log('\n================================================================================');
console.log('ALL IDF DRIVER TESTS PASSED (SPI + I2C-v5 + I2C-legacy)! ✅');
console.log('================================================================================\n');
