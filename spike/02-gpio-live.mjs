// Watch candidate offsets while firmware blinks GPIO2.
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';

const CANDIDATES = [0xffc04, 0xffc34, 0xffc6c, 0x7e8c7c, 0x822280, 0x827850, 0x827858];
const fw = new Uint8Array(readFileSync(new URL('./blink.bin', import.meta.url)));
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });

const seen = new Map(CANDIDATES.map(o => [o, new Set()]));
for (let i = 0; i < 60; i++) {
    emu.run_batch(400);
    const view = new DataView(memory.buffer);
    for (const off of CANDIDATES) seen.get(off).add(view.getUint32(off, true));
}
console.log('offset      distinct values observed');
for (const [off, vals] of seen) {
    const v = [...vals].map(x => '0x' + x.toString(16));
    console.log('0x' + off.toString(16).padStart(7) + '  ' + (v.length > 6 ? `${v.length} values (noisy)` : v.join(', ')));
}
