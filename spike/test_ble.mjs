import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const DIR = 'spike/sketches/BLEDemo/build/esp32.esp32.esp32c3';
const flash = new Uint8Array(readFileSync(`${DIR}/BLEDemo.ino.merged.bin`));
const elf = new Uint8Array(readFileSync(`${DIR}/BLEDemo.ino.elf`));

const mcu = await ESP32C3.create({ chip: 'esp32c3' });
const patch = await mcu.loadFirmware(flash, elf);
console.log('patched:', patch.patched.join(', '));

let out = '';
mcu.uart0.onData(t => { out += t; });

const MAX = 4000;
let done = false;
for (let i = 0; i < MAX; i++) {
  mcu.step(20000);
  if (out.includes('[BLE] ble-done') || out.includes('Guru Meditation')) { done = true; break; }
}
console.log('--- UART OUTPUT ---');
console.log(out);
console.log('--- cycles:', mcu.cycles, 'pc: 0x'+mcu.pc.toString(16), '---');
console.log(out.includes('[BLE] ble-done') ? 'RESULT: BLE RAN ✅' : (out.includes('Guru Meditation') ? 'RESULT: CRASH ❌' : 'RESULT: NO-COMPLETION (timed out) ⚠️'));
