// Verification Suite for ESP32-C5 via MCU Core SDK (mirrors spike/20-test-mcu-core.mjs)
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
import { VirtualSDCard, MPU6050Device } from '../peripherals.mjs';

const mpu6050Rig = (m) => {
    const dev = new MPU6050Device();
    m.i2c.register(0x68, { i2cWrite: (x) => dev.onWrite(x), i2cRead: (l) => dev.onRead(l) });
};

const CHIP = 'esp32c5';
const DIR = 'c5';

const DEMOS = [
    { name: 'Blink', markers: ['blink-start'], setup: null },
    { name: 'I2CRead', markers: ['read-start', 'read-done', 'got=3:FFFFFF'], setup: null },
    { name: 'SPIDemo', markers: ['[SPI] SPI initialized successfully!', 'spi-done'], setup: null },
    { name: 'ADCPWMDemo', markers: ['Initial ADC Read: raw=2048, mv=1650 mV', 'adc-pwm-done'], setup: (m) => m.adc.setVoltage(0, 1.65) },
    { name: 'I2SDemo', markers: ['i2s-audio-done'], setup: null },
    { name: 'NeoPixelDemo', markers: ['[NeoPixel] NeoPixel strip initialized!'], setup: null },
    { name: 'OLEDDemo', markers: ['[OLED] Display initialized successfully!', '[OLED] Splash frame sent.'], setup: null },
    { name: 'ST7789Demo', markers: ['[TFT] ST7789 display initialized successfully!', '[TFT] Color splash screen rendered.'], setup: null },
    { name: 'SDCardDemo', markers: ['[SD] before begin', '[SD] sd-done'], setup: (m) => m.spi.register('sd', new VirtualSDCard()) },
    { name: 'TouchDemo', markers: ['[TOUCH] touch-done'], setup: null },
    { name: 'DACDemo', markers: ['[DAC] dac-done'], setup: null },
    { name: 'SDMMCDemo', markers: ['[SDMMC] sdmmc-done'], setup: null },
    { name: 'CameraDemo', markers: ['[CAM] cam-done'], setup: null },
    { name: 'LCDDemo', markers: ['[LCD] lcd-done'], setup: null },
    { name: 'IDFSPIDemo', markers: ['idf-spi-done'], setup: (m) => m.spi.onTransfer((b) => b ^ 0x55) },
    { name: 'IDFI2CDemo', markers: ['idf-i2c-done'], setup: mpu6050Rig },
    { name: 'IDFI2CLegacyDemo', markers: ['cmdlink rc=0', 'idf-i2c-cmd-done', 'idf-i2c-legacy-done'], setup: mpu6050Rig },
    // Native silicon (no shims): timers/WDT/RTC + LittleFS/NVS (mirrors 26-verify).
    { name: 'TimerDemo', markers: ['[TIMER] tick=', 'timer-done'], setup: null,
      verify: (t) => (t.match(/\[TIMER\] tick=/g) || []).length >= 5 },
    { name: 'WDTDemo', markers: ['[WDT] fed=', 'wdt-done'], setup: null,
      verify: (t) => (t.match(/\[WDT\] fed=/g) || []).length >= 5 && !/panic|abort/i.test(t) },
    { name: 'RTCDemo', markers: ['rtc-done'], setup: null,
      verify: (t) => {
          const s = [...t.matchAll(/\[RTC\] sample=(\d+) esp_us=(\d+) tv_us=(\d+) mono=(\d+) skew_us=(\d+)/g)];
          return s.length >= 4 && s.every((m) => m[4] === '1' && +m[5] < 2000000);
      } },
    { name: 'LittleFSDemo', markers: ['littlefs-done'], setup: null,
      verify: (t) => t.includes('mounted') && t.includes('write OK') && t.includes('readback') && !t.includes('FAIL') },
    { name: 'NVSDemo', markers: ['nvs-done'], setup: null,
      verify: (t) => t.includes('namespace open') && t.includes('write OK') && t.includes('counter=424242') && t.includes('nvs-hello') && !t.includes('FAIL') },
];

console.log('====================================================');
console.log(`Testing ESP32-C5 MCU Core Engine SDK (all protocols)`);
console.log('====================================================\n');

const results = [];
for (const demo of DEMOS) {
    // NOTE (esp-emu 0.41): multi-instance runs flake nondeterministically
    // (~1/3 runs lose 1-2 SPI/I2C-heavy demos; 0.39 was stable, C3/H2/P4 on
    // 0.41 are stable). Root cause is upstream (identical patched images boot
    // differently per process; our shims/inputs are deterministic). Retry each
    // demo with a fresh instance up to 3x; a real regression fails 3/3 loudly.
    let pass = false;
    for (let attempt = 1; attempt <= 3 && !pass; attempt++) {
        if (attempt > 1) console.log(`   retry ${demo.name} (attempt ${attempt})...`);
        const mcu = await ESP32C3.create({ chip: CHIP });
        if (demo.setup) demo.setup(mcu);
        await mcu.loadFirmware(
            new Uint8Array(readFileSync(`samples/${DIR}/${demo.name}.merged.bin`)),
            new Uint8Array(readFileSync(`samples/${DIR}/${demo.name}.elf`)));

        let consoleBuffer = '';
        mcu.uart0.onData((text) => { consoleBuffer += text; });

        for (let i = 0; i < 3000; i++) {
            mcu.step(100000);
            if (demo.markers.every((m) => consoleBuffer.includes(m))) break;
        }

        const check = demo.verify ? demo.verify(consoleBuffer)
            : demo.markers.every((m) => consoleBuffer.includes(m));
        pass = check && !consoleBuffer.includes('Guru Meditation');
    }
    console.log(`${demo.name}: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
    results.push(pass);
}

if (results.every(Boolean)) {
    console.log('\n====================================================');
    console.log('ALL ESP32-C5 SDK TESTS PASSED! 🎉');
    console.log('====================================================\n');
} else {
    throw new Error('ESP32-C5 verification failed');
}
