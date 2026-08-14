// Phase 3: full I2C round trip. Patches i2cWrite + i2cRead, then acts as the host
// bus model — parsing requests off UART and answering reads via uart_input().
import { readFileSync, writeFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { boot } from './harness.mjs';

const name = 'I2CRead';
const elf = new Elf32(readFileSync(`spike/build/${name}/${name}.ino.elf`));
const flash = new Uint8Array(readFileSync(`spike/build/${name}/${name}.ino.merged.bin`));
const img = new EspImage(flash);
const hooks = Object.fromEntries(planHooks(elf).i2c.hooks.map(h => [h.name, h]));

for (const [fn, blob] of [['i2cWrite', 'shim_i2cwrite.bin'], ['i2cRead', 'shim_i2cread.bin']]) {
    const shim = new Uint8Array(readFileSync(`spike/${blob}`));
    if (shim.length > hooks[fn].size) throw new Error(`${fn}: shim ${shim.length}B > ${hooks[fn].size}B`);
    img.writeAtVaddr(hooks[fn].addr, shim);
    console.log(`patched ${fn.padEnd(9)} ${shim.length}/${hooks[fn].size} bytes`);
}
await img.reseal();
writeFileSync(`spike/build/${name}/shimmed.bin`, flash);

// --- host-side virtual bus ---------------------------------------------------
const DEVICE_DATA = [0xde, 0xad, 0xbe];          // what our fake 0x68 device returns
const nib = c => c.charCodeAt(0) - 97;
const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

let pending = '', serial = '', answered = 0;
for (let i = 0; i < 700; i++) {
    const chunk = emu.run_batch(50000);
    if (!chunk) continue;
    serial += chunk;
    pending += chunk;

    // request frame: "#R<addr:2><len:2>\n"
    const m = pending.match(/#R(..)(..)\n/);
    if (m) {
        const addr = nib(m[1][0]) << 4 | nib(m[1][1]);
        const len = nib(m[2][0]) << 4 | nib(m[2][1]);
        console.log(`\n>>> guest requests READ addr=0x${addr.toString(16)} len=${len}`);
        console.log(`<<< host answers ${DEVICE_DATA.map(b => b.toString(16)).join(' ')}`);
        emu.uart_input(new Uint8Array(DEVICE_DATA.slice(0, len)));
        pending = pending.slice(m.index + m[0].length);
        answered++;
    }
}
console.log('\n--- serial tail ---');
console.log(serial.slice(-260));
console.log(`\nrequests answered: ${answered}`);
