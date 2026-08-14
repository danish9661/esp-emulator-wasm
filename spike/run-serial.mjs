// Boot a merged flash image through ROM and print serial output.
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const fw = new Uint8Array(readFileSync(process.argv[2]));
const { emu } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: true });
let out = '';
for (let i = 0; i < Number(process.argv[3] || 600); i++) out += emu.run_batch(50000);
console.log(out.slice(-1500));
console.log('--- pc=0x' + emu.pc().toString(16), 'cycles=' + emu.cycles());
