import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const mcu = await ESP32C3.create({ chip: 'esp32c6' });
const flash = new Uint8Array(readFileSync('samples/threaddemo_c6.merged.bin'));
const elf = new Uint8Array(readFileSync('samples/threaddemo_c6.elf'));
await mcu.loadFirmware(flash, elf);
let out = '';
let lastTx = 0;
let leaderAt = -1;
const N = parseInt(process.env.N || '100000', 10);
for (let i = 0; i < N; i++) {
    out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (leaderAt < 0 && /role=4/.test(out)) { leaderAt = i; console.log(`leader at batch ${i}`); }
    if (mcu.thread.txCount !== lastTx) {
        const f = mcu.thread.frames[mcu.thread.frames.length - 1];
        console.log(`batch ${i}: TX#${mcu.thread.txCount} len=${f.len} ${Buffer.from(f.psdu.slice(0, 10)).toString('hex')}`);
        lastTx = mcu.thread.txCount;
    }
    if (/Guru|panic|Assert/i.test(out)) break;
}
