import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
// Replay a captured H2 Parent Request into a YOUNG C6 leader.
// If young-A answers (A.tx=3+), the issue is age/decay; else validity.
const REQ = Buffer.from('41d8a43412fffff4b94f71edc11b5e7f3b02f04d4c4d4c09740015000000000000000001781bf1599b7f0f35b0b1c401f95e268ba2fd7169e42416bfea0000', 'hex');
const SLOT_GUEST = 0x50000180;
const SLOT_MPSDU = SLOT_GUEST + 32;
const mcu = await ESP32C3.create({ chip: 'esp32c6' });
const flash = new Uint8Array(readFileSync('samples/threaddemo_c6.merged.bin'));
const elf = new Uint8Array(readFileSync('samples/threaddemo_c6.elf'));
await mcu.loadFirmware(flash, elf);
let out = '';
let leaderAt = -1;
for (let i = 0; i < 60000; i++) {
    out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (leaderAt < 0 && /role=4/.test(out)) { leaderAt = i; console.log(`leader at batch ${i} tx=${mcu.thread.txCount}`); break; }
    if (/Guru|panic|Assert/i.test(out)) break;
}
if (leaderAt < 0) { console.log('never leader'); process.exit(0); }
// find slot, stage H2 req
const buf = mcu.memory.buffer;
const dv = new DataView(buf);
const u32 = new Uint32Array(buf);
let lin = -1;
for (let i = 0; i < u32.length; i++) {
    if ((u32[i] >>> 0) === 0x54485244) {
        const l = i * 4 - 160;
        if (l >= 0 && dv.getUint16(l + 4, true) === 0 && (dv.getUint32(l, true) >>> 0) === SLOT_MPSDU) { lin = l; break; }
    }
}
console.log(`lin=0x${lin.toString(16)}`);
const u8 = new Uint8Array(mcu.memory.buffer);
const dv2 = new DataView(mcu.memory.buffer);
dv2.setUint32(lin, SLOT_GUEST + 32, true);
dv2.setUint16(lin + 4, REQ.length, true);
u8[lin + 6] = 15; u8[lin + 7] = 0;
dv2.setUint32(lin + 8, 0, true); dv2.setUint32(lin + 12, 0, true); dv2.setUint32(lin + 16, 0, true);
u8[lin + 20] = 0; u8[lin + 21] = 256 - 50; u8[lin + 22] = 200; u8[lin + 23] = 0;
u8.set(REQ, lin + 32);
dv2.setUint32(lin + 160, 0x54485244, true);
console.log(`staged H2 req at batch ${leaderAt}, watching A.tx (now ${mcu.thread.txCount})`);
let lastTx = mcu.thread.txCount;
for (let i = 0; i < 3000; i++) {
    for (let k = 0; k < 20; k++) out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (mcu.thread.txCount !== lastTx) {
        const f = mcu.thread.frames[mcu.thread.frames.length - 1];
        console.log(`batch~${i * 20}: TX#${mcu.thread.txCount} len=${f.len} ${Buffer.from(f.psdu.slice(0, 12)).toString('hex')}`);
        lastTx = mcu.thread.txCount;
    }
    if (/Guru|panic|Assert/i.test(out)) { console.log('CRASH'); break; }
}
console.log('done');
