// Phase 2 proof: locate i2cWrite via ELF symbols, overwrite its first 8 bytes with
// `li a0, 0 / ret`, re-seal the image, boot it, and observe the behaviour change.
import { readFileSync, writeFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';

const [elfPath, flashPath, outPath] = process.argv.slice(2);
const elf = new Elf32(readFileSync(elfPath));
const flash = new Uint8Array(readFileSync(flashPath));
const img = new EspImage(flash);

const hook = planHooks(elf).i2c.hooks.find(h => h.name === 'i2cWrite');
console.log(`i2cWrite  vaddr=0x${hook.addr.toString(16)}  imageOffset=0x${img.vaddrToOffset(hook.addr).toString(16)}`);

const before = flash.slice(img.vaddrToOffset(hook.addr), img.vaddrToOffset(hook.addr) + 8);
console.log('original bytes:', [...before].map(b => b.toString(16).padStart(2, '0')).join(' '));

//   addi a0, x0, 0   -> 0x00000513   (return ESP_OK)
//   jalr x0, x1, 0   -> 0x00008067   (ret)
const patch = new Uint8Array(8);
new DataView(patch.buffer).setUint32(0, 0x00000513, true);
new DataView(patch.buffer).setUint32(4, 0x00008067, true);
img.writeAtVaddr(hook.addr, patch);
console.log('patched bytes: ', [...patch].map(b => b.toString(16).padStart(2, '0')).join(' '));

console.log('verify before reseal:', await img.verify());
await img.reseal();
console.log('verify after  reseal:', await img.verify());
writeFileSync(outPath, flash);
console.log('wrote', outPath);
