// Thread three-node multi-hop attach (Phase 1f): A (C6) leads; B (H2)
// attaches as Child, upgrades to Router (H2-gated sketch hook after ~100
// polls as child); C (C5) boots last and attaches THROUGH B. The harness
// is the virtual radio medium with a FIREWALL: C<->A frames are dropped
// (C never hears A), forcing C's parent to be B — proven by topology.
// All endpoints run real OT stacks; relay is per-ordered-pair queues,
// staged only when the peer slot is free, consumed via TX hooks (nodes
// that TX) and GetState-hop idle delivery (silent nodes).
// STATUS (2026-09-11): BLOCKED, not failed. C6B-B never attaches: healthy
// C6 retries every 750ms with a fresh challenge, deterministically
// invalidating A's ~700ms in-flight response (challenge race; H2 wins by
// accident — its dead loop never retries). Latest-wins + in-flight pause
// + optimistic hold + pump gating all attempted (see git log). Needs
// either StartAt shim (proper 750ms waits) or challenge-stable retries
// (OT change). C via B untested until B routes.
// Run: node spike/38-verify-thread-multihop.mjs
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const SLOT_MAGIC = 0x54485244;
const RELAY_RSSI = -50;
const RELAY_LQI = 200;

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

function loadSample(base) {
    const binCandidates = [`samples/${base}.merged.bin`, `/tmp/thrbuild/ThreadDemo.ino.merged.bin`];
    const elfCandidates = [`samples/${base}.elf`, `/tmp/thrbuild/ThreadDemo.ino.merged.bin`];
    const elfC2 = [`samples/${base}.elf`, `/tmp/thrbuild/ThreadDemo.ino.elf`];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfC2.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing build for ${base}`);
    return { flash: new Uint8Array(readFileSync(bin)), elf: new Uint8Array(readFileSync(elf)) };
}

// Per-node staging home (mirrors slotAddrFor): C6 in LP, H2/C5 in HP.
const HOME = new Map();
const guestFor = (mcu) => HOME.get(mcu) || 0x40820180;
const mpsduFor = (mcu) => guestFor(mcu) + 32;
const LP_MPSDU = 0x50000200 + 32;

// Per-MCU relay state (linear slot base cached; buffer identity checked).
const peers = new Map();
function slotState(mcu) {
    let st = peers.get(mcu);
    const buf = mcu.memory.buffer;
    if (!st || st.buf !== buf) {
        st = { buf, lin: -1, queue: [] };
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
    // Per-pair cursor so firewall pairs don't advance each other.
    const key = `f${tag}`;
    if (sst[key] === undefined) sst[key] = 0;
    let maxN = sst[key];
    for (const f of src.thread.frames) {
        if (f.n > sst[key] && f.len >= 100 && f.len <= 120 && ((f.psdu[0] & 7) === 1)) {
            sst.lastRespMs = Date.now();
        }
    }
    for (const f of src.thread.frames) {
        if (f.n > sst[key]) {
            // Latest-wins for Parent Requests + optimistic hold: forward
            // the first, then hold further ones 5s so A's in-flight
            // response lands on a stable challenge (challenge race).
            // Safety: a retry passes after 5s if A stayed silent.
            if (f.len === 63 && ((f.psdu[0] & 7) === 1)) {
                dstSt.queue = dstSt.queue.filter(
                    (q) => !(q.len === 63 && ((q.psdu[0] & 7) === 1)));
                slotState(dst).queue = dstSt.queue;
            }
            const isPR = (f.len === 63 && ((f.psdu[0] & 7) === 1));
            const prKey = key + ':fwdpr';
            const holdPR = isPR && sst[prKey] && (Date.now() - sst[prKey]) < 5000;
            if (!holdPR) {
                if (isPR) sst[prKey] = Date.now();
                dstSt.queue.push(f);
            }
        }
        if (f.n > maxN) maxN = f.n;
    }
    sst[key] = maxN;
    if (dstSt.queue.length > 64) {
        console.log(`  WARN ${tag}: dropping ${dstSt.queue.length - 64} queued (peer not consuming)`);
        dstSt.queue.splice(0, dstSt.queue.length - 64);
    }
    let moved = 0;
    while (dstSt.queue.length && slotFree(dst)) {
        const fr = dstSt.queue.shift();
        stageInto(dst, fr);
        moved += 1;
    }
    if (moved) console.log(`  relay ${tag}: staged ${moved} (qleft=${dstSt.queue.length})`);
    return moved;
}

console.log('========================================');
console.log('TEST: Thread multi-hop C6(leader) + C6B(router) + H2(child via router)');
console.log('========================================');

// Node A (C6): boot alone, wait for Leader (3x retry: C6 solo-boot
// flakes like 21/22/23, see issue.md #3).
let a = null;
let outA = '';
let aLeader = false;
for (let attempt = 0; attempt < 3 && !aLeader; attempt++) {
    a = await ESP32C3.create({ chip: 'esp32c6' });
    HOME.set(a, 0x50000180);
    {
        const { flash, elf } = loadSample('threaddemo_c6');
        await a.loadFirmware(flash, elf);
    }
    outA = '';
    for (let i = 0; i < 60000; i++) {
        outA += a.step(100000);
        if (outA.length > 30000) outA = outA.slice(-30000);
        if (/role=4/.test(outA)) { aLeader = true; break; }
        if (/Guru|panic|Assert/i.test(outA)) break;
    }
    if (!aLeader) console.log(`  A boot attempt ${attempt} failed, retrying`);
}
assert(aLeader, '[A/c6] became Leader');

// Node B (second C6, flagged EUI): boot, attach as Child, upgrade to
// Router via the C6-gated sketch hook (first poll as child; C6 loop
// stays alive, EUI distinct from A so no address collision).
const b = await ESP32C3.create({ chip: 'esp32c6' });
HOME.set(b, 0x50000180);
{
    const { flash, elf } = loadSample('threaddemo_c6b');
    await b.loadFirmware(flash, elf);
}
let outB = '';
let bChildAt = -1, bRouterAt = -1;
// Node C (H2): created late (after B is Router). Created now, booted later.
const c = await ESP32C3.create({ chip: 'esp32h2' });
HOME.set(c, 0x40820180);
let outC = '';
let cBooted = false;
let cChildAt = -1;
let rounds = 0;
let lastAtxAll = 0;
let lastBtxAll = 0;
for (let r = 0; r < 1500; r++) {
    rounds = r;
    for (let i = 0; i < 200; i++) outA += a.step(100000);
    if (outA.length > 30000) outA = outA.slice(-30000);
    if (a.thread.txCount !== lastAtxAll && a.thread.txCount < 40) {
        const f = a.thread.frames[a.thread.frames.length - 1];
        if (f.len > 20 && f.len < 127) console.log(`  A-TX#${f.n} len=${f.len} ${Buffer.from(f.psdu.slice(0, 16)).toString('hex')}`);
        lastAtxAll = a.thread.txCount;
    }
    relay(a, b, 'A->B');
    for (let i = 0; i < 200; i++) outB += b.step(100000);
    if (outB.length > 30000) outB = outB.slice(-30000);
    if (b.thread.txCount !== lastBtxAll && b.thread.txCount < 60) {
        const f = b.thread.frames[b.thread.frames.length - 1];
        if (f.len > 20) console.log(`  B-TX#${f.n} len=${f.len} ${Buffer.from(f.psdu.slice(0, 16)).toString('hex')}`);
        lastBtxAll = b.thread.txCount;
    }
    relay(b, a, 'B->A');
    if (cBooted) {
        relay(b, c, 'B->C');
        for (let i = 0; i < 200; i++) outC += c.step(100000);
        if (outC.length > 30000) outC = outC.slice(-30000);
        relay(c, b, 'C->B');
        // FIREWALL: A<->C frames dropped (force C via B). No relay(a,c)/relay(c,a).
    }
    if (bChildAt < 0 && /role=2/.test(outB)) {
        bChildAt = r;
        console.log(`  B child at round ${r} (H2 hook upgrades it immediately)`);
    }
    if (bRouterAt < 0 && /role=3/.test(outB)) { bRouterAt = r; console.log(`  B router at round ${r}`); }
    if (bRouterAt >= 0 && !cBooted) {
        const { flash, elf } = loadSample('threaddemo_h2');
        await c.loadFirmware(flash, elf);
        cBooted = true;
        console.log(`  C booted at round ${r}`);
    }
    if (cBooted && cChildAt < 0 && /role=2/.test(outC)) { cChildAt = r; console.log(`  C child at round ${r}`); break; }
    if (r % 50 === 49) {
        console.log(`  round ${r}: A.tx=${a.thread.txCount} B.tx=${b.thread.txCount} C.tx=${cBooted ? c.thread.txCount : '-'} B=[${[...new Set([...outB.matchAll(/role=(\d+)/g)].map((m) => m[1]))].join(',')}] C=[${cBooted ? [...new Set([...outC.matchAll(/role=(\d+)/g)].map((m) => m[1]))].join(',') : '-'}] Adel=${deliveries(a)} Bdel=${deliveries(b)}`);
    }
    if (/Guru|panic|Assert/i.test(outA + outB + outC)) break;
}
console.log(`  info: rounds=${rounds} A.tx=${a.thread.txCount} B.tx=${b.thread.txCount} C.tx=${cBooted ? c.thread.txCount : '-'}`);
console.log(`  info: B polls=${(outB.match(/\[THREAD\] poll/g) || []).length} A polls=${(outA.match(/\[THREAD\] poll/g) || []).length}`);
assert(bChildAt >= 0, '[B/c6b] attached as Child first (role=2)');
assert(bRouterAt >= 0, '[B/c6b] upgraded to Router (role=3)');
assert(cBooted && cChildAt >= 0, '[C/h2] attached as Child via B (role=2, A firewalled)');
assert(/role=[34]/.test(outA), '[A/c6] still Router/Leader');
assert(!/Guru|panic|Assert/i.test(outA + outB + outC), 'no Guru/panic/assert');

if (failures) {
    console.log(`\nTHREAD MULTIHOP: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD MULTIHOP PASSED (C6 leader + C6B router + H2 child via router) ✅');
