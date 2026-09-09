// MicroPython v1.29.0 verification: REPL + machine.I2C/SPI/GPIO/ADC/PWM against the
// virtual MPU6050 (0x68) and XOR SPI bus, on C3/C6/H2/C5/P4. P4/C5 boot from
// composed flash images (bootloader @0x2000 + enlarged factory partition;
// see spike/mk_mpy_p4c5.py). P4 GPIO is unmodeled in the WASM core, skipped.
// Run: node spike/30-verify-mpy.mjs
import { bootMpy, replExec } from './mpy_repl.mjs';
import { MPU6050Device } from '../peripherals.mjs';

const CHIPS = [
    // pwmMax: C3 runs MP's 13-bit resolution @1kHz (max 8192); C6/H2 run
    // 16-bit, which our 14-bit P frame saturates at 16383 (never wraps).
    // adcPin/adcChan: MP's GPIO->ADC-channel mapping (H2 ADC1 starts at
    // GPIO1, so Pin(3) reads channel 2).
    { chip: 'esp32c3', tag: 'c3', spiPins: [6, 7, 2], pwmMax: 8192, adcPin: 3, adcChan: 3 },
    { chip: 'esp32c6', tag: 'c6', spiPins: [6, 7, 2], pwmMax: 16383, adcPin: 3, adcChan: 3 },
    // H2: GPIO6/7 are USB-reserved (MP rejects Pin(6)/Pin(7)), use 3/4/5.
    { chip: 'esp32h2', tag: 'h2', spiPins: [3, 4, 5], pwmMax: 16383, adcPin: 3, adcChan: 2 },
    // C5: like H2 (Pin(3) reads ADC channel 2, 16-bit PWM saturates); the
    // composed flash image carries bootloader + enlarged factory partition.
    { chip: 'esp32c5', tag: 'c5', flash: 'mpy_c5_flash.bin', spiPins: [6, 7, 2], pwmMax: 16383, adcPin: 3, adcChan: 2 },
    // P4: ADC lives on GPIO16+ (Pin(16) reads channel 0); GPIO is NOT
    // modeled in the WASM core (no co-moving word in linear memory), so the
    // GPIO block is skipped — REPL + I2C + SPI + ADC + PWM verified.
    { chip: 'esp32p4', tag: 'p4', flash: 'mpy_p4_flash.bin', spiPins: [6, 7, 2], pwmMax: 16383, adcPin: 16, adcChan: 0, gpio: false },
];

const results = [];
for (const { chip, tag, flash, spiPins, pwmMax, adcPin, adcChan, gpio } of CHIPS) {
    console.log(`\n========================================`);
    console.log(`TEST: MicroPython (machine.I2C/SPI/GPIO/ADC/PWM) on ${chip}`);
    console.log(`========================================`);
    try {
        const dev = new MPU6050Device();
        const { mcu, getConsole } = await bootMpy({
            chip,
            binPath: `samples/mpy/${flash ?? `mpy_${tag}.bin`}`,
            elfPath: `samples/mpy/mpy_${tag}.elf`,
            gpioProbe: gpio !== false,
            setup: (m) => {
                m.i2c.register(0x68, { i2cWrite: (x) => dev.onWrite(x), i2cRead: (l) => dev.onRead(l) });
                m.spi.onTransfer((b) => b ^ 0x55);
                m.adc.setRaw(adcChan, 2048);
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
        await t('from machine import I2C, Pin, SPI, ADC, PWM', '>>> ');
        await t('i2c = I2C(0, scl=Pin(9), sda=Pin(8), freq=100000)', '>>> ');
        await t('i2c.writeto(0x68, b"\\x3b")', '\r\n1\r\n');
        await t('print(list(i2c.readfrom(0x68, 3)))', '[222, 173, 190]');
        await t('print(list(i2c.readfrom_mem(0x68, 0x3b, 3)))', '[222, 173, 190]');
        await t('print(i2c.scan())', '[104]');
        await t(`spi = SPI(1, baudrate=1000000, sck=Pin(${spiPins[0]}), mosi=Pin(${spiPins[1]}), miso=Pin(${spiPins[2]}))`, '>>> ');
        await t('print(list(spi.read(3, 0x00)))', '[85, 85, 85]');
        // ADC: fixture set below via setRaw; read_u16 scales per MP's Taylor
        // formula (raw<<4 | raw>>8 at 12-bit width: 2048 -> 32776).
        // PWM: duty_u16 max bumps 65535->65536, then >>3 at MP's 13-bit
        // resolution @1kHz (from our 80MHz clock report) -> 8192.
        await t(`print(ADC(Pin(${adcPin})).read_u16())`, '\r\n32776\r\n');
        await t('w = PWM(Pin(8), freq=1000, duty_u16=0)', '>>> ');
        checks.push(mcu.pwm.getDuty(8) === 0);
        console.log(`${mcu.pwm.getDuty(8) === 0 ? 'PASS' : 'FAIL'}  pwm duty0 == 0`);
        await t('w.duty_u16(65535)', '>>> ');
        checks.push(mcu.pwm.getDuty(8) === pwmMax);
        console.log(`${mcu.pwm.getDuty(8) === pwmMax ? 'PASS' : 'FAIL'}  pwm dutymax == ${pwmMax}`);
        // GPIO via live discovery (see calibrateGpioLive in mpy_repl.mjs).
        // Skipped where the WASM core models no GPIO (P4).
        const c = (name, cond) => {
            console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
            checks.push(cond);
        };
        if (gpio !== false) {
        await t('p2 = Pin(2, Pin.OUT)', '>>> ');
        await t('p2.on()', '>>> ');
        c('gpio2 out+high', mcu.gpio.pin(2).isOutput && mcu.gpio.pin(2).value === true);
        await t('p2.off()', '>>> ');
        c('gpio2 low', mcu.gpio.pin(2).value === false);
        mcu.gpio.pin(4).setInput(false);
        await t('print(Pin(4, Pin.IN).value())', '\r\n0\r\n');
        mcu.gpio.pin(4).setInput(true);
        await t('print(Pin(4, Pin.IN).value())', '\r\n1\r\n');
        } else {
            console.log('gpio SKIPPED (unmodeled in WASM core)');
        }
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
    console.log('ALL MICROPYTHON FIRMWARE TESTS PASSED (REPL + I2C + SPI + GPIO + ADC + PWM on C3/C6/H2/C5; P4 without GPIO)! ✅');
} else {
    console.log('MICROPYTHON FAILURES PRESENT ❌');
    process.exit(1);
}
console.log('================================================================================\n');
