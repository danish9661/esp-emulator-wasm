import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const SLOT_GUEST = 0x50000180;
const SLOT_MPSDU = SLOT_GUEST + 32;
const mcu = await ESP32C3.create({ chip: 'esp32c6' });
const flash = new Uint8Array(readFileSync('samples/threaddemo_c6.merged.bin'));
const elf = new Uint8Array(readFileSync('samples/threaddemo_c6.elf'));
await mcu.loadFirmware(flash, elf);
let out = '';
// wait until active-scan-done (idle: no more TXs to overwrite rxBase)
for (let i = 0; i < 3000; i++) {
    out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (out.includes('active-scan-done') || /Guru|panic|Assert/i.test(out)) break;
}
console.log(`tx=${mcu.thread.txCount} scansettled=${out.includes('active-scan-done')}`);
// find slot
const buf0 = mcu.memory.buffer;
const dv0 = new DataView(buf0);
const u320 = new Uint32Array(buf0);
let lin = -1;
for (let i = 0; i < u320.length; i++) {
    if ((u320[i] >>> 0) === 0x54485244) {
        const l = i * 4 - 160;
        if (l >= 0 && dv0.getUint16(l + 4, true) === 0 && (dv0.getUint32(l, true) >>> 0) === SLOT_MPSDU) { lin = l; break; }
    }
}
console.log(`lin=0x${lin.toString(16)}`);
// stage 100B pattern (data type -> eager poll delivery; no TXs running to race)
const u8 = new Uint8Array(mcu.memory.buffer);
const dv = new DataView(mcu.memory.buffer);
const pat = Uint8Array.from({ length: 100 }, (_, i) => (i * 7 + 3) & 0xff);
pat[0] = 0x41; pat[1] = 0xd8;
dv.setUint32(lin, SLOT_GUEST + 32, true);
dv.setUint16(lin + 4, 100, true);
u8[lin + 6] = 15; u8[lin + 7] = 0;
dv.setUint32(lin + 8, 0, true); dv.setUint32(lin + 12, 0, true); dv.setUint32(lin + 16, 0, true);
u8[lin + 20] = 0; u8[lin + 21] = 256 - 50; u8[lin + 22] = 200; u8[lin + 23] = 0;
u8.set(pat, lin + 32);
dv.setUint32(lin + 160, 0x54485244, true);
const ctrOfs = lin - 0x180 + 0x28;
const c0 = new DataView(mcu.memory.buffer).getUint32(ctrOfs, true) >>> 0;
let consumed = false;
for (let i = 0; i < 900; i++) {
    for (let k = 0; k < 20; k++) out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    const mg = new DataView(mcu.memory.buffer).getUint32(lin + 160, true) >>> 0;
    if (mg !== 0x54485244) { consumed = true; break; }
    if (/Guru|panic|Assert/i.test(out)) break;
}
console.log(`consumed=${consumed} tx=${mcu.thread.txCount}`);
if (consumed) {
    const rx = lin - 0x80;
    const ub = new Uint8Array(mcu.memory.buffer);
    const got = ub.slice(rx + 32, rx + 32 + 100);
    let bad = 0, firstBad = -1, lastBad = -1;
    for (let i = 0; i < 100; i++) {
        if (got[i] !== pat[i]) { bad++; if (firstBad < 0) firstBad = i; lastBad = i; }
    }
    console.log(`mismatch: ${bad}/100 firstBad=${firstBad} lastBad=${lastBad}`);
    console.log('want: ' + Buffer.from(pat).toString('hex'));
    console.log('got : ' + Buffer.from(got).toString('hex'));
}
console.log('done');
