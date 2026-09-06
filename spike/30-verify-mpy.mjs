// MicroPython v1.29.0 verification: REPL + machine.I2C/SPI against the
// virtual MPU6050 (0x68) and XOR SPI bus, on C3/C6/H2. P4/C5 firmware is
// stored under samples/mpy but blocked: the WASM ROM model rejects their
// downloadable images (invalid-header loop) — see issue.md #5.
// Run: node spike/30-verify-mpy.mjs
import { bootMpy, replExec } from './mpy_repl.mjs';
import { MPU6050Device } from '../peripherals.mjs';

const CHIPS = [
    { chip: 'esp32c3', tag: 'c3', spiPins: [6, 7, 2] },
    { chip: 'esp32c6', tag: 'c6', spiPins: [6, 7, 2] },
    // H2: GPIO6/7 are USB-reserved (MP rejects Pin(6)/Pin(7)), use 3/4/5.
    { chip: 'esp32h2', tag: 'h2', spiPins: [3, 4, 5] },
];

const results = [];
for (const { chip, tag, spiPins } of CHIPS) {
    console.log(`\n========================================`);
    console.log(`TEST: MicroPython (machine.I2C/SPI) on ${chip}`);
    console.log(`========================================`);
    try {
        const dev = new MPU6050Device();
        const { mcu, getConsole } = await bootMpy({
            chip,
            binPath: `samples/mpy/mpy_${tag}.bin`,
            elfPath: `samples/mpy/mpy_${tag}.elf`,
            setup: (m) => {
                m.i2c.register(0x68, { i2cWrite: (x) => dev.onWrite(x), i2cRead: (l) => dev.onRead(l) });
                m.spi.onTransfer((b) => b ^ 0x55);
            },
        });
        const checks = [];
        const bannerOk = getConsole().includes('MicroPython v1.29.0');
        console.log(`banner: ${bannerOk ? 'PASS' : 'FAIL'}`);
        checks.push(bannerOk);
        const t = async (line, want) => {
            const out = replExec(mcu, getConsole, line).pump();
            const ok = out.includes(want);
            console.log(`${ok ? 'PASS' : 'FAIL'}  ${line}  ->  ${JSON.stringify(out.slice(line.length, line.length + 40))}`);
            if (!ok) console.log('   full:', JSON.stringify(out));
            checks.push(ok);
        };
        await t('print(1+1)', '\r\n2\r\n');
        await t('from machine import I2C, Pin, SPI', '>>> ');
        await t('i2c = I2C(0, scl=Pin(9), sda=Pin(8), freq=100000)', '>>> ');
        await t('i2c.writeto(0x68, b"\\x3b")', '\r\n1\r\n');
        await t('print(list(i2c.readfrom(0x68, 3)))', '[222, 173, 190]');
        await t('print(list(i2c.readfrom_mem(0x68, 0x3b, 3)))', '[222, 173, 190]');
        await t(`spi = SPI(1, baudrate=1000000, sck=Pin(${spiPins[0]}), mosi=Pin(${spiPins[1]}), miso=Pin(${spiPins[2]}))`, '>>> ');
        await t('print(list(spi.read(3, 0x00)))', '[85, 85, 85]');
        const pass = checks.every(Boolean);
        console.log(`MicroPython/${tag}: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
        results.push(pass);
    } catch (e) {
        console.log(`MicroPython/${tag}: FAIL ❌ (${e.message})`);
        results.push(false);
    }
}

console.log('\n================================================================================');
if (results.every(Boolean)) {
    console.log('ALL MICROPYTHON FIRMWARE TESTS PASSED (REPL + I2C + SPI on C3/C6/H2)! ✅');
} else {
    console.log('MICROPYTHON FAILURES PRESENT ❌');
    process.exit(1);
}
console.log('================================================================================\n');
