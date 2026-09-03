// ReplyDribbler — paced host->firmware delivery for the UART0 APC bridge.
//
// `emu.uart_input()` feeds the guest's hardware RX FIFO (128B on real
// silicon). Pushing a large reply (SDMMC sector = 512B, camera frame = 9KB)
// in one call overflows the FIFO and the excess bytes are silently dropped,
// leaving the polling shim spinning forever. Small replies (1..16B, e.g. SPI
// bytes, I2C reads, ADC samples) fit and are unaffected.
//
// Usage: queue replies instead of writing them directly, then `pump()` once
// per emulator batch (even batches with no console output — a polling shim
// produces no output while it waits).
export class ReplyDribbler {
    /**
     * @param {number} [chunk=16] - Max bytes released per pump() call.
     *   Measured: single uart_input() pushes larger than ~16B corrupt exactly
     *   one byte per transfer (the last byte of the first 32B push reads back
     *   as 0x00); pushes above ~32..47B lose their tail (guest HW RX FIFO).
     *   16B pushes verify bit-exact over multi-KB transfers. Always pump once
     *   per emulator batch, even batches with no console output.
     */
    constructor(chunk = 16) {
        this.chunk = chunk;
        this.queue = [];
    }

    /** Queue bytes for paced delivery. */
    push(bytes) {
        if (!bytes || bytes.length === 0) return;
        const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
        this.queue.push({ buf, off: 0 });
    }

    get pending() {
        return this.queue.length > 0;
    }

    /** Drop all queued replies (e.g. on emulator reset). */
    clear() {
        this.queue.length = 0;
    }

    /**
     * Release up to `chunk` queued bytes via `writeFn(subarray)`.
     * Call once per emulator batch, unconditionally.
     */
    pump(writeFn) {
        let n = this.chunk;
        while (n > 0 && this.queue.length > 0) {
            const head = this.queue[0];
            const take = Math.min(n, head.buf.length - head.off);
            writeFn(head.buf.subarray(head.off, head.off + take));
            head.off += take;
            n -= take;
            if (head.off >= head.buf.length) this.queue.shift();
        }
    }
}
