// Boot a firmware, run a fixed number of cycles, dump wasm linear memory.
// Usage: node dump-mem.mjs <firmware.bin> <out.raw> [batches]
import { readFileSync, writeFileSync } from 'node:fs';
import { boot } from './harness.mjs';

const [fw, out, batches = '10'] = process.argv.slice(2);
const image = new Uint8Array(readFileSync(fw));
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: image, bootFromRom: false });
for (let i = 0; i < Number(batches); i++) emu.run_batch(5000);
writeFileSync(out, Buffer.from(memory.buffer));
console.error(`${fw}: pc=0x${emu.pc().toString(16)} cycles=${emu.cycles()} mem=${memory.buffer.byteLength}`);
