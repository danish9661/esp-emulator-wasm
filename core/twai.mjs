// On-Chip TWAI / CAN Bus Controller for ESP32 RISC-V (ISO 11898-1)
// Supports Standard (11-bit) and Extended (29-bit) CAN 2.0B frames and live packet injection.

export class TWAIController {
    constructor() {
        this.rxQueue = [];
        this._activityListeners = new Set();
    }

    /**
     * Listen for CAN bus traffic (TX from guest or RX injected).
     * @param {(frame: { type: 'tx' | 'rx', id: number, extd: boolean, rtr: boolean, dlc: number, data: number[] }) => void} callback
     */
    onActivity(callback) {
        this._activityListeners.add(callback);
        return () => this._activityListeners.delete(callback);
    }

    /**
     * Inject an incoming CAN frame into the ESP32's TWAI receiver queue.
     * @param {{ id: number, extd?: boolean, rtr?: boolean, dlc?: number, data?: number[] }} frame
     */
    inject(frame) {
        const id = frame.id || 0;
        const extd = Boolean(frame.extd || id > 0x7FF);
        const rtr = Boolean(frame.rtr);
        const data = (frame.data || []).slice(0, 8);
        const dlc = frame.dlc !== undefined ? frame.dlc : data.length;

        // Pack binary response matching the guest synchronous twai_receive protocol
        const payload = new Uint8Array(15);
        payload[0] = 1; // Available status flag (ESP_OK)
        payload[1] = (extd ? 1 : 0) | (rtr ? 2 : 0); // flags

        // 4-byte ID split into 7-bit chunks
        payload[2] = (id >> 21) & 0x7F;
        payload[3] = (id >> 14) & 0x7F;
        payload[4] = (id >> 7) & 0x7F;
        payload[5] = id & 0x7F;

        payload[6] = dlc & 0x0F;
        for (let i = 0; i < 8; i++) {
            payload[7 + i] = i < data.length ? data[i] & 0xFF : 0;
        }

        this.rxQueue.push(payload);

        const event = { type: 'rx', id, extd, rtr, dlc, data };
        for (const listener of this._activityListeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('Error in TWAI onActivity listener:', err);
            }
        }
    }

    /**
     * Internal: Called when guest firmware transmits a CAN frame.
     */
    transmit(frame) {
        const event = {
            type: 'tx',
            id: frame.id,
            extd: Boolean(frame.extd),
            rtr: Boolean(frame.rtr),
            dlc: frame.dlc || 0,
            data: frame.data || [],
        };

        for (const listener of this._activityListeners) {
            try {
                listener(event);
            } catch (err) {
                console.error('Error in TWAI onActivity listener:', err);
            }
        }
    }

    /**
     * Internal: Pop the next queued RX frame for the guest receiver.
     * @returns {Uint8Array | null}
     */
    popRxFrame() {
        if (this.rxQueue.length === 0) return null;
        return this.rxQueue.shift();
    }
}
