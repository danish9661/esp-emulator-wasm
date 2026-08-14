import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const fw = new Uint8Array(readFileSync(new URL('./hello.bin', import.meta.url)));
const { emu } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });
console.log('after load pc=0x' + emu.pc().toString(16));
let out = '';
for (let i = 0; i < 20; i++) out += emu.run_batch(10000);
console.log('output:', JSON.stringify(out));
console.log('pc=0x' + emu.pc().toString(16), 'cycles=' + emu.cycles());
