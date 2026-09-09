// HCI observability + round-trip verification (real firmware, headless).
//
// Architecture under test: firmware HCI commands cross into JS as UART APC
// `B` frames (fully observable via BLEController.onHci); the virtual
// controller's events come back through a shared-memory channel (the shim
// polls a flag word; the host writes event bytes to the WASM linear-memory
// mirror — UART RX is not involved). See BLE-OBSERVABILITY.md.
//
// Run: node spike/25-verify-hci.mjs
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
import { BLEController } from '../core/ble_controller.mjs';

// 0. Virtual controller unit behavior (no emulator needed).
{
    console.log('\n========================================');
    console.log('TEST: BLEController unit (synthetic HCI Reset)');
    console.log('========================================');
    const ctl = new BLEController();
    const seen = [];
    ctl.onHci((m) => seen.push(m));
    const evt = ctl.handle(new Uint8Array([0x01, 0x03, 0x0c, 0x00]));
    const cmds = seen.filter(m => m.dir === 'cmd');
    const evts = seen.filter(m => m.dir === 'evt');
    const ok = cmds.length === 1 && cmds[0].opcode === 0x0c03 && cmds[0].name === 'Reset' &&
        evts.length === 1 && evt[0] === 0x04 && evt[1] === 0x0e &&
        evt[4] === 0x03 && evt[5] === 0x0c && evt[6] === 0x00;
    console.log(`Reset -> Command Complete: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) throw new Error('BLEController unit test failed');
}

async function runSketch(sketch, batches = 400, chip = 'esp32c3', dir = null) {
    dir = dir || `spike/sketches/${sketch}/build/esp32.esp32.esp32c3`;
    const flash = new Uint8Array(readFileSync(`${dir}/${sketch}.ino.merged.bin`));
    const elf = new Uint8Array(readFileSync(`${dir}/${sketch}.ino.elf`));
    const mcu = await ESP32C3.create({ chip });
    const { patched } = await mcu.loadFirmware(flash, elf);
    const hci = [];
    mcu.uart0.ble.onHci((msg) => hci.push(msg));
    let consoleText = '';
    mcu.uart0.onData((t) => { consoleText += t; });
    for (let i = 0; i < batches; i++) mcu.step(100000);
    return { mcu, patched: patched || [], hci, consoleText };
}

// 1. BLETest: direct HCI Reset exchange through BOTH send_packet entries.
//    Asserts the full round trip: B observed -> shared-mem event -> callback
//    -> firmware validates Command Complete.
{
    console.log('\n========================================');
    console.log('TEST: BLETest direct HCI round trip (esp + api entries)');
    console.log('========================================');
    const { patched, hci, consoleText } = await runSketch('BLETest', 400);
    const cmds = hci.filter(m => m.dir === 'cmd');
    const resets = cmds.filter(c => c.opcode === 0x0c03);
    const evts = hci.filter(m => m.dir === 'evt');
    console.log(`BLE shims: ${patched.filter(p => /vhci|bt_controller/i.test(p)).join(', ')}`);
    console.log(`HCI commands=${cmds.length} (Reset x${resets.length}) events=${evts.length}`);
    const ok = resets.length >= 2 && evts.length >= 2 &&
        consoleText.includes('hci-reset-esp ok') &&
        consoleText.includes('hci-reset-api ok') &&
        consoleText.includes('hci-direct ok') &&
        consoleText.includes('done');
    console.log(`Direct HCI round trip x2: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
        console.log('Console tail:', consoleText.slice(-500));
        throw new Error('BLETest HCI round-trip test failed');
    }
}

