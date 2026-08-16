// Verification Test for modular ESP32C3 SDK Core (rp2040js style)
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

console.log('====================================================');
console.log('Testing Modular ESP32C3 MCU Core Engine SDK (rp2040js style)');
console.log('====================================================\n');

// 1. Test ADC & PWM with event listeners
console.log('--- TEST 1: ADC & PWM via MCU Core SDK ---');
const mcuAdc = await ESP32C3.create({ chip: 'esp32c3' });
const adcPwmFlash = new Uint8Array(readFileSync('samples/adcpwm_demo.merged.bin'));
const adcPwmElf = new Uint8Array(readFileSync('samples/adcpwm_demo.elf'));

const patchResult = await mcuAdc.loadFirmware(adcPwmFlash, adcPwmElf);
console.log('✓ Patched shims:', patchResult.patched.join(', '));

// Connect simulated analog sensor (1.65V)
mcuAdc.adc.setVoltage(0, 1.65);

let pwmUpdates = 0;
mcuAdc.pwm.onUpdate(({ pin, duty, percent }) => {
    pwmUpdates++;
});

let consoleBuffer = '';
mcuAdc.uart0.onData((text) => {
    consoleBuffer += text;
});

for (let i = 0; i < 1000; i++) {
    mcuAdc.step(50000);
}

const adcPwmPass = consoleBuffer.includes('Initial ADC Read: raw=2048, mv=1650 mV') &&
                   consoleBuffer.includes('adc-pwm-done') &&
                   pwmUpdates >= 5;

console.log(`ADC (1.65V -> 2048 raw) & PWM Updates (${pwmUpdates}): ${adcPwmPass ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`Cycles: ${mcuAdc.cycles}, PC: 0x${mcuAdc.pc.toString(16)}`);

// 2. Test TWAI / CAN Bus Controller via MCU Core SDK
console.log('\n--- TEST 2: TWAI / CAN Bus via MCU Core SDK ---');
const mcuTwai = await ESP32C3.create({ chip: 'esp32c3' });
const twaiFlash = new Uint8Array(readFileSync('samples/twai_demo.merged.bin'));
const twaiElf = new Uint8Array(readFileSync('samples/twai_demo.elf'));

await mcuTwai.loadFirmware(twaiFlash, twaiElf);

let canTxFrames = [];
mcuTwai.twai.onActivity((evt) => {
    if (evt.type === 'tx') canTxFrames.push(evt);
});

// Inject CAN packet from an external virtual node
mcuTwai.twai.inject({ id: 0x777, extd: false, rtr: false, dlc: 4, data: [0xCA, 0xFE, 0xBA, 0xBE] });

let twaiConsole = '';
mcuTwai.uart0.onData((text) => {
    twaiConsole += text;
});

for (let i = 0; i < 1000; i++) {
    mcuTwai.step(50000);
}

const twaiPass = twaiConsole.includes('Transmitted CAN frame ID=0x123') &&
                 twaiConsole.includes('Received CAN frame ID=0x777 DLC=4 Data=CA FE BA BE') &&
                 canTxFrames.length >= 2;

console.log(`TWAI CAN Bus (TX=${canTxFrames.length}, RX=0x777): ${twaiPass ? 'PASS ✅' : 'FAIL ❌'}`);

if (adcPwmPass && twaiPass) {
    console.log('\n====================================================');
    console.log('ALL MCU CORE SDK TESTS PASSED! 🎉');
    console.log('====================================================\n');
} else {
    throw new Error('MCU Core SDK verification failed');
}
