// Validate the ESP image format assumptions against a real Arduino build.
import { readFileSync } from 'node:fs';
import { EspImage } from '../espimage.mjs';
const img = new EspImage(new Uint8Array(readFileSync(process.argv[2])));
console.log(`base=0x${img.base.toString(16)} entry=0x${img.entry.toString(16)} chipId=${img.chipId} ` +
            `segments=${img.segmentCount} hashAppended=${img.hashAppended}`);
for (const s of img.segments) {
    console.log(`  seg${s.index} load=0x${s.loadAddr.toString(16).padStart(8,'0')} len=${String(s.length).padStart(7)} at 0x${s.dataOffset.toString(16)}`);
}
console.log(`checksumOffset=0x${img.checksumOffset.toString(16)} stored=0x${img.storedChecksum().toString(16)} computed=0x${img.computeChecksum().toString(16)}`);
console.log('verify:', await img.verify());
