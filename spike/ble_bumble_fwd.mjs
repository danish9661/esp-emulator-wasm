// PoC: route emulator HCI through a REAL Bluetooth stack (Bumble virtual
// controller over TCP) instead of the in-sim JS virtual controller.
//
// The guest polls the shared-memory mirror flag across steps, so delivery
// can be asynchronous: handle() stashes the command and returns null (no
// immediate mirror event); the TCP reply is written to the mirror when it
// arrives and the guest's pending poll loop completes on a later step.
// Falls back to the local stub controller on timeout/unknown.
//
// Usage:
//   python3 spike/bumble_hci_poc.py            # TCP 127.0.0.1:9545
//   BUMBLE_TCP=127.0.0.1:9545 node spike/ble_bumble_fwd.mjs
//
// Experimental: single outstanding command, no unsolicited-event handling.
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { ESP32C3 } from '../index.mjs';
import { BLEController } from '../core/ble_controller.mjs';

const ADDR = process.env.BUMBLE_TCP || '127.0.0.1:9545';
const [HOST, PORT] = ADDR.split(':');

// H4 stream parser: yields complete packets ([type, ...bytes]).
function h4Split(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
        const t = buf[i];
        let need = -1;
        if (t === 0x04 && i + 3 <= buf.length) need = 3 + buf[i + 2];
        else if (t === 0x02 && i + 5 <= buf.length) need = 5 + (buf[i + 3] | (buf[i + 4] << 8));
        else if (t === 0x01 && i + 4 <= buf.length) need = 4 + buf[i + 3];
        if (need < 0 || i + need > buf.length) break;
        out.push(buf.slice(i, i + need));
        i += need;
    }
    return { packets: out, rest: buf.slice(i) };
}

const sock = net.createConnection({ host: HOST, port: +PORT });
await new Promise((res, rej) => {
    sock.once('connect', res);
    sock.once('error', rej);
    setTimeout(() => rej(new Error('tcp timeout')), 8000);
});
console.log('TCP connected to Bumble controller at', ADDR);

let rxBuf = Buffer.alloc(0);
const pending = []; // FIFO of {resolve} — at most one outstanding in practice
sock.on('data', (chunk) => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    const { packets, rest } = h4Split([...rxBuf]);
    rxBuf = Buffer.from(rest);
    for (const p of packets) {
        const cb = pending.shift();
        if (cb) cb(p);
        else console.log('(unsolicited evt, dropped)', p.slice(0, 6).map((b) => b.toString(16)));
    }
});
sock.on('error', (e) => console.log('tcp err:', e.message.slice(0, 60)));

const forward = (msg) => new Promise((resolve) => {
    pending.push(resolve);
    sock.write(Buffer.from(msg));
    setTimeout(() => {
        const i = pending.indexOf(resolve);
        if (i >= 0) {
            pending.splice(i, 1);
            resolve(null); // timeout -> caller falls back to local stub
        }
    }, 15000);
});

// Patch the shared controller path: try Bumble first, fall back local.
const localHandle = BLEController.prototype.handle;
let mirror = null;
// Opcodes Bumble 0.0.231 cannot serve (async-handler bug returns an error
// object instead of None, hanging the host): answer locally.
const LOCAL_OPS = new Set([0xfc01, 0x204e]);
BLEController.prototype.handle = function (msg) {
    const opcode = ((msg[2] & 0xff) << 8) | (msg[1] & 0xff);
    if (!mirror || LOCAL_OPS.has(opcode)) return localHandle.call(this, msg);
    // Kick the async forward; the mirror gets the real answer when it lands.
    // Return null so uart.mjs skips immediate mirror delivery (guarded).
    forward(msg).then((evt) => {
        if (evt) {
            mirror.deliver(evt);
        } else if (mirror) {
            // Fallback: local stub answer (shouldn't normally happen).
            mirror.deliver(localHandle.call(this, msg));
        }
    });
    return null;
};

// Boot BLEDemo and wire the mirror reference after load.
const chip = process.env.CHIP || 'esp32c3';
const dir = chip === 'esp32c3'
    ? 'spike/sketches/BLEDemo/build/esp32.esp32.esp32c3'
    : `spike/sketches/BLEDemo/build_esp32${chip.slice(5)}`;
const mcu = await ESP32C3.create({ chip });
await mcu.loadFirmware(
    new Uint8Array(readFileSync(`${dir}/BLEDemo.ino.merged.bin`)),
    new Uint8Array(readFileSync(`${dir}/BLEDemo.ino.elf`)));
mirror = mcu.uart0.bleMirror;
const hci = [];
mcu.uart0.ble.onHci((m) => hci.push(m));
let live = '';
mcu.uart0.onData((t) => { live += t; });
const tick = () => new Promise((r) => setImmediate(r));
for (let i = 0; i < 6000; i++) {
    mcu.step(100000);
    if (i % 200 === 199) await tick(); // let TCP replies dispatch
    if (/ble-done|advertising started/.test(live) && hci.filter((m) => m.dir === 'cmd').length >= 10) break;
}
await tick();
const cmds = hci.filter((m) => m.dir === 'cmd');
console.log(`commands=${cmds.length} init done=${/init done/.test(live)} advertising=${/advertising started/.test(live)}`);
console.log('tail:', JSON.stringify(live.slice(-200)));
sock.destroy();
if (!/advertising started/.test(live)) process.exit(1);
console.log('BUMBLE-BACKED BRING-UP: PASS ✅');
