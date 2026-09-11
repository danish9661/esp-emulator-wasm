// Thread two-node attach via harness relay (Phase 1e): node A (C6) forms a
// partition alone (Leader); node B (H2, same dataset) boots later and
// attaches THROUGH A, with the harness relaying raw 802.15.4 frames both
// ways (A.frames -> B slot, B.frames -> A slot). Both endpoints run real OT
// stacks, so no MLE crypto is implemented host-side — the harness is purely
// the virtual radio medium (per-direction queues, stage only when the peer
// slot is free, TX-driven delivery on the peer's next transmit).
// Deterministic order: B boots only after A is Leader.
// Run: node spike/37-verify-thread-attach.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const SLOT_MAGIC = 0x54485244;
// Per-node staging home (mirrors slotAddrFor): A/C6 in LP (heap eats its HP
// on long runs; C6-LP is coherent), B/H2 in HP (coherent + heap-quiet).
const HOME = new Map(); // mcu -> guest slot base
const guestFor = (mcu) => HOME.get(mcu) || 0x40820180;
const mpsduFor = (mcu) => guestFor(mcu) + 32;
const LP_MPSDU = 0x50000200 + 32; // LP mirror anchor (planted by beaconPark, clear of copy)
const RELAY_RSSI = -50;
const RELAY_LQI = 200;

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

