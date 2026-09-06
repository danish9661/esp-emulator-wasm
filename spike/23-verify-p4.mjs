// Verification Suite for ESP32-P4 via MCU Core SDK (mirrors spike/20-test-mcu-core.mjs)
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';
import { VirtualSDCard, MPU6050Device } from '../peripherals.mjs';

const mpu6050Rig = (m) => {
    const dev = new MPU6050Device();
    m.i2c.register(0x68, { i2cWrite: (x) => dev.onWrite(x), i2cRead: (l) => dev.onRead(l) });
};

const CHIP = 'esp32p4';
const DIR = 'p4';

const DEMOS = [
    { name: 'Blink', markers: ['blink-start'], setup: null },
    { name: 'I2CRead', markers: ['read-start', 'read-done', 'got=3:FFFFFF'], setup: null },
    { name: 'SPIDemo', markers: ['[SPI] SPI initialized successfully!', 'spi-done'], setup: null },
    { name: 'ADCPWMDemo', markers: ['Initial ADC Read: raw=2048, mv=1650 mV', 'adc-pwm-done'], setup: (m) => m.adc.setVoltage(0, 1.65) },
    { name: 'I2SDemo', markers: ['i2s-audio-done'], setup: null },
    { name: 'TWAIDemo', markers: ['twai-bus-done'], setup: null },
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
];

console.log('====================================================');
console.log(`Testing ESP32-P4 MCU Core Engine SDK (all protocols)`);
console.log('====================================================\n');

const results = [];
for (const demo of DEMOS) {
    // NOTE (esp-emu 0.41): multi-instance runs flake nondeterministically
    // (see 21-verify-c6.mjs). Retry each demo with a fresh instance up to 3x.
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

        pass = demo.markers.every((m) => consoleBuffer.includes(m)) &&
                     !consoleBuffer.includes('Guru Meditation');
    }
    console.log(`${demo.name}: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
    results.push(pass);
}

if (results.every(Boolean)) {
    console.log('\n====================================================');
    console.log('ALL ESP32-P4 SDK TESTS PASSED! 🎉');
    console.log('====================================================\n');
} else {
    throw new Error('ESP32-P4 verification failed');
}