/**
 * BleSession reporter — aggregates a stream of BleInspector events into one
 * structured BLE "session" report, so the observer output is consumable
 * rather than a raw event stream.
 *
 *   import { buildReport } from './ble_report.mjs';
 *   const report = buildReport(inspector.events);
 */

export function buildReport(events) {
  const r = {
    identity: { mac: null },
    lifecycle: [],
    services: [],
    characteristics: [],
    advertising: null,
    gatt: { reads: [], writes: [], notifies: [], subscribes: [], mtuChanges: [] },
    connections: [],
    detect: { mac: null, symbols: [] },
    test: { mac: null, init: null, enable: null, sendAvailable: [], heartbeats: [] },
    counts: {},
  };

  for (const e of events) {
    r.counts[e.type] = (r.counts[e.type] || 0) + 1;
    switch (e.type) {
      case 'ble.mac':            r.identity.mac = e.mac; break;
      case 'ble.state':          r.lifecycle.push(e.state); break;
      case 'ble.service':        r.services.push({ uuid: e.uuid }); break;
      case 'ble.characteristic': r.characteristics.push({ uuid: e.uuid, props: e.props, value: e.value }); break;
      case 'ble.advertising':    r.advertising = { name: e.name, scanResponse: e.scanResponse }; break;
      case 'ble.heartbeat':      r.lastHeartbeat = { uptimeMs: e.uptimeMs, connections: e.connections }; break;
      case 'ble.gatt_read':      r.gatt.reads.push({ peer: e.peer, uuid: e.uuid }); break;
      case 'ble.gatt_write':     r.gatt.writes.push({ peer: e.peer, uuid: e.uuid, len: e.len, bytes: e.bytes }); break;
      case 'ble.gatt_notify':    r.gatt.notifies.push({ uuid: e.uuid, value: e.value }); break;
      case 'ble.gatt_subscribe': r.gatt.subscribes.push({ peer: e.peer, uuid: e.uuid, sub: e.sub }); break;
      case 'ble.mtu_change':     r.gatt.mtuChanges.push({ peer: e.peer, mtu: e.mtu }); break;
      case 'ble.connect':        r.connections.push({ peer: e.peer, handle: e.handle, disconnected: false }); break;
      case 'ble.disconnect': {
        const c = r.connections.find(c => c.peer === e.peer && !c.disconnected);
        if (c) { c.disconnected = true; c.reason = e.reason; }
        else r.connections.push({ peer: e.peer, disconnected: true, reason: e.reason });
        break;
      }
      case 'detect.mac':         r.detect.mac = e.mac; break;
      case 'detect.symbol':      r.detect.symbols.push({ name: e.name, addr: e.addr, w0: e.w0, classification: e.classification }); break;
      case 'test.mac':           r.test.mac = e.mac; break;
      case 'test.init':          r.test.init = e.returned; break;
      case 'test.enable':        r.test.enable = e.returned; break;
      case 'test.send_available':r.test.sendAvailable.push({ phase: e.phase, available: e.available }); break;
      case 'test.heartbeat':     r.test.heartbeats.push({ loop: e.loop, sendAvailable: e.sendAvailable }); break;
      default: break;
    }
  }
  return r;
}

const STATE_LABEL = {
  starting: 'starting', 'init_done': 'init done', 'server_created': 'server created',
  'service_created': 'service created', 'advertising_started': 'advertising started',
  'done': 'ble-done',
};

