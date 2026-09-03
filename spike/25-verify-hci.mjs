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

async function runSketch(sketch, batches = 400) {
    const dir = `spike/sketches/${sketch}/build/esp32.esp32.esp32c3`;
    const flash = new Uint8Array(readFileSync(`${dir}/${sketch}.ino.merged.bin`));
    const elf = new Uint8Array(readFileSync(`${dir}/${sketch}.ino.elf`));
    const mcu = await ESP32C3.create({ chip: 'esp32c3' });
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

// 2. BLEDemo: init path live (patched VHCI shims), firmware healthy.
// NOTE (esp-emu 0.41): virtual time now flows ~1:1 with cycles (0.39
// fast-forwarded through FreeRTOS delays ~100x: heartbeat at batch 75).
// The heartbeat needs 50x delay(100) = ~505M cycles, so BLEDemo runs 6000
// batches here. Wall cost is seconds (the WASM core is fast).
//    (NimBLE's own transport never transmits in the sim — its semaphore take
//    predates our init and the host never starts — so HCI bytes here come only
//    from direct calls. Firmware-console observation still applies.)
{
    console.log('\n========================================');
    console.log('TEST: BLEDemo health via patched init path');
    console.log('========================================');
    const { patched, consoleText } = await runSketch('BLEDemo', 6000);
    const blePatched = patched.filter(p => /vhci|bt_controller/i.test(p));
    const ok = blePatched.length >= 5 &&
        consoleText.includes('init done') &&
        consoleText.includes('advertising started') &&
        consoleText.includes('heartbeat');
    console.log(`VHCI shims (${blePatched.length}) + init/advertise/heartbeat: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
        console.log('Console tail:', consoleText.slice(-300));
        throw new Error('BLEDemo health test failed');
    }
}

console.log('\n================================================================================');
console.log('HCI TESTS PASSED (controller unit + direct round trip x2 + BLEDemo health)! ✅');
console.log('================================================================================\n');
