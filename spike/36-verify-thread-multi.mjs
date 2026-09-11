// Thread multi-node relay (Phase 1d): node A (C6) scans first; the harness
// relays A's beacon request as a synthetic beacon "from A" (PAN 0xAAAA)
// into node B's (H2) inbound slot; B's scan then reports A's beacon while A
// reports its own fabricated one. Proves guest-to-guest causality through
// the virtual medium (the harness plays the medium here; the gateway room
// transport itself is proven by 34-verify-thread-gw).
// Deterministic: B boots only after A's TX is observed, and B's slot is
// staged before B's scan starts — no timing races.
// Run: node spike/36-verify-thread-multi.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const SLOT_MAGIC = 0x54485244;
const SLOT_GUEST = 0x40820180; // H2 stages in HP (C6 would use LP 0x50000180)
const SLOT_MPSDU_HP = 0x40820180 + 32;
const SLOT_MPSDU_C6 = 0x50000180 + 32; // (accepted too)

const RELAY_PAN = 0xaaaa;
const RELAY_RSSI = -55;
const RELAY_LQI = 180;

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

function loadSample(base) {
    const binCandidates = [`samples/${base}.merged.bin`, `/tmp/thrbuild/ThreadDemo.ino.merged.bin`];
    const elfCandidates = [`samples/${base}.elf`, `/tmp/thrbuild/ThreadDemo.ino.elf`];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfCandidates.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing build for ${base}`);
    return { flash: new Uint8Array(readFileSync(bin)), elf: new Uint8Array(readFileSync(elf)) };
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
            // Verify mPsdu (planted by getstatePark): rejects heap phantoms.
            const mp = (dv.getUint32(lin, true) >>> 0);
            if (dv.getUint16(lin + 4, true) === 0 && (mp === SLOT_MPSDU_HP || mp === SLOT_MPSDU_C6)) return lin;
        }
    }
    throw new Error(`no verified disarmed inbound slot found (${hits} magic hits)`);
}

function relayPsdu() {
    // Same valid beacon shape as the fabricated one, relay identity
    // (PAN 0xAAAA, ext DE:…).
    return Uint8Array.from([
        0x00, 0xD0, 0x5A, 0xAA, 0xAA, 0xDE,
        0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22,
        0xFF, 0x00, 0x00, 0x00,
        0xFF, 0x0F, 0x00, 0x00,
        0x00, 0x00,
    ]);
}

function stage(mcu, linBase) {
    const dv = new DataView(mcu.memory.buffer);
    const u8 = new Uint8Array(mcu.memory.buffer);
    u8.set(relayPsdu(), linBase + 32);
    dv.setUint32(linBase, SLOT_GUEST + 32, true);
    dv.setUint16(linBase + 4, 23, true);
    u8[linBase + 6] = 15;
    u8[linBase + 7] = 0;
    dv.setUint32(linBase + 8, 0, true);
    dv.setUint32(linBase + 12, 0, true);
    dv.setUint32(linBase + 16, 0, true);
    u8[linBase + 20] = 0;
    u8[linBase + 21] = (RELAY_RSSI & 0xff);
    u8[linBase + 22] = RELAY_LQI;
    u8[linBase + 23] = 0;
    dv.setUint32(linBase + 160, SLOT_MAGIC, true);
}

function stepUntil(mcu, out, re, max) {
    for (let i = 0; i < max; i++) {
        out.s += mcu.step(100000);
        if (re.test(out.s) || /Guru|panic|Assert/i.test(out.s)) break;
    }
    return out;
}

console.log('========================================');
console.log('TEST: Thread multi-node relay C6 -> H2');
console.log('========================================');

// Node A (C6): boot and scan; wait for its TX (the relay trigger).
const a = await ESP32C3.create({ chip: 'esp32c6' });
{
    const { flash, elf } = loadSample('threaddemo_c6');
    await a.loadFirmware(flash, elf);
}
let liveA = { s: '' };
for (let i = 0; i < 16000 && a.thread.txCount < 1; i++) liveA = stepUntil(a, liveA, /a^/, 1);
assert(a.thread.txCount >= 1, `[A/c6] TX observed (relay trigger, txCount=${a.thread.txCount})`);

// Node B (H2): boot only after A's TX, stage the relay beacon, then scan.
const b = await ESP32C3.create({ chip: 'esp32h2' });
{
    const { flash, elf } = loadSample('threaddemo_h2');
    await b.loadFirmware(flash, elf);
}
let liveB = { s: '' };
liveB = stepUntil(b, liveB, /link-enable/, 4000);
assert(liveB.s.includes('link-enable'), '[B/h2] booted to link-enable');
stage(b, findSlot(b));
console.log('  info: [B/h2] relay beacon staged (from A)');
liveB = stepUntil(b, liveB, /active-scan-done/, 16000);
liveA = stepUntil(a, liveA, /active-scan-done/, 16000);

assert(/active-scan pan=0x1234 ch=15 rssi=-50/.test(liveA.s), '[A/c6] own fabricated beacon reported');
assert(/active-scan pan=0xaaaa ch=15 rssi=-55/.test(liveB.s), '[B/h2] relayed beacon from A reported');
assert(!liveB.s.includes('pan=0x1234'), '[B/h2] fabricated suppressed (relay consumed the TX)');
assert(liveA.s.includes('active-scan-done'), '[A/c6] scan completes');
assert(liveB.s.includes('active-scan-done'), '[B/h2] scan completes');
assert(!/Guru|panic|Assert/i.test(liveA.s + liveB.s), 'no Guru/panic/assert');

if (failures) {
    console.log(`\nTHREAD MULTI: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD MULTI PASSED (C6 TX -> relay -> H2 report) ✅');
