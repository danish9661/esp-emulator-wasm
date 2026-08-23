/**
 * observe_peripheral.mjs — runs a peripheral firmware in the headless emulator
 * and renders its bus activity (I2C / SPI / TWAI) through the SAME
 * PeripheralInspector that powers the web UI "Peripheral Monitor" panel.
 *
 * This proves the monitor's data pipeline on real emulator output: the APC
 * routing + peripherals.mjs host models below are exactly what the browser
 * worker does before it posts 'i2c' / 'spi' / 'can' messages to the UI.
 *
 *   node spike/observe_peripheral.mjs i2c
 *   node spike/observe_peripheral.mjs spi
 *   node spike/observe_peripheral.mjs bus
 *   node spike/observe_peripheral.mjs twai
 *   node spike/observe_peripheral.mjs oled        # also exercises I2C
 *   node spike/observe_peripheral.mjs st7789      # also exercises SPI
 *   node spike/observe_peripheral.mjs neopixel
 *   node spike/observe_peripheral.mjs sdcard
 *   node spike/observe_peripheral.mjs adcpwm
 *   node spike/observe_peripheral.mjs i2s
 *
 * Flags: --json  (dump the raw event array)   --steps=N  (batch count, default 1500)
 */
import { readFileSync } from 'node:fs';
import { Elf32, planHooks, prepareSpiShims } from '../elf.mjs';
import { EspImage } from '../espimage.mjs';
import { SHIMS } from '../shims.mjs';
import { I2CBus, SPIBus, SSD1306Device, ST7789Device, NeoPixelStrip, MPU6050Device, VirtualSDCard, VirtualADC, VirtualPWM, VirtualI2S, VirtualTWAI } from '../peripherals.mjs';
import { boot } from './harness.mjs';
import { PeripheralInspector, buildPeripheralReport, formatPeripheralReport, diffPeripheralReports, formatPeripheralDiff } from './peripheral_inspector.mjs';

