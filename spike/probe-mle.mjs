import { readFileSync, writeFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const mcu = await ESP32C3.create({ chip: 'esp32c6' });
const flash = new Uint8Array(readFileSync('samples/threaddemo_c6.merged.bin'));
const elf = new Uint8Array(readFileSync('samples/threaddemo_c6.elf'));
await mcu.loadFirmware(flash, elf);
let out = '';
let lastTx = 0;
const frames63 = [];
const N = parseInt(process.env.N || '40000', 10);
for (let i = 0; i < N; i++) {
    out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (mcu.thread.txCount !== lastTx) {
        const f = mcu.thread.frames[mcu.thread.frames.length - 1];
        if (f.len === 63) {
            const hex = Buffer.from(f.psdu).toString('hex');
            frames63.push(hex);
            console.log(`TX#${mcu.thread.txCount} batch=${i} ${hex}`);
        } else {
            console.log(`TX#${mcu.thread.txCount} batch=${i} len=${f.len}`);
        }
        lastTx = mcu.thread.txCount;
    }
    if (/Guru|panic|Assert/i.test(out)) break;
}
writeFileSync('/tmp/mle63set.json', JSON.stringify(frames63));
console.log(`saved ${frames63.length} frames`);
