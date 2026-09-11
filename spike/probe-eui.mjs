import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
const chip = process.env.CHIP || 'esp32c6';
const base = process.env.BASE || 'threaddemo_c6';
const dir = process.env.THDIR || 'samples';
const mcu = await ESP32C3.create({ chip });
const flash = new Uint8Array(readFileSync(`${dir}/${base}.merged.bin`));
const elf = new Uint8Array(readFileSync(`${dir}/${base}.elf`));
await mcu.loadFirmware(flash, elf);
let out = '';
for (let i = 0; i < parseInt(process.env.N || '8000', 10); i++) {
    out += mcu.step(100000);
    const mle = mcu.thread.frames.find((f) => f.len > 20);
    if (mle) {
        console.log(`EXT(${chip}):`, Buffer.from(mle.psdu.slice(7, 15)).toString('hex'));
        break;
    }
    if (/Guru|panic|Assert/i.test(out)) break;
}
