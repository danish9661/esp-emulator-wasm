// On-Chip I2C Bus Master Controller for ESP32 RISC-V
// Supports 7-bit slave address routing, device registration, and activity events.

export class I2CBus {
    constructor() {
        this.devices = new Map();
        this._writeListeners = new Set();
        this._readListeners = new Set();
        this._activityListeners = new Set();
    }

    /**
     * Attach a virtual I2C peripheral to a 7-bit slave address.
     * @param {number} address - 7-bit I2C address (e.g. 0x3C, 0x68)
     * @param {object} device - Object implementing `i2cWrite?(data)` and `i2cRead?(length)`
     */
    register(address, device) {
        this.devices.set(address, device);
    }

    /**
     * Unregister a device from a 7-bit slave address.
     * @param {number} address
     */
    unregister(address) {
        this.devices.delete(address);
    }

    /**
     * Listen for I2C write transactions.
     * @param {(address: number, data: number[]) => void} callback
     */
    onWrite(callback) {
        this._writeListeners.add(callback);
        return () => this._writeListeners.delete(callback);
    }

    /**
     * Listen for I2C read requests.
     * @param {(address: number, length: number) => number[] | Uint8Array | void} callback
     */
    onRead(callback) {
        this._readListeners.add(callback);
        return () => this._readListeners.delete(callback);
    }

    /**
     * Listen for all I2C bus transactions (read & write).
     * @param {(activity: { op: 'write' | 'read', addr: number, data?: number[], reply?: number[] }) => void} callback
     */
    onActivity(callback) {
        this._activityListeners.add(callback);
        return () => this._activityListeners.delete(callback);
    }

    /**
     * Internal: Dispatch an I2C write transaction from guest firmware.
     */
    write(address, data) {
        const dev = this.devices.get(address);
        if (dev && typeof dev.i2cWrite === 'function') {
            dev.i2cWrite(data);
        }

        for (const listener of this._writeListeners) {
            try {
                listener(address, data);
            } catch (err) {
                console.error(`Error in I2C onWrite listener for 0x${address.toString(16)}:`, err);
            }
        }

        for (const listener of this._activityListeners) {
            try {
                listener({ op: 'write', addr: address, data });
            } catch (_) {}
        }
    }

    /**
     * Internal: Dispatch an I2C read request from guest firmware.
     */
    read(address, length) {
        let reply = null;
        const dev = this.devices.get(address);
        if (dev && typeof dev.i2cRead === 'function') {
            reply = dev.i2cRead(length);
        }

        if (!reply) {
            for (const listener of this._readListeners) {
                try {
                    const res = listener(address, length);
                    if (res && res.length) {
                        reply = res;
                        break;
                    }
                } catch (err) {
                    console.error(`Error in I2C onRead listener for 0x${address.toString(16)}:`, err);
                }
            }
        }

        const replyBytes = reply ? Array.from(reply) : new Array(length).fill(0xFF);

        for (const listener of this._activityListeners) {
            try {
                listener({ op: 'read', addr: address, length, reply: replyBytes });
            } catch (_) {}
        }

        return replyBytes;
    }
}
