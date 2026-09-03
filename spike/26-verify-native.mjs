// Verification suite for natively-emulated peripherals (no shims needed):
// hardware timers + interrupts, task watchdog, RTC/wall-clock time,
// LittleFS flash filesystem, NVS settings storage. All with real Arduino
// firmware, headless. Run: node spike/26-verify-native.mjs
import { readFileSync } from 'node:fs';
import { boot } from './harness.mjs';

async function runTest(testName, binPath, customVerify, batches = 1200) {
    console.log(`\n========================================`);
    console.log(`TEST: ${testName}`);
    console.log(`========================================`);

    const flash = new Uint8Array(readFileSync(binPath));
    const { emu } = await boot({ chip: 'esp32c3', firmware: flash, bootFromRom: true });

    let cleanConsole = '';
    for (let i = 0; i < batches; i++) {
        const raw = emu.run_batch(100000);
        if (raw) cleanConsole += raw;
    }
    await customVerify({ getConsole: () => cleanConsole });
}

// 1. Hardware timer ISR ticks (5 periodic 100ms alarms).
await runTest('TimerDemo (GPTimer interrupt)', 'samples/timer_demo.merged.bin', async ({ getConsole }) => {
    const cons = getConsole();
    const ticks = (cons.match(/\[TIMER\] tick=/g) || []).length;
    const matched = ticks >= 5 && cons.includes('timer-done');
    console.log(`Timer ticks=${ticks}: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('TimerDemo test failed');
    }
});

// 2. Task watchdog feed (no spurious reset; clean deinit).
await runTest('WDTDemo (task watchdog)', 'samples/wdt_demo.merged.bin', async ({ getConsole }) => {
    const cons = getConsole();
    const feds = (cons.match(/\[WDT\] fed=/g) || []).length;
    const panicked = /panic|Guru Meditation|abort/i.test(cons);
    const matched = feds >= 5 && cons.includes('wdt-done') && !panicked;
    console.log(`WDT feeds=${feds} panics=${panicked}: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('WDTDemo test failed');
    }
});

// 3. RTC/wall-clock monotonicity + consistency.
await runTest('RTCDemo (esp_timer + gettimeofday)', 'samples/rtc_demo.merged.bin', async ({ getConsole }) => {
    const cons = getConsole();
    const samples = [...cons.matchAll(/\[RTC\] sample=(\d+) esp_us=(\d+) tv_us=(\d+) mono=(\d+) skew_us=(\d+)/g)];
    const ok = samples.length >= 4 && samples.every(m => m[4] === '1' && +m[5] < 2000000);
    console.log(`RTC samples=${samples.length} all-monotonic: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) {
        console.log('Console snippet:', cons.slice(-500));
        throw new Error('RTCDemo test failed');
    }
});

// 4. LittleFS write/readback on emulated flash.
await runTest(
    'LittleFSDemo (flash filesystem)',
    'samples/littlefs_demo.merged.bin',
    async ({ getConsole }) => {
        const cons = getConsole();
        const matched = cons.includes('mounted') && cons.includes('write OK') &&
            cons.includes('readback') && !cons.includes('FAIL') && cons.includes('littlefs-done');
        console.log(`LittleFS write+readback: ${matched ? 'PASS' : 'FAIL'}`);
        if (!matched) {
            console.log('Console snippet:', cons.slice(-600));
            throw new Error('LittleFSDemo test failed');
        }
    },
    2500,
);

// 5. NVS settings write/readback.
await runTest('NVSDemo (NVS storage)', 'samples/nvs_demo.merged.bin', async ({ getConsole }) => {
    const cons = getConsole();
    const matched = cons.includes('namespace open') && cons.includes('write OK') &&
        cons.includes('counter=424242') && cons.includes('nvs-hello') &&
        !cons.includes('FAIL') && cons.includes('nvs-done');
    console.log(`NVS write+readback: ${matched ? 'PASS' : 'FAIL'}`);
    if (!matched) {
        console.log('Console snippet:', cons.slice(-400));
        throw new Error('NVSDemo test failed');
    }
});

console.log('\n================================================================================');
console.log('ALL 5 NATIVE FIRMWARE TESTS PASSED (TIMER + WDT + RTC + LITTLEFS + NVS)! ✅');
console.log('================================================================================\n');
