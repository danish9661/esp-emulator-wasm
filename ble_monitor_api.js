// Exposes the BleInspector parser/renderer to the classic app.js runtime via a
// window global. (app.js is a classic script and cannot `import`; the module
// below is deferred and runs before any worker UART output arrives.)
import { BleInspector, parseLine } from './spike/ble_inspector.mjs';
import { buildReport, formatReport, renderEvent, diffReports, formatDiff } from './spike/ble_report.mjs';

window.BleInspectorMod = { BleInspector, parseLine, buildReport, formatReport, renderEvent, diffReports, formatDiff };
