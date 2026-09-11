// Virtual 802.15.4 / Thread controller (Phase 1a: observability; 1b: TX +
// scan telemetry for the gateway bridge).
//
// Frames from the shims in thread_shims.mjs:
//   `G<ch:raw><len:raw><psdu:2*len nibbles>` — otPlatRadioTransmit tap
//   `H<ch:raw>`                              — otPlatRadioEnergyScan tap
// Phase 1b will add a virtual peer + gateway bridge to /api/thread-gateway
// (frame routing, beacon synthesis for active-scan ReceiveDone).

export class ThreadController {
    constructor() {
        this.txCount = 0;
        this.lastChannel = -1;
        this.lastLen = -1;
        this.lastPsdu = new Uint8Array(0);
        this.frames = [];
        this.scanCount = 0;
        this.scans = [];
        this._listeners = new Set();
    }

    onActivity(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    _emit(rec) {
        for (const cb of this._listeners) {
            try { cb(rec); } catch (_) {}
        }
    }

    /** Handle a `G` frame body: raw ch/len + nibble-encoded PSDU. */
    handle(body) {
        if (!body || body.length < 2) return;
        const ch = body.charCodeAt(0) & 0xff;
        const len = Math.min(body.charCodeAt(1) & 0xff, 127);
        const psdu = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            const hi = (body.charCodeAt(2 + i * 2) - 97) & 0xf;
            const lo = (body.charCodeAt(2 + i * 2 + 1) - 97) & 0xf;
            psdu[i] = ((hi << 4) | lo) & 0xff;
        }
        this.txCount += 1;
        this.lastChannel = ch;
        this.lastLen = len;
        this.lastPsdu = psdu;
        const rec = { kind: 'tx', channel: ch, len, psdu, n: this.txCount };
        this.frames.push(rec);
        if (this.frames.length > 256) this.frames.shift();
        this._emit(rec);
    }

    /** Handle an `H` frame body: raw channel byte. */
    handleScan(body) {
        if (!body || body.length < 1) return;
        const ch = body.charCodeAt(0) & 0xff;
        this.scanCount += 1;
        const rec = { kind: 'scan', channel: ch, n: this.scanCount };
        this.scans.push(rec);
        if (this.scans.length > 64) this.scans.shift();
        this._emit(rec);
    }

    reset() {
        this.txCount = 0;
        this.lastChannel = -1;
        this.lastLen = -1;
        this.lastPsdu = new Uint8Array(0);
        this.frames.length = 0;
        this.scanCount = 0;
        this.scans.length = 0;
    }
}
