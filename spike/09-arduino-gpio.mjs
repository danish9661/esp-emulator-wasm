// Boot real Arduino firmware; find words that alternate exactly 0x4 <-> 0x0 (GPIO2 blink).
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';

const fw = new Uint8Array(readFileSync(process.argv[3] || 'spike/build/Blink/Blink.ino.bin'));
const romBoot = process.argv[2] === 'rom';
const { emu, memory } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: romBoot });
console.log('bootFromRom =', romBoot, ' entry pc=0x' + emu.pc().toString(16));

let serial = '';
for (let i = 0; i < 400; i++) serial += emu.run_batch(50000);
console.log('serial:', JSON.stringify(serial.slice(-200)));
console.log('pc=0x' + emu.pc().toString(16), 'cycles=' + emu.cycles());

const words = memory.buffer.byteLength >>> 2;
const saw4 = new Uint8Array(words), saw0 = new Uint8Array(words), other = new Uint8Array(words);
for (let s = 0; s < 24; s++) {
    for (let i = 0; i < 10; i++) emu.run_batch(50000);
    const u = new Uint32Array(memory.buffer);
    for (let i = 0; i < words; i++) {
        const v = u[i];
        if (v === 4) saw4[i] = 1; else if (v === 0) saw0[i] = 1; else other[i] = 1;
    }
}
const hits = [];
for (let i = 0; i < words; i++) if (saw4[i] && saw0[i] && !other[i]) hits.push(i * 4);
console.log(`words alternating 0x4/0x0: ${hits.length}`);
console.log(hits.slice(0, 12).map(h => '0x' + h.toString(16)).join(' '));
console.log('0x827850 included?', hits.includes(0x827850));
