// Verification Suite for ESP32-C6 via MCU Core SDK (mirrors spike/20-test-mcu-core.mjs)
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

const CHIP = 'esp32c6';
const DIR = 'c6';

const DEMOS = [
    { name: 'Blink', markers: ['blink-start'], setup: null },
    { name: 'I2CRead', markers: ['read-start', 'read-done', 'got=3:FFFFFF'], setup: null },
    { name: 'SPIDemo', markers: ['[SPI] SPI initialized successfully!', 'spi-done'], setup: null },
    { name: 'ADCPWMDemo', markers: ['Initial ADC Read: raw=2048, mv=1650 mV', 'adc-pwm-done'], setup: (m) => m.adc.setVoltage(0, 1.65) },
    { name: 'I2SDemo', markers: ['i2s-audio-done'], setup: null },
    { name: 'TWAIDemo', markers: ['twai-bus-done'], setup: null },
];

console.log('====================================================');
console.log(`Testing ESP32-C6 MCU Core Engine SDK (all protocols)`);
console.log('====================================================\n');

const results = [];
for (const demo of DEMOS) {
    const mcu = await ESP32C3.create({ chip: CHIP });
    if (demo.setup) demo.setup(mcu);
    await mcu.loadFirmware(
        new Uint8Array(readFileSync(`samples/${DIR}/${demo.name}.merged.bin`)),
        new Uint8Array(readFileSync(`samples/${DIR}/${demo.name}.elf`)));

    let consoleBuffer = '';
    mcu.uart0.onData((text) => { consoleBuffer += text; });

    for (let i = 0; i < 3000; i++) {
        mcu.step(50000);
        if (consoleBuffer.includes('spi-done') || consoleBuffer.includes('adc-pwm-done') ||
            consoleBuffer.includes('i2s-audio-done') || consoleBuffer.includes('twai-bus-done') ||
            consoleBuffer.includes('blink-start') || consoleBuffer.includes('read-done')) {
            if (demo.markers.every((m) => consoleBuffer.includes(m))) break;
        }
    }

    const pass = demo.markers.every((m) => consoleBuffer.includes(m)) &&
                 !consoleBuffer.includes('Guru Meditation');
    console.log(`${demo.name}: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
    results.push(pass);
}

if (results.every(Boolean)) {
    console.log('\n====================================================');
    console.log('ALL ESP32-C6 SDK TESTS PASSED! 🎉');
    console.log('====================================================\n');
} else {
    throw new Error('ESP32-C6 verification failed');
}