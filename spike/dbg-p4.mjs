import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS, relocateShimsForChip } from '../shims.mjs';
import { prepareSpiShims } from '../elf.mjs';

// 1. Build the patched image the SDK would produce
const elfBuf = new Uint8Array(readFileSync('samples/p4/ADCPWMDemo.elf'));
const elf = new Elf32(elfBuf);
const hookPlan = planHooks(elf);
const allHooks = []
    .concat(hookPlan?.i2c?.hooks || [])
    .concat(hookPlan?.spi?.hooks || [])
    .concat(hookPlan?.neopixel?.hooks || [])
    .concat(hookPlan?.adc?.hooks || [])
    .concat(hookPlan?.pwm?.hooks || [])
    .concat(hookPlan?.i2s?.hooks || [])
    .concat(hookPlan?.twai?.hooks || []);
const hooks = Object.fromEntries(allHooks.map(h => [h.name, h]));
const effectiveShims = prepareSpiShims(elf, relocateShimsForChip(SHIMS, 'esp32p4'));
const img = new EspImage(new Uint8Array(readFileSync('samples/p4/ADCPWMDemo.merged.bin')));
for (const [fn, shim] of Object.entries(effectiveShims)) {
    if (hooks[fn] && shim.length <= hooks[fn].size) {
        img.writeAtVaddr(hooks[fn].addr, shim);
        console.log('patched', fn, 'at 0x' + hooks[fn].addr.toString(16), '-> shim head:', Array.from(shim.slice(0, 8)).join(','));
    }
}
await img.reseal();
const patched = img.buffer;

// 2. Boot with the patched image, then inspect what the emulator's flash contains
const mcu = await ESP32C3.create({ chip: 'esp32p4', bootFromRom: true });
await mcu.loadFirmware(patched);

// find linear mapping of flash: search linear memory for the "Starting ADC" string
const needle = Buffer.from('[ADC/PWM] Starting');
const mem = new Uint8Array(mcu.memory.buffer);
let hits = [];
for (let i = 0; i < mem.length - needle.length; i++) {
    if (mem[i] === needle[0] && mem[i+1] === needle[1] && mem[i+2] === needle[2] && mem[i+3] === needle[3]) hits.push(i);
}
console.log('linear hits for "[ADC/PWM] Starting":', hits.map(h => '0x' + h.toString(16)).join(', '));

// 3. The patched analogRead is at flash offset 0x30df4 (vaddr 0x40000df4)
// For each linear hit, compute candidate flash base and check the analogRead bytes
for (const hit of hits) {
    console.log('candidate flash base 0x' + (hit - 0x10000).toString(16));
}
// The string is at vaddr ~0x4002xxxx? find string vaddr in ELF
let strOff = -1;
for (const s of elf.sections) {
    if (s.name === '.flash.rodata' || s.name === '.flash.text') {
        const rel = s.data.indexOf(needle);
        if (rel >= 0) { strOff = s.addr + rel; break; }
    }
}
console.log('string vaddr: 0x' + (strOff >= 0 ? strOff.toString(16) : 'n/a'));
if (strOff >= 0 && hits.length) {
    const flashBase = hits[0] - (strOff - 0x40000000);
    console.log('flash linear base: 0x' + flashBase.toString(16));
    const analogReadLin = flashBase + (0x40000df4 - 0x40000000);
    console.log('emulator flash bytes at analogRead (linear 0x' + analogReadLin.toString(16) + '):',
        Array.from(mem.slice(analogReadLin, analogReadLin + 8)).join(','));
}