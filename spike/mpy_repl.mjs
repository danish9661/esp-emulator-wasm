// MicroPython REPL harness: boot a prebuilt MP firmware image and drive the
// friendly REPL over UART0 (uart0.write in, onData out). Not part of the
// APC/shim suites — MicroPython firmware carries no Arduino symbols.
// Usage: node spike/30-verify-mpy.mjs
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

export async function bootMpy({ chip, binPath, elfPath = null, setup = null, gpioProbe = false, batches = 2500, batchSize = 100000 }) {
    const flash = new Uint8Array(readFileSync(binPath));
    const mcu = await ESP32C3.create({ chip });
    if (setup) setup(mcu);
    await mcu.loadFirmware(flash, elfPath ? new Uint8Array(readFileSync(elfPath)) : null);
    let cons = '';
    mcu.uart0.onData((t) => { cons += t; });
    const getConsole = () => cons;
    for (let i = 0; i < batches; i++) {
        mcu.step(batchSize);
        if (cons.includes('>>> ')) break;
    }
    if (!cons.includes('>>> ')) throw new Error(`no REPL prompt on ${chip} after ${batches} batches`);
    if (gpioProbe) await calibrateGpioLive(mcu, getConsole);
    return { mcu, getConsole };
}

/**
 * Discover the true GPIO OUT/ENABLE/IN linear addresses, all in-instance:
 * two-pin co-movement finds OUT (heap noise can't move two pins in lockstep)
 * and ENABLE (set at construction, persists), then IN is found empirically by
 * writing each candidate offset and watching MP's own readback flip.
 * Needed because the zero-pattern heuristic in core/gpio.mjs can never match
 * UART0-active firmware (MicroPython) and latches onto garbage instead.
 * Throws if anything fails to validate (never silently accepts garbage).
 */
export async function calibrateGpioLive(mcu, getConsole, { pins = [2, 3] } = {}) {
    const exec = (line, maxBatches = 400) => replExec(mcu, getConsole, line).pump(maxBatches);
    const snap = () => {
        mcu.step(30000);
        return new Uint32Array(mcu.gpio._memory.buffer).slice();
    };
    exec('from machine import Pin');
    const [p, q] = pins;
    const both = (1 << p) | (1 << q);
    exec(`_pa = Pin(${p}, Pin.OUT)`);
    exec(`_pb = Pin(${q}, Pin.OUT)`);
    const s0 = snap();
    exec('_pa.on()');
    exec('_pb.on()');
    const s1 = snap();
    exec('_pa.off()');
    exec('_pb.off()');
    const s2 = snap();
    exec('_pa.on()');
    exec('_pb.on()');
    const s3 = snap();
    exec('_pa.off()');
    exec('_pb.off()');
    const s4 = snap();
    // OUT: both bits track 0,1,0,1,0 across all five snapshots AND start at
    // exactly 0 (nothing drives GPIO before our pins; STATUS-like shadows
    // read all-ones and are excluded by this).
    const outs = [];
    for (let i = 0; i + 7 < s1.length; i++) {
        if (s0[i] === 0 && (s1[i] & both) === both && !(s2[i] & both) &&
            (s3[i] & both) === both && !(s4[i] & both)) outs.push(i * 4);
    }
    if (outs.length !== 1) {
        // Shadows can track levels too (e.g. STATUS words); the true OUT has
        // its ENABLE word (construction bits held) 8 bytes past it in linear
        // memory (magic-probe measured, C3+C6). Prefer that, never guess.
        const paired = outs.filter((a) => (s1[a / 4 + 2] & both) === both);
        if (paired.length === 1) {
            outs.length = 0;
            outs.push(paired[0]);
        }
    }
    if (outs.length !== 1) throw new Error(`GPIO OUT discovery: ${outs.length} hits on ${mcu.chip}`);
    const out = outs[0];
    // ENABLE sits 8 bytes past OUT in linear memory (magic-probe measured);
    // sanity-check our construction bits are present, never scan for it.
    const uEn = new Uint32Array(mcu.gpio._memory.buffer)[out / 4 + 2];
    if ((uEn & both) !== both) throw new Error(`GPIO ENABLE sanity failed on ${mcu.chip}`);
    const enable = out + 8;
    // IN: sweep candidate offsets; the true one flips MP's readback. Drive
    // pin p as INPUT so IN (not the OUT latch) determines its readback.
    exec(`_pa = Pin(${p}, Pin.IN)`);
    const readback = () => {
        const tail = exec(`_pa.value()`);
        const m = tail.match(/\r\n([01])\r\n/);
        return m ? m[1] : null;
    };
    let input = -1;
    for (let off = 0; off <= 0x80; off += 4) {
        const idx = out / 4 + off / 4;
        const orig = new Uint32Array(mcu.gpio._memory.buffer)[idx];
        new Uint32Array(mcu.gpio._memory.buffer)[idx] = 0xffffffff;
        mcu.step(30000);
        const hi = readback();
        new Uint32Array(mcu.gpio._memory.buffer)[idx] = 0x00000000;
        mcu.step(30000);
        const lo = readback();
        new Uint32Array(mcu.gpio._memory.buffer)[idx] = orig;
        if (hi === '1' && lo === '0') { input = out + off; break; }
    }
    if (input < 0) throw new Error(`GPIO IN discovery failed on ${mcu.chip}`);
    mcu.gpio.setBaseAddrs({ out, enable, input });
    mcu.step(50000);
    return { out, enable, input };
}

// Send one friendly-REPL line; resolves with console output up to (and
// including) the next '>>> ' prompt. Caller owns stepping via the returned
// pump: pump(n) runs n batches and returns true once the prompt reappears.
export function replExec(mcu, getConsole, line, batchSize = 100000) {
    const before = getConsole().length;
    mcu.uart0.write(line + '\r\n');
    return {
        pump(maxBatches = 600) {
            for (let i = 0; i < maxBatches; i++) {
                mcu.step(batchSize);
                const now = getConsole();
                // prompt reappeared past what we had before sending
                const tail = now.slice(before);
                if (tail.split('>>> ').length >= 2) return tail;
            }
            throw new Error(`REPL exec timed out: ${line}`);
        },
    };
}
