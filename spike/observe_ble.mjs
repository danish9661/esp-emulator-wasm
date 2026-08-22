/**
 * BLE behavior observer (option C: observe via the firmware's own debug prints).
 *
 * The simulator's native BLE hides the HCI byte stream, but the firmware's own
 * Serial/console output still surfaces. This harness runs a BLE sketch and turns
 * its [BLE] lifecycle prints into a structured state timeline. The native BLE
 * controller is treated as a black box; we only watch what the firmware reports.
 */
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const SKETCH = process.argv[2] || 'BLEDemo';
const DIR = `spike/sketches/${SKETCH}/build/esp32.esp32.esp32c3`;

const flash = new Uint8Array(readFileSync(`${DIR}/${SKETCH}.ino.merged.bin`));
const elf = new Uint8Array(readFileSync(`${DIR}/${SKETCH}.ino.elf`));

const mcu = await ESP32C3.create({ chip: 'esp32c3' });
await mcu.loadFirmware(flash, elf);

// Ordered BLE lifecycle states we expect a typical NimBLE Arduino sketch to emit.
const STATE_ORDER = [
  'starting', 'init done', 'enable done', 'server created',
  'service created', 'characteristic created', 'advertising started', 'ble-done',
];
let lastState = null;

const classify = (line) => {
  const m = line.match(/\[([A-Za-z]+)\]\s*(.*)/);
  if (!m) return { tag: null };
  const tag = m[1].toUpperCase();
  const msg = m[2].trim();
  if (tag === 'BLE') {
    const state = STATE_ORDER.find(s => msg.toLowerCase().includes(s));
    return state ? { tag, state, event: false } : { tag, state: msg, event: true };
  }
  return { tag, state: msg, event: true };
};

const t0 = Date.now();
mcu.uart0.onData((text) => {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const c = classify(line);
    if (!c.tag) { console.log(`         ${line}`); continue; }
    const ts = ((Date.now() - t0) / 1000).toFixed(2);
    if (c.tag === 'BLE' && !c.event) {
      const arrow = c.state !== lastState ? '→' : ' ';
      console.log(`[BLE ${ts}s] ${arrow} ${c.state}`);
      lastState = c.state;
    } else {
      console.log(`[${c.tag} ${ts}s]   ${c.state}`);
    }
  }
});

console.log(`=== Running ${SKETCH} (BLE behavior observer) ===`);
for (let i = 0; i < 400; i++) mcu.step(20000);
console.log(`=== Done: ${SKETCH} ===`);
