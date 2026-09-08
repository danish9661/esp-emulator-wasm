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

console.log('\n================================================================================');
console.log('HCI TESTS PASSED (controller unit + direct round trip x2 + BLEDemo health C3 + LL C6/H2/C5)! ✅');
console.log('================================================================================\n');