function loadSample(base) {
    // Key2 builds live in /tmp (not committed); fall back to samples/.
    const tag = base.replace('threaddemo_', '');
    const binCandidates = [`/tmp/thrbuild_${tag}k2/ThreadDemo.ino.merged.bin`, `samples/${base}.merged.bin`];
    const elfCandidates = [`/tmp/thrbuild_${tag}k2/ThreadDemo.ino.elf`, `samples/${base}.elf`];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfCandidates.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing build for ${base}`);
    console.log(`  using ${bin}`);
    return { flash: new Uint8Array(readFileSync(bin)), elf: new Uint8Array(readFileSync(elf)) };
}

// Per-MCU relay state (linear slot base cached; buffer identity checked).
const peers = new Map();
function slotState(mcu) {
    let st = peers.get(mcu);
    const buf = mcu.memory.buffer;
    if (!st || st.buf !== buf) {
        st = { buf, lin: -1, seen: 0, queue: [] };
        peers.set(mcu, st);
    }
    return st;
}

function verifySlot(mcu, lin) {
    if (lin < 0) return false;
    try {
        const dv = new DataView(mcu.memory.buffer);
        return dv.getUint16(lin + 4, true) === 0 &&
            (dv.getUint32(lin, true) >>> 0) === mpsduFor(mcu) &&
            (new Uint32Array(mcu.memory.buffer)[(lin + 160) >>> 2] >>> 0) === SLOT_MAGIC;
    } catch (_) { return false; }
}

function findSlot(mcu) {
    const st = slotState(mcu);
    if (st.lin >= 0 && st.buf === mcu.memory.buffer && verifySlot(mcu, st.lin)) return st.lin;
    const u32 = new Uint32Array(mcu.memory.buffer);
    const dv = new DataView(mcu.memory.buffer);
    for (let i = 0; i < u32.length; i++) {
        if ((u32[i] >>> 0) === SLOT_MAGIC) {
            const lin = i * 4 - 160;
            if (lin >= 0 && dv.getUint16(lin + 4, true) === 0 && (dv.getUint32(lin, true) >>> 0) === mpsduFor(mcu)) {
                st.lin = lin;
                return lin;
            }
        }
    }
    st.lin = -1;
    return -1;
}

function slotFree(mcu) {
    return findSlot(mcu) >= 0;
}

function deliveries(mcu) {
    // Delivery counter lives in LP (heap-clean); locate LP per run via
    // the mirror anchor (magic + LP mPsdu), same relative layout as HP.
    const buf = mcu.memory.buffer;
    const u32 = new Uint32Array(buf);
    const dv = new DataView(buf);
    for (let i = 0; i < u32.length; i++) {
        if ((u32[i] >>> 0) === SLOT_MAGIC) {
            const lin = i * 4 - 160;
            if (lin >= 0 && dv.getUint16(lin + 4, true) === 0 && (dv.getUint32(lin, true) >>> 0) === LP_MPSDU) {
                try {
                    return dv.getUint32(lin - 0x1d8, true) >>> 0;
                } catch (_) { return -1; }
            }
        }
    }
    return -1;
}

function stageInto(mcu, frame) {
    const lin = findSlot(mcu);
    const dv = new DataView(mcu.memory.buffer);
    const u8 = new Uint8Array(mcu.memory.buffer);
    const psdu = frame.psdu.length > 127 ? frame.psdu.slice(0, 127) : frame.psdu;
    u8.set(psdu, lin + 32);
    dv.setUint32(lin, guestFor(mcu) + 32, true);
    dv.setUint16(lin + 4, psdu.length, true);
    u8[lin + 6] = frame.channel;
    u8[lin + 7] = 0;
    u8[lin + 20] = 0;
    u8[lin + 21] = (RELAY_RSSI & 0xff);
    u8[lin + 22] = RELAY_LQI;
    u8[lin + 23] = 0;
    dv.setUint32(lin + 160, SLOT_MAGIC, true);
}

// Move newly captured frames into the peer (queue-aware, non-blocking).
// Cursor is frame.n (absolute TX sequence), immune to the controller's
// frames[] 256-cap ring-shift which breaks array-index cursors.
function relay(src, dst, tag) {
    const sst = slotState(src);
    const dstSt = slotState(dst);
    if (sst.fwdN === undefined) sst.fwdN = 0;
    let maxN = sst.fwdN;
    for (const f of src.thread.frames) {
        if (f.n > sst.fwdN) {
            // Latest-wins for Parent Requests: a queued older req carries
            // a stale challenge, so an answer to it gets dropped. Replace
            // older queued reqs so A always answers the freshest.
            if (f.len === 63 && ((f.psdu[0] & 7) === 1)) {
                dstSt.queue = dstSt.queue.filter(
                    (q) => !(q.len === 63 && ((q.psdu[0] & 7) === 1)));
                slotState(dst).queue = dstSt.queue;
            }
            dstSt.queue.push(f);
        }
        if (f.n > maxN) maxN = f.n;
    }
    sst.fwdN = maxN;
    if (dstSt.queue.length > 64) {
        console.log(`  WARN ${tag}: dropping ${dstSt.queue.length - 64} queued (peer not consuming)`);
        dstSt.queue.splice(0, dstSt.queue.length - 64);
    }
    let moved = 0;
    while (dstSt.queue.length && slotFree(dst)) {
        const fr = dstSt.queue.shift();
        stageInto(dst, fr);
        console.log(`  relay ${tag}: staged len=${fr.len} n=${fr.n} ${Buffer.from(fr.psdu.slice(0, 8)).toString('hex')} (qleft=${dstSt.queue.length})`);
        moved += 1;
    }
    return moved;
}

console.log('========================================');
console.log('TEST: Thread key2-dataset attach C6(leader) + H2(child)');
console.log('========================================');

// Node A (C6): boot alone, wait for Leader.
const a = await ESP32C3.create({ chip: 'esp32c6' });
HOME.set(a, 0x50000180); // C6 stages in LP
{
    const { flash, elf } = loadSample('threaddemo_c6');
    await a.loadFirmware(flash, elf);
}
let outA = '';
for (let i = 0; i < 60000; i++) {
    outA += a.step(100000);
    if (outA.length > 30000) outA = outA.slice(-30000);
    if (/role=4/.test(outA) || /Guru|panic|Assert/i.test(outA)) break;
}
assert(/role=4/.test(outA), `[A/c6] became Leader (roles seen: ${[...new Set([...outA.matchAll(/role=(\d+)/g)].map((m) => m[1]))].join(',')})`);

// Node B (H2): boot after A is Leader.
const b = await ESP32C3.create({ chip: 'esp32h2' });
HOME.set(b, 0x40820180); // H2 stages in HP
{
    const { flash, elf } = loadSample('threaddemo_h2');
    await b.loadFirmware(flash, elf);
}
let outB = '';
let bChildAt = -1;
let rounds = 0;
let lastAtx = a.thread.txCount, lastBtx = b.thread.txCount;
for (let r = 0; r < 4000; r++) {
    rounds = r;
    for (let i = 0; i < 200; i++) outA += a.step(100000);
    if (outA.length > 30000) outA = outA.slice(-30000);
    relay(a, b, 'A->B');
    for (let i = 0; i < 200; i++) outB += b.step(100000);
    if (outB.length > 30000) outB = outB.slice(-30000);
    relay(b, a, 'B->A');
    if (r % 200 === 199) {
        const bRoles = [...new Set([...outB.matchAll(/role=(\d+)/g)].map((m) => m[1]))].join(',');
        console.log(`  round ${r}: A.tx=${a.thread.txCount}(+${a.thread.txCount - lastAtx}) B.tx=${b.thread.txCount}(+${b.thread.txCount - lastBtx}) B.roles=[${bRoles}] Aq=${(peers.get(a) || { queue: [] }).queue.length} Bq=${(peers.get(b) || { queue: [] }).queue.length} Adel=${deliveries(a)} Bdel=${deliveries(b)}`);
        lastAtx = a.thread.txCount; lastBtx = b.thread.txCount;
    }
    if (/role=2/.test(outB)) { bChildAt = r; break; }
    if (/Guru|panic|Assert/i.test(outA + outB)) break;
}
console.log(`  info: relay rounds=${rounds} A.tx=${a.thread.txCount} B.tx=${b.thread.txCount}`);
{
    const bLin = findSlot(b);
    let bSlot = 'none';
    if (bLin >= 0) {
        try {
            const dv = new DataView(b.memory.buffer);
            bSlot = `lin=0x${bLin.toString(16)} len=${dv.getUint16(bLin + 4, true)} magic=${(dv.getUint32(bLin + 160, true) >>> 0).toString(16)}`;
        } catch (_) {}
    }
    const aLin = findSlot(a);
    let aSlot = 'none';
    if (aLin >= 0) {
        try {
            const dv = new DataView(a.memory.buffer);
            aSlot = `lin=0x${aLin.toString(16)} len=${dv.getUint16(aLin + 4, true)} magic=${(dv.getUint32(aLin + 160, true) >>> 0).toString(16)}`;
        } catch (_) {}
    }
    console.log(`  info: A slot ${aSlot} B slot ${bSlot}`);
    console.log(`  info: B polls=${(outB.match(/\[THREAD\] poll/g) || []).length} A polls=${(outA.match(/\[THREAD\] poll/g) || []).length}`);
    console.log('--- outB tail ---');
    console.log(outB.slice(-800));
}
assert(bChildAt >= 0, '[B/h2] attached as Child (role=2)');
assert(/role=[34]/.test(outA), '[A/c6] still Router/Leader');
assert(!/Guru|panic|Assert/i.test(outA + outB), 'no Guru/panic/assert');

if (failures) {
    console.log(`\nTHREAD KEY2 ATTACH: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD KEY2 ATTACH PASSED (C6 leader + H2 child, reversed key) ✅');