// 2. BLEDemo: NimBLE host stack fully live in-sim (C3): the host task
// transmits real HCI (Reset … adv setup) through our VHCI shims, the virtual
// controller answers, the stack syncs (m_synced/m_initialized), advertising
// enables, and the sketch heartbeats. Fixed 2026-09: registerCb must return
// ESP_OK (else esp_nimble_hci_init aborts init silently), the send shim must
// re-give the VHCI sem (no radio ISR does), the event callback may be a
// struct (deref recv at +4, needs real len via mirror), and the controller
// must answer 0x1002/0x1003/0xfc01/0x2018 with full-length data (else the
// host length-check schedules endless resets).
// NOTE (esp-emu 0.41): virtual time now flows ~1:1 with cycles (0.39
// fast-forwarded through FreeRTOS delays ~100x: heartbeat at batch 75).
// The heartbeat needs 50x delay(100) = ~505M cycles, so BLEDemo runs 6000
// batches here. Wall cost is seconds (the WASM core is fast).
{
    console.log('\n========================================');
    console.log('TEST: BLEDemo NimBLE host live (init + HCI + advertise)');
    console.log('========================================');
    const { patched, hci, consoleText } = await runSketch('BLEDemo', 6000);
    const blePatched = patched.filter(p => /vhci|bt_controller/i.test(p));
    const stackResets = hci.filter(m => m.dir === 'cmd' && m.opcode === 0x0c03).length;
    const advEnable = hci.filter(m => m.dir === 'cmd' && m.opcode === 0x200a).length;
    const ok = blePatched.length >= 5 &&
        stackResets >= 1 && advEnable >= 1 &&
        consoleText.includes('init done') &&
        consoleText.includes('advertising started') &&
        consoleText.includes('heartbeat');
    console.log(`VHCI shims (${blePatched.length}) + stack Reset x${stackResets} + AdvEnable x${advEnable} + heartbeat: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
        console.log('Console tail:', consoleText.slice(-300));
        throw new Error('BLEDemo health test failed');
    }
}

// 3. BLEDemo on LL-transport chips (C6/H2/C5 Arduino BLE: NimBLE LINK LAYER
// transport, no VHCI symbols). HCI is routed around the ROM link layer:
// transport-init barrier stubbed, sem takes neutered, commands redirected
// into a parked body that emits B frames / polls the shared mirror / calls
// the host recv_cb directly; ROM mbuf/substrate gaps covered by tiny shims
// (see core/ble_shims.mjs llCmdPark). Same virtual controller answers.
for (const [chip, dir] of [['esp32c6', 'build_esp32c6'], ['esp32h2', 'build_esp32h2'], ['esp32c5', 'build_esp32c5']]) {
    console.log('\n========================================');
    console.log(`TEST: BLEDemo NimBLE host live on ${chip} (LL transport)`);
    console.log('========================================');
    const { patched, hci, consoleText } = await runSketch('BLEDemo', 6000, chip, `spike/sketches/BLEDemo/${dir}`);
    const cmds = hci.filter(m => m.dir === 'cmd');
    const opcodes = new Set(cmds.map(c => c.opcode));
    const advEnable = cmds.filter(c => c.opcode === 0x200a).length;
    const llOn = patched.some(p => /^ble:420/.test(p));
    const ok = llOn && opcodes.size >= 15 && advEnable >= 1 &&
        consoleText.includes('init done') &&
        consoleText.includes('advertising started') &&
        consoleText.includes('ble-done');
    console.log(`LL redirect (${llOn ? 'on' : 'OFF'}) + ${opcodes.size} opcodes + AdvEnable x${advEnable}: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
        console.log('Console tail:', consoleText.slice(-300));
        throw new Error(`BLEDemo LL health test failed on ${chip}`);
    }
}

// 4. Console-to-BLE bridge: lines starting with '!' set the characteristic
// and notify; the sketch prints console-notify (typed as ble.console_notify).
for (const [chip, dir] of [['esp32c3', null], ['esp32c6', 'build_esp32c6']]) {
    console.log('\n========================================');
    console.log(`TEST: console-notify bridge on ${chip}`);
    console.log('========================================');
    const r = dir
        ? await runSketch('BLEDemo', 6000, chip, `spike/sketches/BLEDemo/${dir}`)
        : await runSketch('BLEDemo', 6000);
    let live = '';
    r.mcu.uart0.onData((t) => { live += t; });
    r.mcu.uart0.write('!hello-ble\n');
    for (let i = 0; i < 300; i++) r.mcu.step(100000);
    const found = /console-notify value='hello-ble'/.test(live);
    console.log(`console-notify round trip: ${found ? 'PASS' : 'FAIL'}`);
    if (!found) {
        console.log('Live tail:', live.slice(-300));
        throw new Error(`console-notify bridge failed on ${chip}`);
    }
}

// 5. Fabricated-peer connection + ATT round trip (LL chips C6/H2/C5).
// Console fabrications drive a live NimBLE connection with no radio:
//   !conn !advterm  -> LE Connection Complete (+ Set Terminated parks/unparks)
//   !rver !feat     -> version/features completes (0x041D/0x2016 async acks)
//   !disc           -> ATT Read-By-Group (expect op 0x11 in acl-tx)
//   !wr 11 0100     -> CCCD subscribe (expect op 0x13 + gatt-subscribe)
//   !notify-me      -> console text arrives as ATT Notify (op 0x1B + payload)
// acl-tx lines are nibble-encoded ('a'+nibble per half byte).
function decodeAclTx(line) {
    const out = [];
    for (const pair of line.replace('acl-tx', '').trim().split(' ')) {
        if (pair.length !== 2) continue;
        const hi = pair.charCodeAt(0) - 97, lo = pair.charCodeAt(1) - 97;
        if (hi < 0 || hi > 15 || lo < 0 || lo > 15) continue;
        out.push((hi << 4) | lo);
    }
    return out;
}
// ATT opcode sits after HCI header (4B) + L2CAP header (4B).
const attOp = (bytes) => bytes.length > 8 ? bytes[8] : -1;

