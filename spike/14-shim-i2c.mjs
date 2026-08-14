// Phase 3 proof: replace i2cWrite's body with a shim that emits the transaction
// (address + payload) over UART0, then returns ESP_OK.
import { readFileSync, writeFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';

const [elfPath, flashPath, shimPath, outPath] = process.argv.slice(2);
const elf = new Elf32(readFileSync(elfPath));
const flash = new Uint8Array(readFileSync(flashPath));
const shim = new Uint8Array(readFileSync(shimPath));
const img = new EspImage(flash);

const hook = planHooks(elf).i2c.hooks.find(h => h.name === 'i2cWrite');
if (shim.length > hook.size) throw new Error(`shim ${shim.length}B exceeds i2cWrite ${hook.size}B`);
console.log(`i2cWrite: ${hook.size}B available, shim is ${shim.length}B -> fits in place`);

img.writeAtVaddr(hook.addr, shim);
await img.reseal();
console.log('resealed:', await img.verify());
writeFileSync(outPath, flash);
