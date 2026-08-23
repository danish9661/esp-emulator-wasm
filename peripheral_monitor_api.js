// Exposes the PeripheralInspector to the classic app.js runtime via a window
// global (app.js is a classic script and cannot `import`; this module is
// deferred and runs before any worker peripheral output arrives).
import { PeripheralInspector, buildPeripheralReport, formatPeripheralReport, diffPeripheralReports, formatPeripheralDiff } from './spike/peripheral_inspector.mjs';

window.PeripheralInspectorMod = {
  PeripheralInspector, buildPeripheralReport, formatPeripheralReport,
  diffPeripheralReports, formatPeripheralDiff,
};
