// Find GPIO_IN by poking words near the GPIO struct and watching what the guest reads.
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';

const fw = new Uint8Array(readFileSync(new URL('./readgpio.bin', import.meta.url)));
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });

for (let i = 0; i < 5; i++) emu.run_batch(2000);
const baseline = emu.run_batch(4000);
console.log('baseline guest reads:', JSON.stringify(baseline.slice(0, 12)), '(aa = 0x00)');

const view = new DataView(memory.buffer);
const MAGIC = 0x5a;
const hits = [];
for (let off = 0x827800; off < 0x827900; off += 4) {
    const saved = view.getUint32(off, true);
    view.setUint32(off, MAGIC, true);
    const out = emu.run_batch(4000);
    if (out.includes('fk')) hits.push(off);       // 0x5a -> 'f','k'
    view.setUint32(off, saved, true);
}
console.log('offsets where a poke changed what the guest reads:', hits.map(h => '0x' + h.toString(16)));
