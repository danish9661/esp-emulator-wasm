// Thread / 802.15.4 radio bring-up, Phase 1b (completion) + 1c (beacons).
//
// Asserts the virtual radio drives real OpenThread scan flows on every
// 15.4 chip (C6/H2/C5 ThreadDemo: Arduino OT + direct esp_ieee802154 probe):
//   - esp_ieee802154_enable: -1 -> 0; radio INVALID 255 -> RECEIVE 2
//   - energy scan completes via deferred EnergyScanDone (ch 15, rssi -60)
//   - active scan starts rc=0 after the retry, TX tap fires with a real
//     beacon-request PSDU, the fabricated beacon is reported
//     (pan=0x1234 ch=15 rssi=-50), and the scan completes
//   - no Guru/panic/assert
// Run: node spike/32-verify-thread.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

function loadSample(base) {
    const binCandidates = [`samples/${base}.merged.bin`, `/tmp/thrbuild/ThreadDemo.ino.merged.bin`];
    const elfCandidates = [`samples/${base}.elf`, `/tmp/thrbuild/ThreadDemo.ino.elf`];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfCandidates.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing ThreadDemo build for ${base} (tried ${binCandidates.join(', ')})`);
    return { flash: new Uint8Array(readFileSync(bin)), elf: new Uint8Array(readFileSync(elf)) };
}

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

async function verifyChip(chip, base) {
    console.log('========================================');
    console.log(`TEST: ThreadDemo (802.15.4 radio Phase 1b+1c) on ${chip}`);
    console.log('========================================');
    const mcu = await ESP32C3.create({ chip });
    const { flash, elf } = loadSample(base);
    const { patched } = await mcu.loadFirmware(flash, elf);
    console.log(`patched ${patched.length}: ${patched.filter((p) => /ieee802154|otPlatRadio/i.test(p)).join(',')}`);
    for (const s of ['esp_ieee802154_enable', 'esp_ieee802154_disable', 'otPlatRadioReceive']) {
        assert(patched.includes(s), `[${chip}] shim patched: ${s}`);
    }

    let out = '';
    for (let i = 0; i < 16000; i++) {
        out += mcu.step(100000);
        if (out.includes('active-scan-done') || /Guru|panic|Assert/i.test(out)) break;
    }
    assert(out.includes('thread-start'), `[${chip}] boot reaches thread-start`);
    assert(out.includes('role=0'), `[${chip}] OT role Disabled at boot`);
    assert(out.includes('link-enable rc=0 radio=2'), `[${chip}] radio state RECEIVE (was 255 INVALID)`);
    assert(out.includes('drv enable=0'), `[${chip}] esp_ieee802154_enable returns 0 (was -1)`);
    assert(out.includes('energy-scan-start rc=0'), `[${chip}] energy scan starts`);
    assert(/energy ch=15 rssi=-?\d+/.test(out), `[${chip}] energy result delivered (deferred done)`);
    assert(out.includes('energy-done'), `[${chip}] energy scan completes`);
    assert(out.includes('active-scan-start rc=0'), `[${chip}] active scan starts after retry (no BUSY/assert)`);
    assert(mcu.thread.txCount >= 1, `[${chip}] TX tap fired (txCount=${mcu.thread.txCount})`);
    assert(mcu.thread.lastChannel === 15, `[${chip}] beacon request on ch 15 (got ${mcu.thread.lastChannel})`);
    const psdu = mcu.thread.frames[0] ? Buffer.from(mcu.thread.frames[0].psdu).toString('hex') : '';
    assert(mcu.thread.frames[0] && mcu.thread.frames[0].psdu.length === mcu.thread.lastLen && mcu.thread.lastLen > 0,
        `[${chip}] full PSDU captured (len=${mcu.thread.lastLen} ${psdu.slice(0, 32)}${psdu.length > 32 ? '…' : ''})`);
    assert(mcu.thread.scanCount >= 1, `[${chip}] energy-scan tap fired (scans=${mcu.thread.scanCount})`);
    assert(/active-scan pan=0x1234 ch=15 rssi=-50/.test(out),
        `[${chip}] fabricated beacon reported (pan=0x1234 ch=15 rssi=-50)`);
    assert(out.includes('active-scan-done'), `[${chip}] active scan completes (alarm expiry)`);
    assert(!/Guru|panic|Assert/i.test(out), `[${chip}] no Guru/panic/assert`);
    console.log(`  info: [${chip}] tx frames=${mcu.thread.frames.length} scans=${mcu.thread.scans.length}`);
}

for (const [chip, base] of [['esp32c6', 'threaddemo_c6'], ['esp32h2', 'threaddemo_h2'], ['esp32c5', 'threaddemo_c5']]) {
    await verifyChip(chip, base);
}

if (failures) {
    console.log(`\nTHREAD PHASE 1b+1c: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD PHASE 1b+1c PASSED (energy + active scans + beacons on C6/H2/C5) ✅');
