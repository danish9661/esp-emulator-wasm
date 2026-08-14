// Read-only dump of the GPIO peripheral struct region.
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const which = process.argv[2] || 'blinkread';
const fw = new Uint8Array(readFileSync(new URL(`./${which}.bin`, import.meta.url)));
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });
for (let i = 0; i < 20; i++) emu.run_batch(2000);
const v = new DataView(memory.buffer);
console.log(`--- ${which}: 0x827820..0x8278a0 ---`);
for (let off = 0x827820; off < 0x8278a0; off += 16) {
    const cols = [0, 4, 8, 12].map(d => v.getUint32(off + d, true).toString(16).padStart(8, '0'));
    const tag = [0, 4, 8, 12].map(d => off + d === 0x827850 ? '<OUT' : off + d === 0x827858 ? '<EN' : '').join('');
    console.log('0x' + off.toString(16), cols.join(' '), tag);
}
