// Phase 3 complete: APC-framed I2C bridge. Console output stays clean because
// terminals discard APC strings; the host parses them out of the same stream.
import { readFileSync, writeFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { boot } from './harness.mjs';

const name = process.argv[2] || 'I2CRead';
const elf = new Elf32(readFileSync(`spike/build/${name}/${name}.ino.elf`));
const flash = new Uint8Array(readFileSync(`spike/build/${name}/${name}.ino.merged.bin`));
const img = new EspImage(flash);
const hooks = Object.fromEntries(planHooks(elf).i2c.hooks.map(h => [h.name, h]));

for (const [fn, blob] of [['i2cWrite', 'shim_i2cwrite.bin'], ['i2cRead', 'shim_i2cread.bin']]) {
    if (!hooks[fn]) continue;
    const shim = new Uint8Array(readFileSync(`spike/${blob}`));
    if (shim.length > hooks[fn].size) throw new Error(`${fn}: shim ${shim.length}B > ${hooks[fn].size}B`);
    img.writeAtVaddr(hooks[fn].addr, shim);
    console.log(`patched ${fn.padEnd(9)} ${String(shim.length).padStart(3)}/${hooks[fn].size} bytes`);
}
await img.reseal();
writeFileSync(`spike/build/${name}/shimmed-apc.bin`, flash);

const DEVICE = { 0x68: [0xde, 0xad, 0xbe] };
const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;
let pending = '', console_ = '';
for (let i = 0; i < 700; i++) {
    const chunk = emu.run_batch(50000);
    if (!chunk) continue;
    pending += chunk;
    let m;
    while ((m = pending.match(APC))) {
        const [frame, kind, body] = m;
        const addr = body.charCodeAt(0);
        if (kind === 'W') {
            const hex = [...body.slice(1)].map(c => c.charCodeAt(0) - 97);
            const bytes = [];
            for (let j = 0; j + 1 < hex.length; j += 2) bytes.push(hex[j] << 4 | hex[j + 1]);
            console.log(`  I2C WRITE 0x${addr.toString(16)} <- ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        } else if (kind === 'R') {
            const len = body.charCodeAt(1);
            const data = (DEVICE[addr] || []).slice(0, len);
            console.log(`  I2C READ  0x${addr.toString(16)} -> ${data.map(b => b.toString(16).padStart(2, '0')).join(' ')} (${len} requested)`);
            emu.uart_input(new Uint8Array(data));
        }
        console_ += pending.slice(0, m.index);       // everything outside the frame
        pending = pending.slice(m.index + frame.length);
    }
}
console_ += pending;
console.log('\n--- console (APC frames stripped) ---');
console.log(console_.slice(-200));
console.log('--- raw APC bytes leaked into console? ---', /\x1b_/.test(console_) ? 'YES' : 'no');
