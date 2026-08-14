// Phase 1 deliverable: report the patch plan for a firmware ELF.
import { readFileSync } from 'node:fs';
import { Elf32, planHooks } from '../elf.mjs';

const path = process.argv[2];
const elf = new Elf32(readFileSync(path));
console.log(`${path}`);
console.log(`  entry=0x${elf.entry.toString(16)}  symbols=${elf.symbols().size}\n`);

const plan = planHooks(elf);
for (const bus of ['i2c', 'spi']) {
    const p = plan[bus];
    if (!p) { console.log(`${bus.toUpperCase()}: no driver linked in — nothing to patch\n`); continue; }
    console.log(`${bus.toUpperCase()}: tier "${p.tier}" (${p.hooks.length} hooks)`);
    for (const h of p.hooks) {
        console.log(`  ${h.name.padEnd(22)} addr=0x${h.addr.toString(16)} size=${String(h.size).padStart(5)} fileOff=0x${h.fileOffset?.toString(16)}`);
    }
    console.log();
}
