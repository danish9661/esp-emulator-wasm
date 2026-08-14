import { readFileSync } from 'node:fs';
import { Elf32 } from '../elf.mjs';
const elf = new Elf32(readFileSync(process.argv[2]));
const re = new RegExp(process.argv[3], 'i');
const hits = [...elf.symbols().entries()].filter(([n, s]) => re.test(n) && s.size > 0)
    .sort((a, b) => b[1].size - a[1].size);
console.log(`${hits.length} matches for /${process.argv[3]}/ (size>0), largest first:`);
for (const [n, s] of hits.slice(0, Number(process.argv[4] || 25))) {
    console.log(`  0x${s.value.toString(16)} ${String(s.size).padStart(5)}  ${n}`);
}
