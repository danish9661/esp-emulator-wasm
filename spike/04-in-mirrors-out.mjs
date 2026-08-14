import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const fw = new Uint8Array(readFileSync(new URL('./blinkread.bin', import.meta.url)));
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });
let out = '';
for (let i = 0; i < 30; i++) out += emu.run_batch(2000);
console.log('guest GPIO_IN reads (alternating drive high/low):');
console.log(' ', out.trim().split(/\s+/).slice(0, 16).join(' '));
const v = new DataView(memory.buffer);
console.log('OUT@0x827850 =', '0x' + v.getUint32(0x827850, true).toString(16),
            ' mirror@0x822280 =', '0x' + v.getUint32(0x822280, true).toString(16));
