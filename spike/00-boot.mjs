import { boot } from './harness.mjs';
const { emu, memory } = await boot({ chip: 'esp32c3' });
console.log('booted. pc=0x' + emu.pc().toString(16));
console.log('wasm memory bytes:', memory.buffer.byteLength);
let out = '';
for (let i = 0; i < 40; i++) out += emu.run_batch(50000);
console.log('--- ROM output ---');
console.log(JSON.stringify(out.slice(0, 600)));
console.log('pc=0x' + emu.pc().toString(16), 'cycles=' + emu.cycles());
