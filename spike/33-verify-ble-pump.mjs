// BLE HCI pump verification (headless, no gateway/Bumble needed).
//
// Exercises core/ble_hci_pump.mjs with a fake transport + real BLEMirror over
// a scratch ArrayBuffer:
//   1. local Reset -> answered via mirror (flag==1, Command Complete)
//   2. bumble+open: Reset -> forwarded as H4, mirror untouched; WS evt ->
//      mirror delivered (flag==1, evt bytes staged)
//   3. bumble: 0xfc01 / 0x204e -> answered locally (Bumble 0.0.231 gaps)
//   4. bumble: ACL 0x02 -> local Number-Of-Completed-Packets
//   5. bumble+closed transport -> local fallback
// Run: node spike/33-verify-ble-pump.mjs
import { BLEController } from '../core/ble_controller.mjs';
import { BLEMirror } from '../core/ble_mirror.mjs';
import { BLE_MAGIC1, BLE_MAGIC2 } from '../core/ble_shims.mjs';
import { BleHciPump } from '../core/ble_hci_pump.mjs';
import { ReplyDribbler } from '../reply_queue.mjs';

let failures = 0;
function assert(cond, msg) {
    if (cond) console.log(`  ok: ${msg}`);
    else { console.log(`  FAIL: ${msg}`); failures += 1; }
}

// Scratch "linear memory" with the guest magic pair planted at u32[100].
const mem = new ArrayBuffer(4096);
function plantMagic() {
    const u32 = new Uint32Array(mem);
    u32[100] = BLE_MAGIC1; u32[101] = BLE_MAGIC2;
    // zero the evt area so staged bytes are observable
    new Uint8Array(mem, 100 * 4 + (0x100 - 8), 64).fill(0);
}
function flagWord() { return new Uint32Array(mem)[100] >>> 0; }
function evtBytes(n) { return [...new Uint8Array(mem, 100 * 4 + (0x100 - 8), n)]; }

const hciLog = [];
const sent = [];
const fakeTransport = { send: (b) => sent.push([...b]), isOpen: () => fakeOpen };
let fakeOpen = true;

function makePump() {
    const controller = new BLEController();
    const mirror = new BLEMirror(() => mem);
    const dribbler = new ReplyDribbler();
    const pump = new BleHciPump({
        controller, mirror, dribbler,
        postHci: (m) => hciLog.push(m),
    });
    return { controller, mirror, dribbler, pump };
}

const RESET = new Uint8Array([0x01, 0x03, 0x0c, 0x00]);
const GEN_ADDR = new Uint8Array([0x01, 0x01, 0xfc, 0x00]);
const ACL = new Uint8Array([0x02, 0x01, 0x00, 0x05, 0x00, 0x04, 0x00, 0x11, 0x00]);

console.log('TEST 1: local Reset answered via mirror');
{
    plantMagic();
    const { pump, dribbler } = makePump();
    const r = pump.handleBFrame(RESET);
    assert(r === 'local', `route=local (got ${r})`);
    assert(flagWord() === 1, 'mirror flag==1');
    const evt = evtBytes(7);
    assert(evt[0] === 0x04 && evt[1] === 0x0e, `Command Complete staged (${evt.map((b) => b.toString(16)).join(' ')})`);
    assert(!dribbler.pending, 'no E-UART fallback needed');
}

console.log('TEST 2: bumble forward + WS evt delivery');
{
    plantMagic();
    const { pump } = makePump();
    pump.setMode('bumble');
    pump.setTransport(fakeTransport);
    sent.length = 0; hciLog.length = 0;
    const r = pump.handleBFrame(RESET);
    assert(r === 'forwarded', `route=forwarded (got ${r})`);
    assert(sent.length === 1 && sent[0].join(',') === '1,3,12,0', `H4 forwarded (${sent[0]})`);
    assert(flagWord() === (BLE_MAGIC1 >>> 0), 'mirror untouched while guest spins');
    assert(hciLog.length === 1 && hciLog[0].dir === 'cmd' && hciLog[0].opcode === 0x0c03, 'cmd posted to UI');
    // Bumble answers: Command Complete for Reset.
    pump.handleWsMessage(new Uint8Array([0x04, 0x0e, 0x04, 0x01, 0x03, 0x0c, 0x00]));
    assert(flagWord() === 1, 'mirror flag==1 after WS evt');
    const evt = evtBytes(7);
    assert(evt.join(',') === '4,14,4,1,3,12,0', `evt staged (${evt})`);
    assert(hciLog.length === 2 && hciLog[1].dir === 'evt', 'evt posted to UI');
}

console.log('TEST 3: Bumble-gap ops answered locally');
{
    plantMagic();
    const { pump } = makePump();
    pump.setMode('bumble');
    pump.setTransport(fakeTransport);
    sent.length = 0;
    const r = pump.handleBFrame(GEN_ADDR);
    assert(r === 'local', `0xfc01 route=local (got ${r})`);
    assert(sent.length === 0, 'nothing forwarded');
    assert(flagWord() === 1, 'mirror flag==1 (local answer)');
}

console.log('TEST 4: ACL answered locally in bumble mode');
{
    plantMagic();
    const { pump } = makePump();
    pump.setMode('bumble');
    pump.setTransport(fakeTransport);
    sent.length = 0;
    const r = pump.handleBFrame(ACL);
    assert(r === 'local', `ACL route=local (got ${r})`);
    assert(sent.length === 0, 'nothing forwarded');
    assert(flagWord() === 1, 'mirror flag==1 (NCP answer)');
    const evt = evtBytes(8);
    assert(evt[1] === 0x13, `Number-Of-Completed-Packets staged (${evt})`);
}

console.log('TEST 5: closed transport falls back to local');
{
    plantMagic();
    fakeOpen = false;
    const { pump } = makePump();
    pump.setMode('bumble');
    pump.setTransport(fakeTransport);
    const r = pump.handleBFrame(RESET);
    assert(r === 'local', `route=local (got ${r})`);
    assert(flagWord() === 1, 'mirror flag==1 (local answer)');
    fakeOpen = true;
}

if (failures) {
    console.log(`\nBLE PUMP: ${failures} FAILURE(S)`);
    process.exit(1);
}
console.log('\nBLE PUMP PASSED (local + forward + gaps + ACL + fallback) ✅');
