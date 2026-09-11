// Thread RX injection (Phase 1d): the harness stages a complete
// otRadioFrame+PSDU in the inbound slot; the next TX delivers it instead of
// the fabricated beacon. Deterministic (no timing races: staging precedes
// the scan, delivery is synchronous in TX flow).
//
// Slot discovery mirrors the BLE mirror: getstatePark plants SLOT_MAGIC
// once the firmware polls GetState (link-enable line), the harness scans
// WASM linear memory for it (accepting only hits with a zero len word, so
// coincidence hits fail loudly instead of mis-staging).
// Run: node spike/35-verify-thread-inject.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const SLOT_MAGIC = 0x54485244;
// Per-chip staging home (mirrors slotAddrFor): C6 in LP (heap eats its HP),
// H2/C5 in HP (coherent + heap-quiet there).
const slotGuestFor = (chip) => (chip === 'esp32c6' ? 0x50000180 : 0x40820180);
const SLOT_MPSDU_C6 = 0x50000180 + 32;
const SLOT_MPSDU_HP = 0x40820180 + 32;

// Injected beacon: same valid shape as the fabricated one, distinct identity
// (PAN 0x5678, ext AA:…, rssi -70, lqi 150) so the test proves external origin.
const INJ_PAN = 0x5678;
const INJ_RSSI = -70;
const INJ_LQI = 150;
function injectedPsdu() {
    return Uint8Array.from([
        0x00, 0xD0, 0x5A, 0x78, 0x56, 0xAA,
        0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22,
        0xFF, 0x00, 0x00, 0x00,
        0xFF, 0x0F, 0x00, 0x00,
        0x00, 0x00,
    ]);
}

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

function findSlot(mcu) {
    const buf = mcu.memory.buffer;
    const u32 = new Uint32Array(buf);
    const dv = new DataView(buf);
    let hits = 0;
    for (let i = 0; i < u32.length; i++) {
        if ((u32[i] >>> 0) === SLOT_MAGIC) {
            hits += 1;
            const lin = i * 4 - 160;
            if (lin < 0) continue;
            // Verify mPsdu (planted by getstatePark): rejects heap phantoms
            // (OT message buffers with coincidental THRD words). Accept
            // either home (per-chip).
            const mp = (dv.getUint32(lin, true) >>> 0);
            if (dv.getUint16(lin + 4, true) === 0 && (mp === SLOT_MPSDU_C6 || mp === SLOT_MPSDU_HP)) return lin;
        }
    }
    throw new Error(`no verified disarmed inbound slot found (${hits} magic hits)`);
}

function stage(mcu, linBase, chip) {
    const dv = new DataView(mcu.memory.buffer);
    const u8 = new Uint8Array(mcu.memory.buffer);
    const psdu = injectedPsdu();
    // struct: mPsdu = slotGuest+32, len 23, ch 15, rssi/lqi.
    dv.setUint32(linBase, slotGuestFor(chip) + 32, true);
    dv.setUint16(linBase + 4, 23, true);
    u8[linBase + 6] = 15;
    u8[linBase + 7] = 0;
    dv.setUint32(linBase + 8, 0, true);
    dv.setUint32(linBase + 12, 0, true);
    dv.setUint32(linBase + 16, 0, true);
    u8[linBase + 20] = 0;
    u8[linBase + 21] = (INJ_RSSI & 0xff);
    u8[linBase + 22] = INJ_LQI;
    u8[linBase + 23] = 0;
    u8.set(psdu, linBase + 32);
    dv.setUint32(linBase + 160, SLOT_MAGIC, true);
}

async function verifyChip(chip, base) {
    console.log('========================================');
    console.log(`TEST: Thread RX injection on ${chip}`);
    console.log('========================================');
    const binCandidates = [`samples/${base}.merged.bin`, `/tmp/thrbuild/ThreadDemo.ino.merged.bin`];
    const elfCandidates = [`samples/${base}.elf`, `/tmp/thrbuild/ThreadDemo.ino.elf`];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfCandidates.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing build for ${base}`);
    const mcu = await ESP32C3.create({ chip });
    await mcu.loadFirmware(new Uint8Array(readFileSync(bin)), new Uint8Array(readFileSync(elf)));

    let out = '';
    for (let i = 0; i < 4000 && !out.includes('link-enable'); i++) out += mcu.step(100000);
    assert(out.includes('link-enable'), `[${chip}] booted to link-enable (magic planted)`);
    const linBase = findSlot(mcu);
    console.log(`  info: [${chip}] slot linear=0x${linBase.toString(16)}`);
    stage(mcu, linBase, chip);
    for (let i = 0; i < 16000; i++) {
        out += mcu.step(100000);
        if (out.includes('active-scan-done') || /Guru|panic|Assert/i.test(out)) break;
    }
    assert(/active-scan pan=0x5678 ch=15 rssi=-70/.test(out),
        `[${chip}] injected beacon reported (pan=0x5678 ch=15 rssi=-70)`);
    assert(!out.includes('pan=0x1234'), `[${chip}] fabricated beacon suppressed (slot consumed it)`);
    assert(out.includes('active-scan-done'), `[${chip}] scan completes`);
    assert(!/Guru|panic|Assert/i.test(out), `[${chip}] no Guru/panic/assert`);
}

for (const [chip, base] of [['esp32c6', 'threaddemo_c6'], ['esp32h2', 'threaddemo_h2'], ['esp32c5', 'threaddemo_c5']]) {
    await verifyChip(chip, base);
}

if (failures) {
    console.log(`\nTHREAD INJECT: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD INJECT PASSED (host-staged frames delivered on C6/H2/C5) ✅');
