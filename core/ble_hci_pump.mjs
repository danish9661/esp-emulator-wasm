// BLE HCI pump: local virtual controller vs real-stack (Bumble) forwarding.
//
// The guest's B-frame bytes are H4 packets already ([0x01] cmd / [0x02] ACL),
// and the gateway's /api/ble-gateway proxies raw H4 to Bumble TCP 127.0.0.1:9544.
// So forwarding is a byte copy; the guest polls the shared-memory mirror flag
// across step batches, which makes the round trip async-safe (a spinning guest
// consumes its batch budget, the WS reply lands on the event-loop yield, the
// next batch observes flag==1).
//
// Ops Bumble 0.0.231 cannot serve (async-handler bug, no reply -> host hang)
// are always answered locally: ESP vendor 0xfc01, privacy-mode 0x204e.
// Host->controller ACL (0x02) is also local (Number-Of-Completed-Packets).
//
// Used by worker.js (real WebSocket transport + UI mode toggle) and exercised
// headless by spike/33-verify-ble-pump.mjs (fake transport + mirror).

import { BLEController, HCI_COMMAND_NAMES } from './ble_controller.mjs';

export const BLE_LOCAL_OPS = new Set([0xfc01, 0x204e]);

function opcodeOf(msg) {
    if (!msg || msg.length < 4 || msg[0] !== 0x01) return -1;
    return (((msg[2] & 0xff) << 8) | (msg[1] & 0xff)) >>> 0;
}

function encodeEFrame(event) {
    let out = '\x1b_E';
    const len = event.length;
    out += String.fromCharCode(97 + ((len >> 4) & 0xf), 97 + (len & 0xf));
    for (const b of event) out += String.fromCharCode(97 + ((b >> 4) & 0xf), 97 + (b & 0xf));
    out += '\x1b\\';
    return new TextEncoder().encode(out);
}

export class BleHciPump {
    /**
     * @param {object} deps
     * @param {BLEController} deps.controller - local virtual controller
     * @param {BLEMirror} deps.mirror - shared-memory event channel
     * @param {ReplyDribbler} deps.dribbler - E-UART fallback queue
     * @param {(msg:{dir:string,opcode?:number,name?:string,bytes:number[]})=>void} [deps.postHci]
     */
    constructor({ controller, mirror, dribbler, postHci }) {
        this.controller = controller;
        this.mirror = mirror;
        this.dribbler = dribbler;
        this.postHci = postHci || (() => {});
        this.mode = 'local';
        this.transport = null; // { send(Uint8Array):void, isOpen():boolean }
    }

    setMode(mode) {
        this.mode = mode === 'bumble' ? 'bumble' : 'local';
    }

    setTransport(t) {
        this.transport = t;
    }

    get useBumble() {
        return this.mode === 'bumble' && !!(this.transport && this.transport.isOpen());
    }

    deliverLocal(event) {
        if (event && event.length && !this.mirror.deliver(event)) {
            this.dribbler.push(encodeEFrame(event));
        }
    }

    /**
     * Route one guest B-frame (raw H4 bytes).
     * @returns {'local'|'forwarded'} for tests/telemetry
     */
    handleBFrame(msg) {
        const bytes = msg instanceof Uint8Array ? msg : Uint8Array.from(msg || []);
        const opcode = opcodeOf(bytes);
        if (this.useBumble && opcode >= 0 && !BLE_LOCAL_OPS.has(opcode)) {
            this.postHci({
                dir: 'cmd', opcode,
                name: HCI_COMMAND_NAMES[opcode] || ('0x' + opcode.toString(16).padStart(4, '0')),
                bytes: [...bytes],
            });
            this.transport.send(bytes);
            return 'forwarded';
        }
        const event = this.controller.handle(bytes);
        this.deliverLocal(event);
        return 'local';
    }

    /** Deliver one gateway WS binary message (raw H4 event) to the guest. */
    handleWsMessage(data) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (!bytes.length) return;
        this.postHci({ dir: 'evt', bytes: [...bytes] });
        if (!this.mirror.deliver(bytes)) {
            this.dribbler.push(encodeEFrame(bytes));
        }
    }
}
