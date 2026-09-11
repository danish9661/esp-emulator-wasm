import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const mcu = await ESP32C3.create({ chip: 'esp32h2' });
const flash = new Uint8Array(readFileSync('samples/threaddemo_h2.merged.bin'));
const elf = new Uint8Array(readFileSync('samples/threaddemo_h2.elf'));
await mcu.loadFirmware(flash, elf);
let out = '';
let lastTx = -1, lastCtr = -1, lin = -1, buf = null;
function findLin() {
    if (buf !== mcu.memory.buffer) { buf = mcu.memory.buffer; lin = -1; }
    if (lin >= 0) return lin;
    const u32 = new Uint32Array(buf);
    for (let i = 0; i < u32.length; i++) {
        if ((u32[i] >>> 0) === 0x54485244) {
            const len = new DataView(buf).getUint16(i * 4 - 156, true);
            if (len === 0) { lin = i * 4 - 160; return lin; }
        }
    }
    return -1;
}
for (let i = 0; i < 600; i++) {
    for (let k = 0; k < 20; k++) out += mcu.step(100000);
    if (out.length > 30000) out = out.slice(-30000);
    const l = findLin();
    let ctr = -1;
    if (l >= 0) {
        try { ctr = new DataView(mcu.memory.buffer).getUint32(l - 0x15C, true); } catch (_) {}
    }
    if (mcu.thread.txCount !== lastTx || ctr !== lastCtr || i % 60 === 0) {
        console.log(`batch~${i * 20}: tx=${mcu.thread.txCount} slot=${l >= 0 ? 'y' : 'n'} polls=${ctr}(+${lastCtr >= 0 && ctr >= 0 ? ctr - lastCtr : '?'})`);
        lastTx = mcu.thread.txCount; lastCtr = ctr;
    }
    if (/Guru|panic|Assert/i.test(out)) { console.log('CRASH'); break; }
}
console.log('done');
