// BLE shared-memory event channel (host side).
//
// Guest->host commands still travel as UART APC `B` frames (reliable TX).
// Host->guest events do NOT use UART RX (pushed bytes are unreliable for the
// guest to poll on this core): instead the send_packet shim writes a magic
// rendezvous pair, emits B, then polls a flag word; the host discovers the
// WASM linear-memory mirror by scanning for the magic (once per boot),
// writes the HCI event bytes to the evtBase mirror, and sets flag=1.
//
// Layout inside the per-chip BLE scratch (guest vaddrs, see ble_shims.mjs):
//   +BLE_CB_OFF   callback pointer (guest-written)
//   +BLE_FLAG_OFF flag word: MAGIC1 while waiting, 1 when the event is ready
//   +FLAG_OFF+4   MAGIC2 (never overwritten by the host: cache validation)
//   +BLE_EVT_OFF  event buffer (host-written, up to 256B)

import { BLE_MAGIC1, BLE_MAGIC2, BLE_FLAG_OFF, BLE_EVT_OFF } from './ble_shims.mjs';

const EVT_CAP = 256;

export class BLEMirror {
    /**
     * @param {() => ArrayBuffer} getBuffer - fresh WASM linear memory buffer
     *   on every call (the buffer detaches if linear memory grows).
     */
    constructor(getBuffer) {
        this.getBuffer = getBuffer;
        this.flagLin = null;
        this.warned = false;
    }

    /** Forget the cached mirror (call on firmware load / reset). */
    clear() {
        this.flagLin = null;
        this.warned = false;
    }

    /** Scan linear memory for the magic pair; cache the flag offset. */
    discover() {
        let u32;
        try {
            u32 = new Uint32Array(this.getBuffer());
        } catch (_) {
            return false;
        }
        for (let i = 0; i < u32.length - 1; i++) {
            if ((u32[i] >>> 0) === BLE_MAGIC1 && (u32[i + 1] >>> 0) === BLE_MAGIC2) {
                this.flagLin = i * 4;
                return true;
            }
        }
        return false;
    }

    /**
     * Deliver HCI event bytes to the waiting guest.
     * @param {Uint8Array|number[]} event - full VHCI event message
     * @returns {boolean} true if delivered via shared memory
     */
    deliver(event) {
        const bytes = event instanceof Uint8Array ? event : Uint8Array.from(event || []);
        if (this.flagLin !== null) {
            // Validate the cache: the guest rewrites the magic pair before
            // every send; a stale boot mapping would hang the guest.
            let u32;
            try {
                u32 = new Uint32Array(this.getBuffer());
            } catch (_) {
                this.flagLin = null;
            }
            if (this.flagLin !== null) {
                const w0 = u32[this.flagLin >>> 2] >>> 0;
                const w1 = u32[(this.flagLin >>> 2) + 1] >>> 0;
                if (w0 !== BLE_MAGIC1 || w1 !== BLE_MAGIC2) this.flagLin = null;
            }
        }
        if (this.flagLin === null && !this.discover()) {
            if (!this.warned) {
                this.warned = true;
                console.warn('[ble] shared-memory mirror not found; E-UART fallback');
            }
            return false;
        }
        try {
            const buf = this.getBuffer();
            const u8 = new Uint8Array(buf);
            const evtLin = this.flagLin + (BLE_EVT_OFF - BLE_FLAG_OFF);
            const n = Math.min(bytes.length, EVT_CAP);
            for (let i = 0; i < n; i++) u8[evtLin + i] = bytes[i] & 0xff;
            new Uint32Array(buf)[this.flagLin >>> 2] = 1;
            return true;
        } catch (_) {
            this.flagLin = null;
            return false;
        }
    }
}
