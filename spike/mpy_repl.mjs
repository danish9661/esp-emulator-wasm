// MicroPython REPL harness: boot a prebuilt MP firmware image and drive the
// friendly REPL over UART0 (uart0.write in, onData out). Not part of the
// APC/shim suites — MicroPython firmware carries no Arduino symbols.
// Usage: node spike/30-verify-mpy.mjs
import { readFileSync } from 'node:fs';
import { ESP32C3 } from '../index.mjs';

export async function bootMpy({ chip, binPath, elfPath = null, setup = null, batches = 2500, batchSize = 100000 }) {
    const flash = new Uint8Array(readFileSync(binPath));
    const mcu = await ESP32C3.create({ chip });
    if (setup) setup(mcu);
    await mcu.loadFirmware(flash, elfPath ? new Uint8Array(readFileSync(elfPath)) : null);
    let cons = '';
    mcu.uart0.onData((t) => { cons += t; });
    for (let i = 0; i < batches; i++) {
        mcu.step(batchSize);
        if (cons.includes('>>> ')) break;
    }
    if (!cons.includes('>>> ')) throw new Error(`no REPL prompt on ${chip} after ${batches} batches`);
    return { mcu, getConsole: () => cons };
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
