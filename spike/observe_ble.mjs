/**
 * BLE behavior observer (option C: observe via the firmware's own debug prints).
 *
 * The simulator's native BLE hides the HCI byte stream, but the firmware's own
 * Serial/console output still surfaces. This harness runs a BLE sketch, feeds its
 * console through BleInspector, and either prints a human-readable timeline or
 * (with --json) a stream of structured events (JSON Lines). The native BLE
 * controller is treated as a black box; we only watch what the firmware reports.
 *
 *   node spike/observe_ble.mjs [Sketch] [--json]
 *     Sketch defaults to BLEDemo (also: BLEDetect, BLETest)
 */
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
import { parseLine, BleInspector } from './ble_inspector.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const SKETCH = args.find(a => !a.startsWith('--')) || 'BLEDemo';
const DIR = `spike/sketches/${SKETCH}/build/esp32.esp32.esp32c3`;

const flash = new Uint8Array(readFileSync(`${DIR}/${SKETCH}.ino.merged.bin`));
const elf = new Uint8Array(readFileSync(`${DIR}/${SKETCH}.ino.elf`));

const mcu = await ESP32C3.create({ chip: 'esp32c3' });
await mcu.loadFirmware(flash, elf);

const inspector = new BleInspector();
let lastState = null;

function renderHuman(ev) {
  const tag = ev.type.split('.')[0].toUpperCase();
  let text;
  switch (ev.type) {
    case 'ble.state':          text = ev.state; break;
    case 'ble.mac':            text = `local-mac=${ev.mac}`; break;
    case 'ble.service':        text = `service created uuid=${ev.uuid}`; break;
    case 'ble.characteristic': text = `characteristic uuid=${ev.uuid} props=0x${ev.props.toString(16)} value='${ev.value}'`; break;
    case 'ble.advertising':    text = `advertising started name='${ev.name}' scan-response=${ev.scanResponse ? 1 : 0}`; break;
    case 'ble.heartbeat':      text = `heartbeat uptime=${ev.uptimeMs}ms connections=${ev.connections}`; break;
    case 'ble.gatt_notify':    text = `gatt-notify uuid=${ev.uuid} value='${ev.value}'`; break;
    case 'ble.connect':        text = `connect peer=${ev.peer} handle=${ev.handle}`; break;
    case 'ble.disconnect':     text = `disconnect peer=${ev.peer} reason=${ev.reason}`; break;
    case 'ble.gatt_read':      text = `gatt-read peer=${ev.peer} uuid=${ev.uuid}`; break;
    case 'ble.gatt_write':     text = `gatt-write peer=${ev.peer} uuid=${ev.uuid} len=${ev.len}: ${ev.bytes}`; break;
    case 'ble.gatt_subscribe': text = `gatt-subscribe peer=${ev.peer} uuid=${ev.uuid} sub=${ev.sub}`; break;
    case 'ble.mtu_change':     text = `mtu-change peer=${ev.peer} mtu=${ev.mtu}`; break;
    case 'ble.other':          text = ev.text; break;
    case 'detect.mac':         text = `local-mac=${ev.mac}`; break;
    case 'detect.symbol':      text = `${ev.name} @${ev.addr} w0=${ev.w0} -> ${ev.classification}`; break;
    case 'detect.done':        text = 'done'; break;
    case 'detect.heartbeat':   text = `heartbeat loop=${ev.loop} send_available=${ev.sendAvailable}`; break;
    case 'detect.other':       text = ev.text; break;
    case 'test.mac':           text = `local-mac=${ev.mac}`; break;
    case 'test.send_available':text = `send_available ${ev.phase}: ${ev.available}`; break;
    case 'test.init':          text = `init returned: ${ev.returned}`; break;
    case 'test.enable':        text = `enable returned: ${ev.returned}`; break;
    case 'test.send_hci_reset':text = `sending HCI reset (send_available=${ev.available})`; break;
    case 'test.done':          text = 'done'; break;
    case 'test.heartbeat':     text = `heartbeat loop=${ev.loop} send_available=${ev.sendAvailable}`; break;
    case 'test.other':         text = ev.text; break;
    default:                   text = JSON.stringify(ev);
  }
  const ts = (ev.t / 1000).toFixed(2);
  if (ev.type === 'ble.state') {
    const arrow = ev.state !== lastState ? '→' : ' ';
    lastState = ev.state;
    return `[BLE ${ts}s] ${arrow} ${text}`;
  }
  return `[${tag} ${ts}s]   ${text}`;
}

mcu.uart0.onData((text) => {
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const ev = parseLine(line);
    if (ev) {
      ev.t = Date.now() - inspector.t0;
      inspector.events.push(ev);
      console.log(json ? JSON.stringify(ev) : renderHuman(ev));
    } else {
      console.log(`         ${line}`);
    }
  }
});

console.log(`=== Running ${SKETCH} (BLE behavior observer${json ? ', JSON' : ''}) ===`);
for (let i = 0; i < 400; i++) mcu.step(20000);
console.log(`=== Done: ${SKETCH} (${inspector.events.length} events) ===`);
