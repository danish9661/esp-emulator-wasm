/**
 * Regression test for the BleInspector parser (spike/ble_inspector.mjs).
 * Standalone (no test framework): feed sample firmware console lines and assert
 * the parsed events. Exits non-zero on any failure.
 *
 *   node spike/ble_inspector.test.mjs
 */
import assert from 'node:assert';
import { parseLine, BleInspector } from './ble_inspector.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + name); }
}
function eq(name, a, b) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  check(name + ' (' + sa + ' === ' + sb + ')', sa === sb);
}

// Non-tagged / plain console lines must be ignored.
check('boot line is null', parseLine('ESP-ROM:esp32c3-api1-20210207') === null);
check('flash load line is null', parseLine('         load:0x3fcd5820,len:0x110c') === null);
check('empty line is null', parseLine('') === null);

// BLE lifecycle + identity.
eq('ble starting', parseLine('[BLE] starting'), { type: 'ble.state', state: 'starting' });
eq('ble init_done', parseLine('[BLE] init done'), { type: 'ble.state', state: 'init_done' });
eq('ble server_created', parseLine('[BLE] server created'), { type: 'ble.state', state: 'server_created' });
eq('ble done', parseLine('[BLE] ble-done'), { type: 'ble.state', state: 'done' });
eq('ble mac', parseLine('[BLE] local-mac=01:00:00:c4:0a:24'), { type: 'ble.mac', mac: '01:00:00:c4:0a:24' });

// BLE GATT objects.
eq('ble service', parseLine('[BLE] service created uuid=0xdead'), { type: 'ble.service', uuid: '0xdead' });
eq('ble characteristic', parseLine("[BLE] characteristic uuid=0xbeef props=0x1a value='Burger'"),
    { type: 'ble.characteristic', uuid: '0xbeef', props: 0x1a, value: 'Burger' });
eq('ble advertising', parseLine("[BLE] advertising started name='NimBLE-Server' scan-response=1"),
    { type: 'ble.advertising', name: 'NimBLE-Server', scanResponse: true });
eq('ble heartbeat', parseLine('[BLE] heartbeat uptime=5000ms connections=0'),
    { type: 'ble.heartbeat', uptimeMs: 5000, connections: 0 });
eq('ble gatt_notify', parseLine("[BLE] gatt-notify uuid=0xbeef value='tick-0'"),
    { type: 'ble.gatt_notify', uuid: '0xbeef', value: 'tick-0' });
eq('ble connect', parseLine('[BLE] connect peer=aa:bb:cc:dd:ee:ff handle=1'),
    { type: 'ble.connect', peer: 'aa:bb:cc:dd:ee:ff', handle: 1 });
eq('ble disconnect', parseLine('[BLE] disconnect peer=aa:bb:cc:dd:ee:ff reason=0x13'),
    { type: 'ble.disconnect', peer: 'aa:bb:cc:dd:ee:ff', reason: '0x13' });
eq('ble gatt_read', parseLine('[BLE] gatt-read peer=aa:bb:cc:dd:ee:ff uuid=0xbeef'),
    { type: 'ble.gatt_read', peer: 'aa:bb:cc:dd:ee:ff', uuid: '0xbeef' });
const gw = parseLine('[BLE] gatt-write peer=aa:bb:cc:dd:ee:ff uuid=0xbeef len=3: 01 02 03 ');
eq('ble gatt_write type', gw.type, 'ble.gatt_write');
eq('ble gatt_write len', gw.len, 3);
eq('ble gatt_write bytes', gw.bytes, '01 02 03');
eq('ble gatt_subscribe', parseLine('[BLE] gatt-subscribe peer=aa:bb:cc:dd:ee:ff uuid=0xbeef sub=0x0001'),
    { type: 'ble.gatt_subscribe', peer: 'aa:bb:cc:dd:ee:ff', uuid: '0xbeef', sub: '0x0001' });
eq('ble mtu_change', parseLine('[BLE] mtu-change peer=aa:bb:cc:dd:ee:ff mtu=23'),
    { type: 'ble.mtu_change', peer: 'aa:bb:cc:dd:ee:ff', mtu: 23 });
eq('ble other', parseLine('[BLE] something unexpected'), { type: 'ble.other', text: 'something unexpected' });

// DETECT.
eq('detect mac', parseLine('[DETECT] local-mac=01:00:00:c4:0a:24'), { type: 'detect.mac', mac: '01:00:00:c4:0a:24' });
const ds = parseLine('[DETECT] esp_bt_controller_init                   @4201538a w0=00000513 -> STUB: returns constant (real impl supplied by loader at runtime)');
eq('detect symbol type', ds.type, 'detect.symbol');
eq('detect symbol name', ds.name, 'esp_bt_controller_init');
eq('detect symbol addr', ds.addr, '4201538a');
eq('detect symbol w0', ds.w0, '00000513');
check('detect symbol classification is STUB', ds.classification.indexOf('STUB') === 0);
eq('detect done', parseLine('[DETECT] done'), { type: 'detect.done' });
eq('detect heartbeat', parseLine('[DETECT] heartbeat loop=3 send_available=1'),
    { type: 'detect.heartbeat', loop: 3, sendAvailable: 1 });

// TEST.
eq('test mac', parseLine('[TEST] local-mac=01:00:00:c4:0a:24'), { type: 'test.mac', mac: '01:00:00:c4:0a:24' });
eq('test send_available', parseLine('[TEST] send_available before init: 1'),
    { type: 'test.send_available', phase: 'before init', available: 1 });
eq('test init', parseLine('[TEST] init returned: 0'), { type: 'test.init', returned: 0 });
eq('test enable', parseLine('[TEST] enable returned: 0'), { type: 'test.enable', returned: 0 });
eq('test send_hci_reset', parseLine('[TEST] sending HCI reset (send_available=1)'),
    { type: 'test.send_hci_reset', available: 1 });
eq('test done', parseLine('[TEST] done'), { type: 'test.done' });
eq('test heartbeat', parseLine('[TEST] heartbeat loop=3 send_available=1'),
    { type: 'test.heartbeat', loop: 3, sendAvailable: 1 });

// BleInspector accumulates events with timestamps.
const ins = new BleInspector();
const got = ins.feed('[BLE] starting\n[BLE] init done\n');
check('inspector.feed returns 2 events', got.length === 2);
check('inspector.events has 2', ins.events.length === 2);
check('inspector event has numeric t', typeof ins.events[0].t === 'number');
check('inspector timestamps non-negative', ins.events[0].t >= 0 && ins.events[1].t >= 0);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
