/**
 * Regression test for the PeripheralInspector (spike/peripheral_inspector.mjs).
 * Standalone: feed sample events and assert the report/diff. Exits non-zero on
 * any failure.
 *
 *   node spike/peripheral_inspector.test.mjs
 */
import assert from 'node:assert';
import { PeripheralInspector, buildPeripheralReport, formatPeripheralReport, diffPeripheralReports, formatPeripheralDiff } from './peripheral_inspector.mjs';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL: ' + name); }
}

// add() returns an event with a numeric timestamp and the supplied fields.
const ins = new PeripheralInspector();
const e1 = ins.add('I2C', 'write', '[W] 0x68 AA BB', { addr: 0x68, data: [0xaa, 0xbb] });
check('event has proto', e1.proto === 'I2C');
check('event has kind', e1.kind === 'write');
check('event has summary', e1.summary === '[W] 0x68 AA BB');
check('event has numeric t', typeof e1.t === 'number' && e1.t >= 0);
check('inspector stored event', ins.events.length === 1);

// feed() accepts a pre-built event.
ins.feed({ proto: 'SPI', kind: 'transfer', summary: '[SPI] TX:.. RX:..' });
ins.feed({ proto: 'TWAI', kind: 'tx', summary: '[TX] ID:0x123 DLC:2 01 02' });
ins.feed({ proto: 'TWAI', kind: 'rx', summary: '[RX] ID:0x456 DLC:1 FF' });

const rep = buildPeripheralReport(ins.events);
check('report total', rep.total === 4);
check('report I2C count', rep.counts['I2C:write'] === 1);
check('report SPI count', rep.counts['SPI:transfer'] === 1);
check('report TWAI tx', rep.counts['TWAI:tx'] === 1);
check('report TWAI rx', rep.counts['TWAI:rx'] === 1);
check('report byProto I2C', rep.byProto['I2C'] === 1);
check('report byProto TWAI', rep.byProto['TWAI'] === 2);

const fr = formatPeripheralReport(rep);
check('formatReport has header', fr.indexOf('Peripheral session report') >= 0);
check('formatReport has total', fr.indexOf('total events : 4') >= 0);

// diffReports: compare a snapshot with a busier current session.
const snap = buildPeripheralReport([
  { proto: 'I2C', kind: 'read', summary: 'r' },
  { proto: 'I2C', kind: 'read', summary: 'r' },
]);
const cur = buildPeripheralReport([
  { proto: 'I2C', kind: 'read', summary: 'r' },
  { proto: 'I2C', kind: 'write', summary: 'w' },
  { proto: 'SPI', kind: 'transfer', summary: 's' },
]);
const d = diffPeripheralReports(snap, cur);
check('diff total delta +1', d.total.current - d.total.baseline === 1);
check('diff I2C:read delta -1', d.counts['I2C:read'] && d.counts['I2C:read'].delta === -1);
check('diff I2C:write added', d.counts['I2C:write'] && d.counts['I2C:write'].delta === 1);
check('diff SPI:transfer added', d.counts['SPI:transfer'] && d.counts['SPI:transfer'].delta === 1);

const df = formatPeripheralDiff(d);
check('formatDiff has header', df.indexOf('Peripheral session diff') >= 0);
check('formatDiff shows I2C:write', df.indexOf('I2C:write') >= 0);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