export function formatReport(r) {
  const L = [];
  L.push('--- BLE session report ---');
  L.push('identity.mac : ' + (r.identity.mac || (r.detect.mac || r.test.mac || '?')));

  const reached = r.lifecycle.map(s => STATE_LABEL[s] || s).join(' -> ');
  L.push('lifecycle    : ' + (reached || '(none)'));

  if (r.services.length) L.push('services     : ' + r.services.map(s => s.uuid).join(', '));
  if (r.characteristics.length) {
    L.push('characterist : ' + r.characteristics.map(c =>
      c.uuid + ' props=0x' + c.props.toString(16) + " value='" + c.value + "'").join('\n               '));
  }
  if (r.advertising) L.push("advertising  : name='" + r.advertising.name +
    "' scanResponse=" + r.advertising.scanResponse);

  const conns = r.connections.length;
  L.push('connections  : ' + conns + ' (' +
    r.connections.filter(c => !c.disconnected).length + ' open)');
  for (const c of r.connections) {
    L.push('   - peer=' + c.peer + ' handle=' + c.handle +
      (c.disconnected ? ' DISCONNECTED reason=' + c.reason : ' connected'));
  }

  L.push('gatt ops     : read=' + r.gatt.reads.length +
    ' write=' + r.gatt.writes.length +
    ' notify=' + r.gatt.notifies.length +
    ' subscribe=' + r.gatt.subscribes.length +
    ' mtuChange=' + r.gatt.mtuChanges.length);
  for (const w of r.gatt.writes) L.push('   - write peer=' + w.peer + ' uuid=' + w.uuid + ' len=' + w.len + ' bytes=' + w.bytes);

  if (r.detect.symbols.length) {
    L.push('vhci symbols :');
    for (const s of r.detect.symbols)
      L.push('   - ' + s.name + ' @' + s.addr + ' -> ' + s.classification);
  }
  if (r.test.init !== null || r.test.enable !== null) {
    L.push('vhci runtime : init=' + r.test.init + ' enable=' + r.test.enable);
    for (const sa of r.test.sendAvailable) L.push('   - send_available ' + sa.phase + ': ' + sa.available);
  }

  L.push('event counts : ' + JSON.stringify(r.counts));
  return L.join('\n');
}

function macOf(r) { return (r && (r.identity.mac || r.detect.mac || r.test.mac)) || null; }
function diffStr(a, b) {
  if (a === b) return { same: true, value: a };
  return { same: false, baseline: a, current: b };
}
function diffArr(a, b) {
  const A = new Set(a), B = new Set(b);
  return { added: b.filter(x => !A.has(x)), removed: a.filter(x => !B.has(x)), common: a.filter(x => B.has(x)) };
}
function diffCounts(base, cur) {
  const out = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(cur || {})]);
  for (const k of keys) {
    const b = (base && base[k]) || 0, c = (cur && cur[k]) || 0;
    if (b !== c) out[k] = { baseline: b, current: c, delta: c - b };
  }
  return out;
}

/**
 * Compare two BLE session reports (from buildReport). Returns a structured diff
 * suitable for run-to-run comparison (snapshot vs. current session).
 *   const d = diffReports(snapshot, buildReport(inspector.events));
 */
export function diffReports(base, cur) {
  return {
    mac: diffStr(macOf(base), macOf(cur)),
    lifecycle: diffArr(base.lifecycle || [], cur.lifecycle || []),
    services: diffArr((base.services || []).map(s => s.uuid), (cur.services || []).map(s => s.uuid)),
    characteristics: diffArr((base.characteristics || []).map(c => c.uuid), (cur.characteristics || []).map(c => c.uuid)),
    advertising: diffStr(
      base.advertising ? base.advertising.name + (base.advertising.scanResponse ? '(SR)' : '') : null,
      cur.advertising ? cur.advertising.name + (cur.advertising.scanResponse ? '(SR)' : '') : null),
    connections: diffArr((base.connections || []).map(c => c.peer), (cur.connections || []).map(c => c.peer)),
    gatt: {
      reads: (cur.gatt.reads.length) - (base.gatt.reads.length),
      writes: (cur.gatt.writes.length) - (base.gatt.writes.length),
      notifies: (cur.gatt.notifies.length) - (base.gatt.notifies.length),
      subscribes: (cur.gatt.subscribes.length) - (base.gatt.subscribes.length),
      mtuChanges: (cur.gatt.mtuChanges.length) - (base.gatt.mtuChanges.length),
    },
    counts: diffCounts(base.counts, cur.counts),
  };
}

export function formatDiff(d) {
  const L = [];
  L.push('--- BLE session diff (snapshot -> current) ---');
  L.push('mac          : ' + (d.mac.same ? 'unchanged (' + (d.mac.value || '?') + ')' : JSON.stringify(d.mac)));
  L.push('lifecycle    : +[' + d.lifecycle.added.join(',') + '] -[' + d.lifecycle.removed.join(',') + ']');
  L.push('services     : +[' + d.services.added.join(',') + '] -[' + d.services.removed.join(',') + ']');
  L.push('characterist : +[' + d.characteristics.added.join(',') + '] -[' + d.characteristics.removed.join(',') + ']');
  L.push('advertising  : ' + (d.advertising.same ? 'unchanged' : JSON.stringify(d.advertising)));
  L.push('connections  : +[' + d.connections.added.join(',') + '] -[' + d.connections.removed.join(',') + ']');
  L.push('gatt delta   : read=' + d.gatt.reads + ' write=' + d.gatt.writes +
    ' notify=' + d.gatt.notifies + ' subscribe=' + d.gatt.subscribes + ' mtuChange=' + d.gatt.mtuChanges);
  const ck = Object.keys(d.counts);
  if (ck.length) {
    L.push('event counts :');
    for (const k of ck) L.push('   - ' + k + ': ' + d.counts[k].baseline + ' -> ' + d.counts[k].current + ' (d' + d.counts[k].delta + ')');
  }
  return L.join('\n');
}

