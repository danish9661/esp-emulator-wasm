// Minimal virtual HCI controller (JS-side replacement for native periph::ble_hci).
// Translates HCI command packets coming from the firmware's NimBLE host (forwarded
// via the 'B' UART APC) into HCI event packets, which are delivered back to the
// firmware via the 'E' APC.
//
// VHCI message framing (ESP32 vendor HCI):
//   host -> controller (esp_vhci_host_send_packet): [0x01 type][HCI cmd packet]
//   controller -> host (registered callback):       [0x04 type][HCI event packet]
// where HCI cmd packet = [opcode_lo, opcode_hi, param_len, params...]
//   and HCI event packet = [event_code, length, ...event params]

const EVT_CMD_COMPLETE = 0x0e;
const EVT_CMD_STATUS = 0x0f;

export class BLEController {
    /**
     * @param {Uint8Array|number[]} msg - full VHCI message [type, opcode_lo, opcode_hi, ...]
     * @returns {number[]} full VHCI event message [0x04, event_code, ...]
     */
    handle(msg) {
        const type = msg[0];
        const opLo = msg[1] & 0xff;
        const opHi = msg[2] & 0xff;
        const opcode = (opHi << 8) | opLo;
        const plen = msg[3] & 0xff;
        const params = msg.slice(4, 4 + plen);
        const evt = this._buildEvent(opcode, params);
        return [0x04, ...evt];
    }

    _cmdComplete(opLo, opHi, returnParams) {
        const body = [0x01, opLo, opHi, ...returnParams]; // num_hci_cmd_packets=1
        return [EVT_CMD_COMPLETE, body.length, ...body];
    }

    _buildEvent(opcode, params) {
        const opLo = opcode & 0xff;
        const opHi = (opcode >> 8) & 0xff;
        const st = (...rest) => this._cmdComplete(opLo, opHi, [0x00, ...rest]);

        switch (opcode) {
            case 0x0c03: // Reset
                return st();
            case 0x0c01: // Set Event Mask
            case 0x0c6d: // Write LE Host Supported
                return st();

            case 0x1001: // Read Local Version Information
                return st(
                    0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // status + version blobs
                );
            case 0x1002: { // Read Local Supported Commands (64 bytes)
                const bits = new Array(64).fill(0);
                // advertise a reasonable feature set
                return st(...bits);
            }
            case 0x1009: // Read BD_ADDR
                return st(0x22, 0x22, 0x22, 0x22, 0x22, 0x22);

            case 0x2001: // LE Set Event Mask
            case 0x2005: // LE Set Random Address
            case 0x2006: // LE Set Advertising Parameters
            case 0x2008: // LE Set Advertising Data
            case 0x2009: // LE Set Scan Response Data
            case 0x200a: // LE Set Advertising Enable
            case 0x2011: // LE Set Scan Parameters
            case 0x200c: // LE Set Scan Enable
            case 0x2039: // LE Set Extended Advertising Enable
            case 0x2037: // LE Set Extended Advertising Data
            case 0x2038: // LE Set Extended Scan Response Data
            case 0x2031: // LE Set Extended Scan Parameters
                return st();

            case 0x2002: // LE Read Buffer Size
                return st(0x1b, 0x00, 0x08); // acl_len=27, num_pkts=8
            case 0x2003: // LE Read Local Supported Features
                return st(0x1f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
            case 0x2007: // LE Read Advertising Channel Tx Power
                return st(0xf6); // -10 dBm
            case 0x2010: // LE Read White List Size
                return st(0x08);
            case 0x201c: // LE Read Supported States
                return st(0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00, 0x00);
            case 0x2022: // LE Read Maximum Data Length
                return st(0xfb, 0x00, 0x48, 0x08, 0xfb, 0x00, 0x48, 0x08);
            case 0x2033: // LE Read Number of Supported Advertising Sets
                return st(0x08);
            case 0x203a: // LE Read Maximum Advertising Data Length
                return st(0xe0, 0x01); // 480
            case 0x2036: // LE Set Extended Advertising Parameters
                return st(0x00); // adv_handle status

            default:
                // Unknown command: respond SUCCESS so NimBLE does not wedge.
                return st();
        }
    }
}
