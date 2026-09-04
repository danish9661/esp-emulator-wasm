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

// Human-readable names for the HCI opcodes NimBLE actually emits.
export const HCI_COMMAND_NAMES = {
    0x0c01: 'Set_Event_Mask',
    0x0c03: 'Reset',
    0x0c6d: 'Write_LE_Host_Supported',
    0x1001: 'Read_Local_Version',
    0x1002: 'Read_Supported_Commands',
    0x1003: 'Read_Local_Supported_Features',
    0x1009: 'Read_BD_ADDR',
    0x2001: 'LE_Set_Event_Mask',
    0x2002: 'LE_Read_Buffer_Size',
    0x2003: 'LE_Read_Supported_Features',
    0x2005: 'LE_Set_Random_Address',
    0x2006: 'LE_Set_Adv_Params',
    0x2007: 'LE_Read_Adv_Tx_Power',
    0x2018: 'LE_Rand',
    0x2008: 'LE_Set_Adv_Data',
    0x2009: 'LE_Set_Scan_Rsp_Data',
    0x200a: 'LE_Set_Adv_Enable',
    0x200c: 'LE_Set_Scan_Enable',
    0x2010: 'LE_Read_White_List_Size',
    0x2011: 'LE_Set_Scan_Params',
    0x201c: 'LE_Read_Supported_States',
    0x2022: 'LE_Read_Max_Data_Length',
    0x2031: 'LE_Set_Ext_Scan_Params',
    0x2033: 'LE_Read_Num_Adv_Sets',
    0x2036: 'LE_Set_Ext_Adv_Params',
    0x2037: 'LE_Set_Ext_Adv_Data',
    0x2038: 'LE_Set_Ext_Scan_Rsp',
    0x2039: 'LE_Set_Ext_Adv_Enable',
    0x203a: 'LE_Read_Max_Adv_Data_Len',
    0xfc01: 'ESP_VS_Gen_Random_Addr',
};

export class BLEController {
    constructor() {
        // HCI byte-stream observers (firmware -> controller commands and
        // controller -> firmware events). Powers --hci timeline output,
        // the web UI Peripheral Monitor, and headless HCI assertions.
        this._hciListeners = new Set();
    }

    /**
     * Listen for raw HCI traffic.
     * @param {(msg: { dir: 'cmd'|'evt', opcode?: number, name?: string, bytes: number[] }) => void} callback
     */
    onHci(callback) {
        this._hciListeners.add(callback);
        return () => this._hciListeners.delete(callback);
    }

    #notify(msg) {
        for (const l of this._hciListeners) {
            try { l(msg); } catch (_) {}
        }
    }

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
        this.#notify({ dir: 'cmd', opcode, name: HCI_COMMAND_NAMES[opcode] || ('0x' + opcode.toString(16).padStart(4, '0')), bytes: [...msg] });
        const evt = this._buildEvent(opcode, params);
        this.#notify({ dir: 'evt', opcode, bytes: [0x04, ...evt] });
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
                // Claim everything: every command the host may gate behind
                // this bitmap is stubbed-success below, so a zero bitmap
                // would only disable real flows (and break startup checks).
                return st(...new Array(64).fill(0xff));
            }
            case 0x1003: // Read Local Supported Features (8 bytes)
                // ble_hs_startup_go requires feature bits 0x60 and retries
                // the whole startup (Reset loop) when they are clear, so an
                // empty stub wedges NimBLE sync forever. Claim them all.
                return st(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
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
            case 0x2018: // LE Rand (8 random bytes; fixed sim value)
                return st(0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22);
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

            case 0xfc01: // ESP vendor: generate static random address (6 bytes).
                // ble_hs_util_ensure_rand_addr falls back to this when no
                // public address exists; an empty stub trips the response-
                // length check in ble_hs_hci_cmd_tx, which schedules a host
                // reset — the infinite Reset loop. Top bits 0b11 = static.
                return st(0xc4, 0x22, 0x22, 0x22, 0x22, 0x22);

            default:
                // Unknown command: respond SUCCESS so NimBLE does not wedge.
                return st();
        }
    }
}