const APC = /\x1b_(.)([\s\S]*?)\x1b\\/;
const hexOf = (b) => [...b].map(x => (x & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');

const PRESETS = {
  i2c:      ['samples/i2cread.merged.bin', 'samples/i2cread.elf', 'I2C Sensor Read'],
  spi:      ['samples/spidemo.merged.bin', 'samples/spidemo.elf', 'SPIDemo'],
  bus:      ['samples/busprobe.merged.bin', 'samples/busprobe.elf', 'BusProbe (I2C+SPI)'],
  twai:     ['samples/twai_demo.merged.bin', 'samples/twai_demo.elf', 'TWAIDemo'],
  oled:     ['samples/oled_demo.merged.bin', 'samples/oled_demo.elf', 'SSD1306 OLED'],
  st7789:   ['samples/st7789_demo.merged.bin', 'samples/st7789_demo.elf', 'ST7789 TFT'],
  neopixel: ['samples/neopixel_demo.merged.bin', 'samples/neopixel_demo.elf', 'NeoPixel'],
  sdcard:   ['samples/sdcard_demo.merged.bin', 'samples/sdcard_demo.elf', 'SDCard'],
  adcpwm:   ['samples/adcpwm_demo.merged.bin', 'samples/adcpwm_demo.elf', 'ADC/PWM'],
  i2s:      ['samples/i2s_demo.merged.bin', 'samples/i2s_demo.elf', 'I2S'],
};

const args = process.argv.slice(2);
const presetKey = args.find(a => !a.startsWith('--')) || 'i2c';
const useJson = args.includes('--json');
const stepsArg = args.find(a => a.startsWith('--steps='));
const steps = stepsArg ? parseInt(stepsArg.split('=')[1], 10) : 1500;

if (!PRESETS[presetKey]) {
  console.error('Unknown preset. Choose one of: ' + Object.keys(PRESETS).join(', '));
  process.exit(1);
}
const [binPath, elfPath, label] = PRESETS[presetKey];
console.log(`=== Running ${label} (Peripheral Monitor observer) ===`);

const flash = new Uint8Array(readFileSync(binPath));
const elf = new Elf32(readFileSync(elfPath));
const hookPlan = planHooks(elf);
const allHooks = []
  .concat(hookPlan?.i2c?.hooks || [])
  .concat(hookPlan?.spi?.hooks || [])
  .concat(hookPlan?.neopixel?.hooks || [])
  .concat(hookPlan?.adc?.hooks || [])
  .concat(hookPlan?.pwm?.hooks || [])
  .concat(hookPlan?.i2s?.hooks || [])
  .concat(hookPlan?.twai?.hooks || []);
const hooks = Object.fromEntries(allHooks.map(h => [h.name, h]));

const img = new EspImage(flash);
const effectiveShims = prepareSpiShims(elf, SHIMS);
const patched = [];
for (const [fn, shim] of Object.entries(effectiveShims)) {
  if (hooks[fn] && shim.length <= hooks[fn].size) { img.writeAtVaddr(hooks[fn].addr, shim); patched.push(fn); }
}
if (patched.length) await img.reseal();

// --- host-side peripheral models (same as the browser worker + verifier) ---
const i2cBus = new I2CBus();
const spiBus = new SPIBus();
const oled = new SSD1306Device(128, 64);
const tft = new ST7789Device(240, 240);
const neoPixel = new NeoPixelStrip(8);
const mpu = new MPU6050Device();
const sd = new VirtualSDCard();
const adc = new VirtualADC();
const pwm = new VirtualPWM();
const i2s = new VirtualI2S();
const twai = new VirtualTWAI();
i2cBus.register(0x3c, oled);
i2cBus.register(0x3d, oled);
i2cBus.register(0x68, mpu);
spiBus.register('tft', tft);
spiBus.register('sd', sd);

// --- the inspector that powers the web UI Peripheral Monitor ---
const inspector = new PeripheralInspector();
const emit = (proto, kind, summary, detail) => inspector.add(proto, kind, summary, detail);

twai.onActivity((act) => {
  const isTx = act.type === 'tx';
  const hexId = '0x' + (act.id || 0).toString(16).toUpperCase().padStart(3, '0');
  emit('TWAI', isTx ? 'tx' : 'rx', `[${isTx ? 'TX' : 'RX'}] ID:${hexId} DLC:${act.dlc} ${hexOf(act.data || [])}`,
    { id: act.id, dlc: act.dlc, data: act.data });
});
oled.onFrame((f) => emit('OLED', 'frame', `OLED frame (${f.width}x${f.height})`, { width: f.width, height: f.height }));
tft.onFrame((f) => emit('TFT', 'frame', `TFT frame (${f.width}x${f.height})`, { width: f.width, height: f.height }));
sd.onActivity((act) => emit('SD', act.type || (act.cmd ? 'cmd' : 'activity'), `SD ${act.type || act.cmd || 'activity'}`, act));

const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

let streamBuffer = '', cleanConsole = '';
function processStream(chunk) {
  streamBuffer += chunk;
  while (true) {
    const m = streamBuffer.match(APC);
    if (!m) {
      const p = streamBuffer.lastIndexOf('\x1b_');
      if (p !== -1) { cleanConsole += streamBuffer.slice(0, p); streamBuffer = streamBuffer.slice(p); }
      else { cleanConsole += streamBuffer; streamBuffer = ''; }
      break;
    }
    const [frame, kind, body] = m;
    cleanConsole += streamBuffer.slice(0, m.index);
    if (kind === 'W') {
      const addr = body.charCodeAt(0);
      const bytes = decodeHex(body.slice(1));
      emit('I2C', 'write', `[W] 0x${addr.toString(16).toUpperCase().padStart(2, '0')} ${hexOf(bytes)}`, { addr, op: 'write', data: bytes });
      i2cBus.write(addr, bytes);
    } else if (kind === 'R') {
      const addr = body.charCodeAt(0);
      const len = body.charCodeAt(1);
      const data = i2cBus.read(addr, len);
      emit('I2C', 'read', `[R] 0x${addr.toString(16).toUpperCase().padStart(2, '0')} ${hexOf(data)}`, { addr, op: 'read', data });
      emu.uart_input(new Uint8Array(data));
    } else if (kind === 'S') {
      if (body[0] === 'W') {
        const len = body.charCodeAt(1) & 0x7f;
        const bytes = decodeHex(body.slice(2));
        emit('SPI', 'write', `[SPI] TX:${hexOf(bytes)} RX:`, { data: bytes, reply: [] });
        spiBus.write(bytes);
        if (len === 64) emu.uart_input(new Uint8Array([0]));
      } else if (body[0] === 'X') {
        const len = ((body.charCodeAt(1) & 0x7f) << 7) | (body.charCodeAt(2) & 0x7f);
        const bytes = decodeHex(body.slice(3));
        const replies = [];
        for (const b of bytes) replies.push(spiBus.transferByte(b));
        emit('SPI', 'transfer', `[SPI] TX:${hexOf(bytes)} RX:${hexOf(replies)}`, { data: bytes, reply: replies });
        emu.uart_input(new Uint8Array(replies));
      } else {
        const txByte = (((body.charCodeAt(0) - 97) & 15) << 4) | ((body.charCodeAt(1) - 97) & 15);
        const reply = spiBus.transferByte(txByte);
        emit('SPI', 'transfer', `[SPI] TX:${hexOf([txByte])} RX:${hexOf([reply])}`, { data: [txByte], reply: [reply] });
        emu.uart_input(new Uint8Array([reply]));
      }
    } else if (kind === 'N') {
      const pin = body.charCodeAt(0);
      const bytes = decodeHex(body.slice(2));
      emit('NEO', 'update', `NeoPixel update pin=${pin} n=${bytes.length / 3}`, { pin, count: bytes.length / 3 });
      neoPixel.update(pin, bytes);
    } else if (kind === 'A') {
      const pin = body.charCodeAt(0) & 0x7F;
      const raw = adc.readRaw(pin);
      emit('ADC', 'read', `ADC pin=${pin} raw=${raw} ${(raw / 4095 * 3.3).toFixed(2)}V`, { pin, raw });
      emu.uart_input(new Uint8Array([(raw >> 8) & 0xFF, raw & 0xFF]));
    } else if (kind === 'V') {
      const pin = body.charCodeAt(0) & 0x7F;
      const v = adc.readMilliVolts(pin);
      emit('ADC', 'read', `ADC pin=${pin} ${v}mV`, { pin, milliVolts: v });
      emu.uart_input(new Uint8Array([(v >> 8) & 0xFF, v & 0xFF]));
    } else if (kind === 'P') {
      const pin = body.charCodeAt(0) & 0x7F;
      const duty = ((body.charCodeAt(1) & 0x7f) << 7) | (body.charCodeAt(2) & 0x7f);
      emit('PWM', 'write', `PWM pin=${pin} duty=${duty}`, { pin, duty });
      pwm.update(pin, duty);
    } else if (kind === 'I') {
      const len = ((body.charCodeAt(0) & 0x7f) << 7) | (body.charCodeAt(1) & 0x7f);
      const bytes = [];
      for (let i = 0; i < len && 2 + i < body.length; i++) bytes.push(body.charCodeAt(2 + i) & 0xff);
      emit('I2S', 'audio', `I2S audio samples=${bytes.length}`, { samples: bytes.length });
      i2s.writePcm(bytes);
    } else if (kind === 'C') {
      if (body === 'R') { const resp = twai.popRxFrame() || new Uint8Array([0]); emu.uart_input(resp); }
      else {
        const flags = body.charCodeAt(0) & 0x7f;
        const dlc = body.charCodeAt(1) & 0x0f;
        const id = ((body.charCodeAt(2) & 0x7f) << 21) | ((body.charCodeAt(3) & 0x7f) << 14) | ((body.charCodeAt(4) & 0x7f) << 7) | (body.charCodeAt(5) & 0x7f);
        const data = [];
        for (let i = 0; i < dlc && 6 + i < body.length; i++) data.push(body.charCodeAt(6 + i) & 0xff);
        twai.transmit({ id, extd: (flags & 1) !== 0, rtr: (flags & 2) !== 0, dlc, data });
      }
    }
    streamBuffer = streamBuffer.slice(m.index + frame.length);
  }
}

function decodeHex(s) {
  const h = [...s].map(c => c.charCodeAt(0) - 97);
  const out = [];
  for (let j = 0; j + 1 < h.length; j += 2) out.push(((h[j] << 4) | h[j + 1]) & 0xff);
  return out;
}

for (let i = 0; i < steps; i++) {
  const raw = emu.run_batch(50000);
  if (raw) processStream(raw);
  if (cleanConsole.includes('done') || cleanConsole.includes('ble-done') || cleanConsole.includes('bus-done')) break;
}

console.log('\n--- firmware console (tail) ---');
console.log(cleanConsole.slice(-400));

if (useJson) {
  console.log('\n--- peripheral events (JSON) ---');
  console.log(JSON.stringify(inspector.events, null, 2));
} else {
  console.log('\n' + formatPeripheralReport(buildPeripheralReport(inspector.events)));
}
