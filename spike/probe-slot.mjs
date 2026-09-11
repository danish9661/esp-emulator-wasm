import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const mcu = await ESP32C3.create({ chip: 'esp32c6' });
const flash = new Uint8Array(readFileSync('samples/threaddemo_c6.merged.bin'));
const elf = new Uint8Array(readFileSync('samples/threaddemo_c6.elf'));
await mcu.loadFirmware(flash, elf);
let out = '';
const N = parseInt(process.env.N || '60000', 10);
for (let i = 0; i < N; i++) {
    out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (/Guru|panic|Assert/i.test(out)) break;
}
const roles = [...new Set([...out.matchAll(/role=(\d+)/g)].map((m) => m[1]))].join(',');
console.log(`tx=${mcu.thread.txCount} scans=${mcu.thread.scanCount} roles=[${roles}]`);
const buf = mcu.memory.buffer;
const u32 = new Uint32Array(buf);
const dv = new DataView(buf);
const hits = [];
for (let i = 0; i < u32.length; i++) {
    if ((u32[i] >>> 0) === 0x54485244) {
        const off = i * 4;
        let len = -1;
        try { len = dv.getUint16(off - 156, true); } catch (_) {}
        hits.push(`off=0x${off.toString(16)} lenword=${len}`);
        if (hits.length > 12) break;
    }
}
console.log(`magic hits (${hits.length}):`);
for (const h of hits) console.log('  ' + h);
// dump known slot lin 0x3a0198 region
const LIN = 0x3a0198;
try {
    const u8 = new Uint8Array(buf);
    const words = [];
    for (let o = -8; o < 172; o += 4) words.push(dv.getUint32(LIN + o, true).toString(16).padStart(8, '0'));
    console.log(`slot region dump lin=0x${LIN.toString(16)}:`);
    console.log('  ' + words.slice(0, 8).join(' '));
    console.log('  ' + words.slice(8, 16).join(' '));
    console.log('  magic@+160: ' + words[42] + ' len@+4: ' + dv.getUint16(LIN + 4, true));
    void u8;
} catch (e) { console.log('dump failed: ' + e.message); }
