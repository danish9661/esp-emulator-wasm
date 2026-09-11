// Thread / 802.15.4 gateway E2E via the OpenHW gateway room broadcast.
//
// Boots C6 ThreadDemo, forwards each tapped 802.15.4 TX PSDU to
// /api/thread-gateway in a private room, and asserts a second room peer
// receives the beacon-request bytes back. Proves guest -> shim -> JS ->
// gateway -> peer with real firmware (energy + active scans run first so
// the TX under test is a genuine OT beacon request).
// Needs the gateway on ws://127.0.0.1:5095 (openhw-studio-gateway);
// otherwise prints SKIP (exit 0) instead of failing.
// Run: node spike/34-verify-thread-gw.mjs
//   GW_THREAD_URL=ws://host:port/api/thread-gateway?sessionId=room ...
import { readFileSync, existsSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const GW_URL = process.env.GW_THREAD_URL || 'ws://127.0.0.1:5095/api/thread-gateway?sessionId=espemu34';

function skipWhy(msg) {
    console.log(`Thread GW E2E: SKIP (${msg})`);
}

function loadSample(base) {
    const binCandidates = [`samples/${base}.merged.bin`, `/tmp/thrbuild/ThreadDemo.ino.merged.bin`];
    const elfCandidates = [`samples/${base}.elf`, `/tmp/thrbuild/ThreadDemo.ino.elf`];
    const bin = binCandidates.find((p) => existsSync(p));
    const elf = elfCandidates.find((p) => existsSync(p));
    if (!bin || !elf) throw new Error(`missing ThreadDemo build for ${base}`);
    return { flash: new Uint8Array(readFileSync(bin)), elf: new Uint8Array(readFileSync(elf)) };
}

const openWs = (url) => new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => res(ws);
    ws.onerror = () => rej(new Error('ws open failed'));
    setTimeout(() => rej(new Error('ws open timeout')), 8000);
});

let pump, sniffer;
try {
    [pump, sniffer] = await Promise.all([openWs(GW_URL), openWs(GW_URL)]);
} catch (e) {
    skipWhy('no gateway at ' + GW_URL + ' — start openhw-studio-gateway first');
    try { pump && pump.close(); } catch (_) {}
    try { sniffer && sniffer.close(); } catch (_) {}
    process.exit(0);
}

const sniffed = [];
sniffer.onmessage = (e) => { if (e.data instanceof ArrayBuffer) sniffed.push(new Uint8Array(e.data)); };
const sendFrame = (bytes) => {
    if (pump.readyState === 1) pump.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

const mcu = await ESP32C3.create({ chip: 'esp32c6' });
const { flash, elf } = loadSample('threaddemo_c6');
await mcu.loadFirmware(flash, elf);

const tick = () => new Promise((r) => setImmediate(r));
let out = '';
let forwarded = 0;
let failures = 0;
const assert = (cond, msg) => {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
};

for (let i = 0; i < 16000; i++) {
    out += mcu.step(100000);
    while (forwarded < mcu.thread.frames.length) {
        const f = mcu.thread.frames[forwarded++];
        sendFrame(f.psdu);
    }
    if (i % 200 === 199) await tick(); // let WS traffic dispatch
    if (/Guru|panic|Assert/i.test(out)) break;
    if (sniffed.length > 0 && out.includes('active-scan-start rc=0')) break;
}
await tick();
await new Promise((r) => setTimeout(r, 500)); // drain stragglers
await tick();

assert(out.includes('energy-done'), 'energy scan completes');
assert(out.includes('active-scan-start rc=0'), 'active scan starts');
assert(forwarded >= 1, `forwarded ${forwarded} TX frame(s) to the room`);
const want = mcu.thread.frames[0] ? Buffer.from(mcu.thread.frames[0].psdu).toString('hex') : null;
const got = sniffed.map((b) => Buffer.from(b).toString('hex'));
assert(want && got.includes(want), `room peer received the beacon PSDU (${want} in [${got.slice(0, 3).join(', ')}])`);
assert(!/Guru|panic|Assert/i.test(out), 'no Guru/panic/assert');

try { pump.close(); } catch (_) {}
try { sniffer.close(); } catch (_) {}
if (failures) {
    console.log(`\nTHREAD GW E2E: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nTHREAD GW E2E PASSED (guest TX -> gateway room -> peer) ✅');
