/**
 * BleInspector — parses the firmware's own console output (from BLEDemo /
 * BLEDetect / BLETest, enriched via arduino-cli) into structured observation
 * events.
 *
 * The wasm's native BLE is a black box, so we only ever observe what the
 * firmware chooses to Serial.print. This module turns those [BLE]/[DETECT]/
 * [TEST] lines into typed, machine-readable events for downstream tooling.
 */

const HEX = /0x[0-9a-fA-F]+/;

export function parseLine(line) {
  const m = line.match(/\[([A-Za-z]+)\]\s*(.*)/);
  if (!m) return null;
  const tag = m[1].toUpperCase();
  const msg = m[2].trim();
  if (tag === 'BLE')    return parseBle(msg);
  if (tag === 'DETECT') return parseDetect(msg);
  if (tag === 'TEST')   return parseTest(msg);
  return null;
}

function parseBle(msg) {
  let mm;
  if (msg === 'starting')                 return { type: 'ble.state', state: 'starting' };
  if (msg === 'init done')                return { type: 'ble.state', state: 'init_done' };
  if (msg === 'server created')           return { type: 'ble.state', state: 'server_created' };
  if (msg === 'service created')          return { type: 'ble.state', state: 'service_created' };
  if (msg === 'advertising started')      return { type: 'ble.state', state: 'advertising_started' };
  if (msg === 'ble-done')                 return { type: 'ble.state', state: 'done' };
  if ((mm = msg.match(/^local-mac=(\S+)$/)))
                                           return { type: 'ble.mac', mac: mm[1] };
  if ((mm = msg.match(/^service created uuid=(\S+)$/)))
                                           return { type: 'ble.service', uuid: mm[1] };
  if ((mm = msg.match(/^characteristic uuid=(\S+) props=(0x[0-9a-fA-F]+) value='([^']*)'$/)))
                                           return { type: 'ble.characteristic', uuid: mm[1], props: parseInt(mm[2], 16), value: mm[3] };
  if ((mm = msg.match(/^advertising started name='([^']*)' scan-response=(\d)$/)))
                                           return { type: 'ble.advertising', name: mm[1], scanResponse: mm[2] === '1' };
  if ((mm = msg.match(/^heartbeat uptime=(\d+)ms connections=(\d+)$/)))
                                           return { type: 'ble.heartbeat', uptimeMs: +mm[1], connections: +mm[2] };
  if ((mm = msg.match(/^gatt-notify uuid=(\S+) value='([^']*)'$/)))
                                           return { type: 'ble.gatt_notify', uuid: mm[1], value: mm[2] };
  if ((mm = msg.match(/^connect peer=(\S+) handle=(\d+)$/)))
                                           return { type: 'ble.connect', peer: mm[1], handle: +mm[2] };
  if ((mm = msg.match(/^disconnect peer=(\S+) reason=(0x[0-9a-fA-F]+)$/)))
                                           return { type: 'ble.disconnect', peer: mm[1], reason: mm[2] };
  if ((mm = msg.match(/^gatt-read peer=(\S+) uuid=(\S+)$/)))
                                           return { type: 'ble.gatt_read', peer: mm[1], uuid: mm[2] };
  if ((mm = msg.match(/^gatt-write peer=(\S+) uuid=(\S+) len=(\d+):\s*(.*)$/)))
                                           return { type: 'ble.gatt_write', peer: mm[1], uuid: mm[2], len: +mm[3], bytes: mm[4].trim() };
  if ((mm = msg.match(/^gatt-subscribe peer=(\S+) uuid=(\S+) sub=(0x[0-9a-fA-F]+)$/)))
                                           return { type: 'ble.gatt_subscribe', peer: mm[1], uuid: mm[2], sub: mm[3] };
  if ((mm = msg.match(/^mtu-change peer=(\S+) mtu=(\d+)$/)))
                                           return { type: 'ble.mtu_change', peer: mm[1], mtu: +mm[2] };
  return { type: 'ble.other', text: msg };
}

function parseDetect(msg) {
  let mm;
  if ((mm = msg.match(/^local-mac=(\S+)$/)))
                                           return { type: 'detect.mac', mac: mm[1] };
  if ((mm = msg.match(/^(\S+)\s+@(\w+)\s+w0=(\w+)\s+->\s+(.*)$/)))
                                           return { type: 'detect.symbol', name: mm[1], addr: mm[2], w0: mm[3], classification: mm[4] };
  if (msg === 'done')                      return { type: 'detect.done' };
  if ((mm = msg.match(/^heartbeat loop=(\d+) send_available=(\d+)$/)))
                                           return { type: 'detect.heartbeat', loop: +mm[1], sendAvailable: +mm[2] };
  return { type: 'detect.other', text: msg };
}

function parseTest(msg) {
  let mm;
  if ((mm = msg.match(/^local-mac=(\S+)$/)))
                                           return { type: 'test.mac', mac: mm[1] };
  if ((mm = msg.match(/^send_available ([^:]+): (\d+)$/)))
                                           return { type: 'test.send_available', phase: mm[1], available: +mm[2] };
  if ((mm = msg.match(/^init returned: (\d+)$/)))
                                           return { type: 'test.init', returned: +mm[1] };
  if ((mm = msg.match(/^enable returned: (\d+)$/)))
                                           return { type: 'test.enable', returned: +mm[1] };
  if ((mm = msg.match(/^sending HCI reset(?: via (\S+))? \(send_available=(\d+)\)$/))) {
                                           const ev = { type: 'test.send_hci_reset', available: +mm[2] };
                                           if (mm[1]) ev.via = mm[1];
                                           return ev;
  }
  if ((mm = msg.match(/^send returned: (\d+)$/)))
                                           return { type: 'test.send_returned', returned: +mm[1] };
  if ((mm = msg.match(/^hci-evt-(\S+) len=(\d+):\s*(.*)$/)))
                                           return { type: 'test.hci_evt', which: mm[1], len: +mm[2], bytes: mm[3].trim() };
  if ((mm = msg.match(/^hci-reset-(\S+) (ok|FAIL)$/)))
                                           return { type: 'test.hci_reset', which: mm[1], ok: mm[2] === 'ok' };
  if ((mm = msg.match(/^hci-direct (ok|FAIL)$/)))
                                           return { type: 'test.hci_direct', ok: mm[1] === 'ok' };
  if (msg === 'done')                      return { type: 'test.done' };
  if ((mm = msg.match(/^heartbeat loop=(\d+) send_available=(\d+)$/)))
                                           return { type: 'test.heartbeat', loop: +mm[1], sendAvailable: +mm[2] };
  return { type: 'test.other', text: msg };
}

/**
 * Accumulates parsed events from a stream of console text.
 * Each event gets a relative timestamp (ms since construction).
 */
export class BleInspector {
  constructor() { this.t0 = Date.now(); this.events = []; }
  /** Feed a chunk of console text; returns the events parsed from it. */
  feed(text) {
    const out = [];
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\r$/, '');
      const ev = parseLine(line);
      if (ev) {
        ev.t = Date.now() - this.t0;
        this.events.push(ev);
        out.push(ev);
      }
    }
    return out;
  }
}
