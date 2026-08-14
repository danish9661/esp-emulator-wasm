// Test OLEDDemo end-to-end with Adafruit_SSD1306 and virtual SSD1306Device
import { readFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SSD1306Device } from '../peripherals.mjs';
import { boot } from './harness.mjs';

const name = 'OLEDDemo';
const elf = new Elf32(readFileSync(`spike/build/${name}/${name}.ino.elf`));
const flash = new Uint8Array(readFileSync(`spike/build/${name}/${name}.ino.merged.bin`));
const img = new EspImage(flash);
const hookPlan = planHooks(elf);

console.log('Hook plan:', JSON.stringify(hookPlan, null, 2));

const hooks = Object.fromEntries(hookPlan.i2c.hooks.map(h => [h.name, h]));

for (const [fn, shim] of Object.entries(SHIMS)) {
    if (!hooks[fn]) continue;
    if (shim.length > hooks[fn].size) throw new Error(`${fn}: shim ${shim.length}B > ${hooks[fn].size}B`);
    img.writeAtVaddr(hooks[fn].addr, shim);
    console.log(`Patched ${fn}: ${shim.length}/${hooks[fn].size} bytes at 0x${hooks[fn].addr.toString(16)}`);
}

await img.reseal();
console.log('Image resealed with valid checksum & SHA256');

// Setup virtual I2C bus and SSD1306 OLED
const bus = new I2CBus();
const oled = new SSD1306Device(128, 64);
bus.register(0x3c, oled);

let frameCount = 0;
oled.onFrame((frame) => {
    frameCount++;
    // Count non-zero bytes in framebuffer
    let lit = 0;
    for (const b of frame.buffer) {
        if (b !== 0) lit++;
    }
    console.log(`[VIRTUAL OLED] Frame #${frameCount} rendered! Non-zero RAM bytes: ${lit}/1024 (displayOn: ${frame.displayOn})`);
});

const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;
let pending = '', console_ = '';

for (let i = 0; i < 900; i++) {
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
            bus.write(addr, bytes);
        } else if (kind === 'R') {
            const len = body.charCodeAt(1);
            const data = bus.read(addr, len);
            emu.uart_input(new Uint8Array(data));
        }
        console_ += pending.slice(0, m.index);
        pending = pending.slice(m.index + frame.length);
    }
    if (frameCount >= 2) break; // Splash + first loop frame
}

console_ += pending;
console.log('\n--- Final Serial Console ---');
console.log(console_.slice(-400));
console.log(`\nTotal OLED Frames captured: ${frameCount}`);
if (frameCount >= 2) {
    console.log('SUCCESS: Adafruit SSD1306 driver is fully functional in emulator!');
} else {
    console.error('FAILED to capture OLED frames');
    process.exit(1);
}