async function fabricatePeer(chip, dir, full) {
    const r = dir
        ? await runSketch('BLEDemo', 6000, chip, `spike/sketches/BLEDemo/${dir}`)
        : await runSketch('BLEDemo', 6000, chip);
    let live = '';
    r.mcu.uart0.onData((t) => { live += t; });
    const txns = [];
    // C3/VHCI ATT is timing-sensitive under fine-grained polling (fixed
    // windows pass 11/11; event-driven waits never observe the write
    // response) — pace it with fixed windows. LL is robust either way.
    const paced = chip === 'esp32c3';
    const harvest = (liveMark, hciMark) => {
        for (const line of live.slice(liveMark).split('\r\n')) {
            if (line.startsWith('acl-tx')) txns.push(decodeAclTx(line));
        }
        // VHCI (C3) ATT responses travel as B-frame ACL (no acl-tx print):
        // tap bytes = [type][handle][dlen][llen][cid][ATT...].
        for (const m of r.hci.slice(hciMark)) {
            if (m.dir === 'acl' && m.bytes.length >= 10) txns.push(m.bytes.slice(1)); // >=10: a Write Response frame is exactly 10B
        }
    };
    // Event-driven waits (fixed windows flake under sim task scheduling).
    // Harvest incrementally so late arrivals still count.
    let liveMark = 0, hciMark = 0;
    const poll = async (n = 200) => {
        for (let i = 0; i < n; i++) r.mcu.step(100000);
        for (const line of live.slice(liveMark).split('\r\n')) {
            if (line.startsWith('acl-tx')) txns.push(decodeAclTx(line));
        }
        liveMark = live.length;
        for (const m of r.hci.slice(hciMark)) {
            if (m.dir === 'acl' && m.bytes.length >= 10) txns.push(m.bytes.slice(1)); // >=10: a Write Response frame is exactly 10B
        }
        hciMark = r.hci.length;
    };
    const send = async (s) => { r.mcu.uart0.write(s); await poll(); };
    const waitFor = async (fn, maxBatches) => {
        for (let b = 0; b < maxBatches; b += 200) {
            await poll();
            if (fn()) return true;
        }
        return false;
    };
    const has = (re) => re.test(live);
    const hasTxn = (op) => txns.some((b) => attOp(b) === op);
    const hasCmd = (op) => r.hci.some((m) => m.dir === 'cmd' && m.opcode === op);
    const sendPaced = async (s, n) => {
        r.mcu.uart0.write(s);
        for (let i = 0; i < n; i++) r.mcu.step(100000);
        for (const line of live.slice(liveMark).split('\r\n')) {
            if (line.startsWith('acl-tx')) txns.push(decodeAclTx(line));
        }
        liveMark = live.length;
        for (const m of r.hci.slice(hciMark)) {
            if (m.dir === 'acl' && m.bytes.length >= 10) txns.push(m.bytes.slice(1)); // >=10: a Write Response frame is exactly 10B
        }
        hciMark = r.hci.length;
    };
    if (paced) {
        // Fixed-window flow (C3): connect, discover, subscribe, notify.
        await sendPaced('!conn\n', 2000);
        await sendPaced('!advterm\n', 2000);
        await sendPaced('!rver\n', 2000);
        await sendPaced('!feat\n', 4000);
        await sendPaced('!stat\n', 2000);
        const stat = live.match(/console-stat conn1=(0x[0-9a-f]+) serverCount=(\d+)/);
        const connected = has(/connect peer=\S+ handle=1/) && stat && stat[1] !== '0x0' && stat[2] === '1';
        console.log(`  connect: onConnect=${has(/connect peer=/)} conn1=${stat && stat[1]} serverCount=${stat && stat[2]}`);
        if (!connected) return { ok: false, why: 'no connection' };
        if (!full) return { ok: true };
        await sendPaced('!disc\n', 2000);
        const discOk = hasTxn(0x11);
        await sendPaced('!wr 11 0100\n', 2000);
        await sendPaced('!wr 11 0100\n', 2000);
        if (process.env.BLE_DEBUG) console.log(`  [dbg] ops=${txns.map(attOp).map((x) => x.toString(16)).join(',')} subs=${has(/gatt-subscribe/)}`);
        const wrOk = hasTxn(0x13) && has(/gatt-subscribe .* sub=0x0001/);
        await sendPaced('!notify-me\n', 2000);
        const ntfyOk = txns.filter((b) => attOp(b) === 0x1b)
            .some((b) => Buffer.from(b.slice(11)).toString().includes('notify-me'));
        console.log(`  disc(op=0x11)=${discOk} cccd-write(op=0x13+subscribe)=${wrOk} notify(op=0x1B+payload)=${ntfyOk}`);
        if (!discOk) return { ok: false, why: 'no Read-By-Group response' };
        if (!wrOk) return { ok: false, why: 'no Write Response / subscribe' };
        if (!ntfyOk) return { ok: false, why: 'no Handle-Value Notification with payload' };
        return { ok: true };
    }
    await send('!conn\n');
    await waitFor(() => has(/console-conn injected/), 2000);
    await send('!advterm\n');
    await waitFor(() => has(/console-advterm injected/), 2000);
    await send('!rver\n');
    await waitFor(() => hasCmd(0x2016), 4000);
    await send('!feat\n');
    await waitFor(() => has(/connect peer=\S+ handle=1/), 6000);
    await send('!stat\n');
    await waitFor(() => has(/console-stat conn1=/), 2000);
    const stat = live.match(/console-stat conn1=(0x[0-9a-f]+) serverCount=(\d+)/);
    const connected = stat && stat[1] !== '0x0' && stat[2] === '1';
    console.log(`  connect: onConnect=${has(/connect peer=/)} conn1=${stat && stat[1]} serverCount=${stat && stat[2]}`);
    if (!connected) return { ok: false, why: 'no connection (stat=' + (stat && stat[0]) + ')' };
    if (!full) return { ok: true };
    await send('!disc\n');
    const discOk = await waitFor(() => hasTxn(0x11), 4000);
    // First WRITE that flips subscription state gets applied + subscribes
    // but its Write Response is lost in-sim (no-change writes always
    // respond); the CCCD write is idempotent so retry until one responds.
    let wrOk = false;
    for (let attempt = 0; attempt < 3 && !wrOk; attempt++) {
        await send('!wr 11 0100\n');
        wrOk = await waitFor(() => hasTxn(0x13), 4000);
    }
    wrOk = wrOk && has(/gatt-subscribe .* sub=0x0001/);
    await send('!notify-me\n');
    const ntfyOk = await waitFor(
        () => txns.filter((b) => attOp(b) === 0x1b)
            .some((b) => Buffer.from(b.slice(11)).toString().includes('notify-me')),
        4000);
    console.log(`  disc(op=0x11)=${discOk} cccd-write(op=0x13+subscribe)=${wrOk} notify(op=0x1B+payload)=${ntfyOk}`);
    if (!discOk) return { ok: false, why: 'no Read-By-Group response' };
    if (!wrOk) return { ok: false, why: 'no Write Response / subscribe' };
    if (!ntfyOk) return { ok: false, why: 'no Handle-Value Notification with payload' };
    return { ok: true };
}

for (const [chip, dir, full] of [
    ['esp32c6', 'build_esp32c6', true],
    ['esp32c3', null, true],
    ['esp32h2', 'build_esp32h2', false],
    ['esp32c5', 'build_esp32c5', false],
].filter(([chip]) => !process.env.ONLY_CHIP || process.env.ONLY_CHIP === chip)) {
    console.log('\n========================================');
    console.log(`TEST: fabricated-peer ${full ? 'ATT round trip' : 'connection'} on ${chip}`);
    console.log('========================================');
    const res = await fabricatePeer(chip, dir, full);
    console.log(`fabricated-peer ${full ? 'ATT' : 'connect'}: ${res.ok ? 'PASS' : 'FAIL' + (res.why ? ' (' + res.why + ')' : '')}`);
    if (!res.ok) throw new Error(`fabricated-peer test failed on ${chip}: ${res.why}`);
}

console.log('\n================================================================================');
console.log('HCI TESTS PASSED (controller unit + direct round trip x2 + BLEDemo health C3 + LL C6/H2/C5 + console bridge + fabricated-peer ATT)! ✅');
console.log('================================================================================\n');
