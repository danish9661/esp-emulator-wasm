/**
 * PeripheralInspector — a generic, structured event log for the emulator's
 * non-BLE peripherals (I2C, SPI, TWAI/CAN, …). Unlike BleInspector (which
 * parses the firmware's console text), these protocols are observed from the
 * emulator's own JS activity callbacks, so events are already structured.
 *
 * Each event: { t, proto, kind, summary, detail }
 *   proto  : 'I2C' | 'SPI' | 'TWAI' | ...
 *   kind   : protocol-specific (e.g. 'write' | 'read' | 'tx' | 'rx' | 'transfer')
 *   summary: human-readable one-liner
 *   detail : optional structured payload (addr, bytes, id, dlc, …)
 */

export class PeripheralInspector {
  constructor() { this.t0 = Date.now(); this.events = []; }
  /** Add a pre-built event (must include proto/kind/summary). */
  feed(ev) {
    ev.t = Date.now() - this.t0;
    this.events.push(ev);
    return ev;
  }
  /** Convenience: build + add an event. */
  add(proto, kind, summary, detail) {
    return this.feed({ proto, kind, summary, detail: detail || null });
  }
}

export function buildPeripheralReport(events) {
  const counts = {};
  const byProto = {};
  for (const e of events) {
    const k = e.proto + ':' + e.kind;
    counts[k] = (counts[k] || 0) + 1;
    byProto[e.proto] = (byProto[e.proto] || 0) + 1;
  }
  return { total: events.length, counts, byProto };
}

export function formatPeripheralReport(r) {
  const L = [];
  L.push('--- Peripheral session report ---');
  L.push('total events : ' + r.total);
  const protos = Object.keys(r.byProto).sort();
  for (const p of protos) L.push(p.padEnd(6) + ' : ' + r.byProto[p]);
  const keys = Object.keys(r.counts).sort();
  if (keys.length) {
    L.push('by kind     :');
    for (const k of keys) L.push('   - ' + k + ': ' + r.counts[k]);
  }
  return L.join('\n');
}

export function diffPeripheralReports(base, cur) {
  const keys = new Set([...Object.keys(base.counts || {}), ...Object.keys(cur.counts || {})]);
  const counts = {};
  for (const k of keys) {
    const b = (base.counts && base.counts[k]) || 0;
    const c = (cur.counts && cur.counts[k]) || 0;
    if (b !== c) counts[k] = { baseline: b, current: c, delta: c - b };
  }
  return {
    counts,
    total: { baseline: base.total || 0, current: cur.total || 0 },
  };
}

export function formatPeripheralDiff(d) {
  const L = [];
  L.push('--- Peripheral session diff (snapshot -> current) ---');
  L.push('total       : ' + d.total.baseline + ' -> ' + d.total.current +
    ' (d' + (d.total.current - d.total.baseline) + ')');
  const keys = Object.keys(d.counts);
  if (keys.length) {
    L.push('by kind     :');
    for (const k of keys.sort()) L.push('   - ' + k + ': ' + d.counts[k].baseline + ' -> ' + d.counts[k].current + ' (d' + d.counts[k].delta + ')');
  } else {
    L.push('no changes');
  }
  return L.join('\n');
}
