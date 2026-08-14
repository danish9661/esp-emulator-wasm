// Phase 0 decisive test: bare-metal poll of UART0 RX FIFO, echo each byte +1.
// Proves a shim can receive a host->guest response without the console driver.
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';
const fw = new Uint8Array(readFileSync(new URL('./uartecho.bin', import.meta.url)));
const { emu } = await boot({ chip: 'esp32c3', firmware: fw, bootFromRom: false });
for (let i = 0; i < 3; i++) emu.run_batch(2000);
for (const msg of ['Hi', 'ABC']) {
    emu.uart_input(new Uint8Array([...msg].map(c => c.charCodeAt(0))));
    let out = '';
    for (let i = 0; i < 5; i++) out += emu.run_batch(2000);
    const want = [...msg].map(c => String.fromCharCode(c.charCodeAt(0) + 1)).join('');
    console.log(`sent ${JSON.stringify(msg)} -> got ${JSON.stringify(out)} (expect ${JSON.stringify(want)}) ${out === want ? 'PASS' : 'FAIL'}`);
}
