// On-Chip SPI Bus Master Controller for ESP32 RISC-V
// Supports full-duplex byte transfers, burst multi-byte writes, and device registration.

export class SPIBus {
    constructor() {
        this.devices = new Map();
        this._transferListeners = new Set();
        this._writeListeners = new Set();
        this._activityListeners = new Set();
    }

    /**
     * Attach a virtual SPI peripheral device (e.g. ST7789 TFT, SD Card).
     * @param {string | number} nameOrCsPin - Identifier or Chip Select pin
     * @param {object} device - Object implementing `spiTransferByte?(b)` and/or `spiWrite?(bytes)`
     */
    register(nameOrCsPin, device) {
        this.devices.set(nameOrCsPin, device);
    }

    /**
     * Unregister a device from the SPI bus.
     * @param {string | number} nameOrCsPin
     */
    unregister(nameOrCsPin) {
        this.devices.delete(nameOrCsPin);
    }

    /**
     * Listen for full-duplex SPI byte transfers.
     * @param {(txByte: number) => number | void} callback
     */
    onTransfer(callback) {
        this._transferListeners.add(callback);
        return () => this._transferListeners.delete(callback);
    }

    /**
     * Listen for multi-byte burst SPI writes.
     * @param {(bytes: number[]) => void} callback
     */
    onWrite(callback) {
        this._writeListeners.add(callback);
        return () => this._writeListeners.delete(callback);
    }

    /**
     * Listen for all SPI bus transactions.
     * @param {(activity: { data?: number[], reply?: number[] }) => void} callback
     */
    onActivity(callback) {
        this._activityListeners.add(callback);
        return () => this._activityListeners.delete(callback);
    }

    /**
     * Internal: Perform a full-duplex single byte transfer.
     */
    transferByte(txByte) {
        let rxByte = 0xFF;

        for (const dev of this.devices.values()) {
            if (typeof dev.spiTransferByte === 'function') {
                const res = dev.spiTransferByte(txByte);
                if (res !== undefined) rxByte = res & 0xFF;
            }
        }

        for (const listener of this._transferListeners) {
            try {
                const res = listener(txByte);
                if (res !== undefined) rxByte = res & 0xFF;
            } catch (err) {
                console.error('Error in SPI onTransfer listener:', err);
            }
        }

        for (const listener of this._activityListeners) {
            try {
                listener({ data: [txByte], reply: [rxByte] });
            } catch (_) {}
        }

        return rxByte;
    }

    /**
     * Internal: Perform a burst multi-byte write.
     */
    write(bytes) {
        for (const dev of this.devices.values()) {
            if (typeof dev.spiWrite === 'function') {
                dev.spiWrite(bytes);
            }
        }

        for (const listener of this._writeListeners) {
            try {
                listener(bytes);
            } catch (err) {
                console.error('Error in SPI onWrite listener:', err);
            }
        }

        for (const listener of this._activityListeners) {
            try {
                listener({ data: bytes });
            } catch (_) {}
        }
    }
}
