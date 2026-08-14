// Headless node harness for esp-emu wasm.
// Exposes the emulator plus the raw wasm exports (incl. `memory`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', 'pkg');

export async function boot({ chip = 'esp32c3', firmware = null, bootFromRom = true } = {}) {
    const mod = await import(join(pkg, 'esp_emu.js'));
    const bytes = readFileSync(join(pkg, 'esp_emu_bg.wasm'));
    const wasm = mod.initSync(bytes);          // returns instance.exports

    const emu = new mod.WasmEmulator(chip);
    if (!emu.has_default_rom()) throw new Error(`no embedded ROM for ${chip}`);
    emu.load_default_rom();
    emu.set_boot_from_rom(bootFromRom);
    if (firmware) emu.load_firmware(firmware);

    return { emu, wasm, memory: wasm.memory };
}