/** Render a single event as a compact, human-readable line (no timestamp). */
export function renderEvent(ev) {
  const tag = ev.type.split('.')[0].toUpperCase();
  let text;
  switch (ev.type) {
    case 'ble.state':          text = ev.state; break;
    case 'ble.mac':            text = 'local-mac=' + ev.mac; break;
    case 'ble.service':        text = 'service created uuid=' + ev.uuid; break;
    case 'ble.characteristic': text = "characteristic uuid=" + ev.uuid + " props=0x" + ev.props.toString(16) + " value='" + ev.value + "'"; break;
    case 'ble.advertising':    text = "advertising started name='" + ev.name + "' scan-response=" + (ev.scanResponse ? 1 : 0); break;
    case 'ble.heartbeat':      text = 'heartbeat uptime=' + ev.uptimeMs + 'ms connections=' + ev.connections; break;
    case 'ble.gatt_notify':    text = "gatt-notify uuid=" + ev.uuid + " value='" + ev.value + "'"; break;
    case 'ble.connect':        text = 'connect peer=' + ev.peer + ' handle=' + ev.handle; break;
    case 'ble.disconnect':     text = 'disconnect peer=' + ev.peer + ' reason=' + ev.reason; break;
    case 'ble.gatt_read':      text = 'gatt-read peer=' + ev.peer + ' uuid=' + ev.uuid; break;
    case 'ble.gatt_write':     text = 'gatt-write peer=' + ev.peer + ' uuid=' + ev.uuid + ' len=' + ev.len + ': ' + ev.bytes; break;
    case 'ble.gatt_subscribe': text = 'gatt-subscribe peer=' + ev.peer + ' uuid=' + ev.uuid + ' sub=' + ev.sub; break;
    case 'ble.mtu_change':     text = 'mtu-change peer=' + ev.peer + ' mtu=' + ev.mtu; break;
    case 'ble.other':          text = ev.text; break;
    case 'detect.mac':         text = 'local-mac=' + ev.mac; break;
    case 'detect.symbol':      text = ev.name + ' @' + ev.addr + ' w0=' + ev.w0 + ' -> ' + ev.classification; break;
    case 'detect.done':        text = 'done'; break;
    case 'detect.heartbeat':   text = 'heartbeat loop=' + ev.loop + ' send_available=' + ev.sendAvailable; break;
    case 'detect.other':       text = ev.text; break;
    case 'test.mac':           text = 'local-mac=' + ev.mac; break;
    case 'test.send_available':text = 'send_available ' + ev.phase + ': ' + ev.available; break;
    case 'test.init':          text = 'init returned: ' + ev.returned; break;
    case 'test.enable':        text = 'enable returned: ' + ev.returned; break;
    case 'test.send_hci_reset':text = 'sending HCI reset' + (ev.via ? ' via ' + ev.via : '') + ' (send_available=' + ev.available + ')'; break;
    case 'test.send_returned':  text = 'send returned: ' + ev.returned; break;
    case 'test.hci_evt':       text = 'hci-evt-' + ev.which + ' len=' + ev.len + ': ' + ev.bytes; break;
    case 'test.hci_reset':     text = 'hci-reset-' + ev.which + ' ' + (ev.ok ? 'ok' : 'FAIL'); break;
    case 'test.hci_direct':    text = 'hci-direct ' + (ev.ok ? 'ok' : 'FAIL'); break;
    case 'test.done':          text = 'done'; break;
    case 'test.heartbeat':     text = 'heartbeat loop=' + ev.loop + ' send_available=' + ev.sendAvailable; break;
    case 'test.other':         text = ev.text; break;
    default:                   text = JSON.stringify(ev);
  }
  return '[' + tag + '] ' + text;
}
