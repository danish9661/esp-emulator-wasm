// Thread joiner discovery (Phase 40, slice 1): joiner WITHOUT the static
// dataset discovers the virtual radio, consumes fabricated beacons, and
// times out cleanly when no commissioner answers.
//
// What this proves (and does NOT prove):
//   - joiner-start rc=0 + state=1 (DISCOVER) real OT Joiner runs in-sim
//   - discovery TXs (len-37 MLE-data) flow through the G-tap (no wedge)
//   - fabricated beacons report (pan=0x1234) on the joiner build
//   - join-cb err=23 (NOT_FOUND) + empty dataset TLVs (dstlv=23/0): the
//     scanner consumed beacons, found no commissioner, exited cleanly
// NOT proven (needs a commissioner): DTLS-PSK, dataset deliver, JOINED.
// That is slice 2 (commissioner on A or harness-held PSKc relay).
//
// Builds: /tmp joiner binaries (-DTHREAD_JOINER, never committed).
// Run: node spike/40-verify-thread-joiner.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

// JoinerDemo sources live in-tree (spike/sketches/JoinerDemo/JoinerDemo.ino);
// binaries are /tmp-only (never committed), mirroring the key2 pattern (39).
// Rebuild: arduino-cli compile --fqbn esp32:esp32:<chip>
//   spike/sketches/JoinerDemo --build-path /tmp/thrbuild_<tag>join
function loadJoiner(chip, tag) {
    const binCandidates = [
        `/tmp/thrbuild_${tag}join/JoinerDemo.ino.merged.bin`,
        `/tmp/thrbuild_${tag}join/ThreadDemo.ino.merged.bin`,
        `/tmp/joinprobe${tag === 'h2' ? '-h2' : ''}-build/joinprobe.ino.merged.bin`,
    ];
    const elfCandidates = [
        `/tmp/thrbuild_${tag}join/JoinerDemo.ino.elf`,
        `/tmp/thrbuild_${tag}join/ThreadDemo.ino.elf`,
        `/tmp/joinprobe${tag === 'h2' ? '-h2' : ''}-build/joinprobe.ino.elf`,
    ];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfCandidates.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing joiner build for ${tag} (tried ${binCandidates.join(', ')})`);
    console.log(`  using ${bin}`);
    return { flash: new Uint8Array(readFileSync(bin)), elf: new Uint8Array(readFileSync(elf)) };
}

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

async function verifyChip(chip, tag) {
    console.log('========================================');
    console.log(`TEST: Thread joiner discovery (no dataset) on ${chip}`);
    console.log('========================================');
    const mcu = await ESP32C3.create({ chip });
    const { flash, elf } = loadJoiner(chip, tag);
    const { patched } = await mcu.loadFirmware(flash, elf);
    console.log(`patched ${patched.length}: ${patched.filter((p) => /ieee802154|otPlatRadio/i.test(p)).join(',')}`);

    let out = '';
    for (let i = 0; i < 16000; i++) {
        out += mcu.step(100000);
        if (out.length > 30000) out = out.slice(-30000);
        if (/join-cb err=|Guru|panic|Assert/i.test(out)) break;
    }
    assert(/joiner-start rc=0/.test(out), `[${chip}] joiner-start rc=0 (PSKc accepted, OT Joiner live)`);
    assert(/joiner-poll state=1/.test(out), `[${chip}] joiner state DISCOVER (1) observed`);
    assert(mcu.thread.txCount >= 1, `[${chip}] discovery TX tap fired (txCount=${mcu.thread.txCount})`);
    assert(mcu.thread.frames[0] && (mcu.thread.frames[0].psdu[0] & 7) === 1,
        `[${chip}] discovery TX is MLE-data (no wedge, inbound2 path)`);
    assert(/active-scan pan=0x1234 ch=\d+ rssi=-50/.test(out),
        `[${chip}] fabricated beacon reported (scan path live on joiner build)`);
    assert(/join-cb err=23/.test(out),
        `[${chip}] join-cb err=23 NOT_FOUND (clean timeout, no commissioner — no hang)`);
    assert(/dstlv=23\/0/.test(out),
        `[${chip}] active dataset TLVs empty (nothing delivered, as expected)`);
    assert(!/Guru|panic|Assert/i.test(out), `[${chip}] no Guru/panic/assert`);
    console.log(`  info: [${chip}] tx frames=${mcu.thread.frames.length} scans=${mcu.thread.scans.length}`);
}

await verifyChip('esp32c6', 'c6');
await verifyChip('esp32h2', 'h2');

if (failures) {
    console.log(`\nTHREAD JOINER: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD JOINER DISCOVERY PASSED (state=1 + scan + clean NOT_FOUND on C6/H2) ✅');
