// Test SPI Master bridge end-to-end (AGENT.md Phase 4)
import { readFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SPIBus, SSD1306Device, MPU6050Device } from '../peripherals.mjs';
import { boot } from './harness.mjs';

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;

async function testSpiFirmware(name, binPath, elfPath) {
    console.log(`\n========================================`);
    console.log(`TESTING SPI FIRMWARE: ${name}`);
    console.log(`========================================`);

    const flash = new Uint8Array(readFileSync(binPath));
    const elf = new Elf32(readFileSync(elfPath));
    const hookPlan = planHooks(elf);
    console.log('Hook plan:', JSON.stringify(hookPlan, null, 2));

    const hooks = Object.fromEntries(
        (hookPlan?.i2c?.hooks || []).concat(hookPlan?.spi?.hooks || []).map(h => [h.name, h])
    );

    const img = new EspImage(flash);
    const patched = [];
    for (const [fn, shim] of Object.entries(SHIMS)) {
        if (hooks[fn] && shim.length <= hooks[fn].size) {
            img.writeAtVaddr(hooks[fn].addr, shim);
            patched.push(`${fn} (${shim.length}B)`);
        }
    }
    await img.reseal();
    console.log(`Patched shims: ${patched.join(', ')}`);

    const i2cBus = new I2CBus();
    const spiBus = new SPIBus();
    const oled = new SSD1306Device(128, 64);
    const mpu = new MPU6050Device();
    i2cBus.register(0x3c, oled);
    i2cBus.register(0x68, mpu);

    let spiTransactions = 0;
    spiBus.onActivity((act) => {
        spiTransactions++;
        console.log(`[SPI EVENT #${spiTransactions}] op=${act.op} data=${act.data.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')} reply=${act.reply.map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
    });

    const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

    let streamBuffer = '', cleanConsole = '';
    for (let i = 0; i < 600; i++) {
        const raw = emu.run_batch(50000);
        if (!raw) continue;
        streamBuffer += raw;

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
        if (cleanConsole.includes('spi-done') || cleanConsole.includes('bus-done')) break;
    }

    console.log('\n--- Clean Console Output ---');
    console.log(cleanConsole.slice(-300));
    console.log(`Total SPI transactions captured: ${spiTransactions}`);
    if (spiTransactions > 0) {
        console.log(`TEST ${name}: PASS ✅`);
    } else {
        throw new Error(`TEST ${name}: FAILED ❌`);
    }
}

// Run SPIDemo
await testSpiFirmware('SPIDemo', 'samples/spidemo.merged.bin', 'samples/spidemo.elf');

// Run BusProbe (both I2C + SPI)
await testSpiFirmware('BusProbe', 'samples/busprobe.merged.bin', 'samples/busprobe.elf');

console.log('\n========================================');
console.log('PHASE 4 SPI VERIFICATION COMPLETE! ✅');
console.log('========================================\n');
