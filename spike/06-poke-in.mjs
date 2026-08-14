// Poke one candidate offset and see whether the guest's GPIO_IN read changes.
// Guest prints low byte as two chars ('a'+nibble). Poking 0x5a should print "fk".
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const off = Number(process.argv[2]);
const fw = new Uint8Array(readFileSync(new URL('./readgpio.bin', import.meta.url)));
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });
for (let i = 0; i < 5; i++) emu.run_batch(2000);
const before = emu.run_batch(3000).trim().slice(-4);
const v = new DataView(memory.buffer);
v.setUint32(off, 0x5a, true);
const after = emu.run_batch(3000).trim().slice(-4);
const ok = after.includes('fk');
console.log(`0x${off.toString(16)}: before=${JSON.stringify(before)} after=${JSON.stringify(after)} ` +
            `${ok ? '>>> INJECTION WORKS' : 'no effect'}`);
