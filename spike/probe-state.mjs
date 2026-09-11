import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const SLOT_MPSDU = 0x50000180 + 32;
const mcu = await ESP32C3.create({ chip: process.env.CHIP || 'esp32c6' });
const base = (process.env.CHIP || 'esp32c6').replace('esp32', 'threaddemo_');
const flash = new Uint8Array(readFileSync(`samples/${base}.merged.bin`));
const elf = new Uint8Array(readFileSync(`samples/${base}.elf`));
await mcu.loadFirmware(flash, elf);
let out = '';
const N = parseInt(process.env.N || '60000', 10);
for (let i = 0; i < N; i++) {
    out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    if (/Guru|panic|Assert/i.test(out)) break;
}
const roles = [...new Set([...out.matchAll(/role=(\d+)/g)].map((m) => m[1]))].join(',');
console.log(`tx=${mcu.thread.txCount} scans=${mcu.thread.scanCount} roles=[${roles}] crash=${/Guru|panic|Assert/i.test(out)}`);
// find slot -> lin; telemetry at lin-0x154 (instance), lin-0x150 (mac0), lin-0x14f (mac1)
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
if (lin < 0) { console.log('no slot'); process.exit(0); }
const inst = dv.getUint32(lin - 0x154, true) >>> 0;
const mac0 = dv.getUint8(lin - 0x150);
const mac1 = dv.getUint8(lin - 0x14f);
console.log(`instance=0x${inst.toString(16)} mac0(state?)=${mac0} mac1(dwell?)=${mac1}`);
const polls = (out.match(/\[THREAD\] poll/g) || []).length;
const energies = (out.match(/energy-done/g) || []).length;
console.log(`polls=${polls} energydones=${energies} uartlen=${out.length}`);
console.log('--- uart tail ---');
console.log(out.slice(-1200));
console.log('done');
