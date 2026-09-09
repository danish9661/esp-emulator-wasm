// BLE interception shims (JS-side replacement for the native CLI's periph::ble_hci).
//
// The WASM core compiles the BLE interception code but never activates it (no JS
// export turns it on). These shims replicate the native behavior by replacing the
// 5 VHCI/controller symbols in the firmware image:
//   esp_bt_controller_init               -> return 0 (skip real PHY init); its dead
//                                           body (1022 B) stores the big send_packet shim
//   esp_bt_controller_enable            -> return 0
//   esp_vhci_host_check_send_available  -> return 1
//   esp_vhci_host_register_callback     -> stash callback pointer in DRAM (runtime data)
//   esp_vhci_host_send_packet           -> trampoline to out-of-line shim (in dead
//                                           init body) that forwards HCI cmd to JS via
//                                           UART APC, receives HCI event back, calls cb()
//
// Communication with JS uses the same UART0 APC channel as other peripherals:
//   firmware -> JS : ESC _ 'B' <hex(cmd bytes)> ESC \   (parsed by uart.mjs)
//   JS -> firmware : ESC _ 'E' <2-hex len> <hex(event bytes)> ESC \   (injected into
//                     UART0 RX; the shim decodes it and calls cb())
// Hex encoding matches the SPI convention: nibble n -> 'a' + n (decoded -97).

import { assemble, asm32, li, jal, jalr, A0, A1, A2, A3, T0, T1, T2, T3, T4, T5, SP } from './rvasm.mjs';
import { I2C_CELL_BASE } from '../shims.mjs';

// Per-chip DRAM scratch for runtime data (callback ptr + event buffer). Lives in the
// firmware's RAM; .bss is zeroed at boot but that is fine — the firmware writes cb
// and the event bytes here at runtime.
//
// NOTE: the chosen addresses overlap stale, boot-time-only SPI-flash probe
// structs (.dram0.data) on Arduino builds — harmless in practice (never
// touched after boot), but the event bytes are only ever written by the host
// through the WASM linear-memory mirror, never by guest code.
export const BLE_SCRATCH = {
    esp32c3: 0x3fc94000,
    esp32c6: 0x40810000,
    esp32h2: 0x40810000,
    esp32c5: 0x40810000,
    esp32p4: 0x4ff44000,
};
export const BLE_CB_OFF = 0;
export const BLE_FLAG_OFF = 8;
export const BLE_EVT_OFF = 0x100;
// Host-written event length (u32) at scratch+4, next to the callback pointer.
// The NimBLE stack registers a STRUCT (esp_vhci_host_callback_t {send_avail,
// recv}) whose recv takes (data, len); direct callers (BLETest) register a
// plain fn(data). The send shim sniffs the pointer kind (see below) and the
// struct path needs the real length here.
export const BLE_LEN_OFF = 4;
// Guest->host rendezvous mark (guest writes both words before emitting B;
// host scans WASM linear memory for the pair once per boot to discover the
// mirror, writes the event, then sets flag=1).
export const BLE_MAGIC1 = 0xDEADBEEF;
export const BLE_MAGIC2 = 0xBEAC0001;

const UART_HI = { esp32c3: 0x60000, esp32c6: 0x60000, esp32h2: 0x60000, esp32c5: 0x60000, esp32p4: 0x500ca };

function stubReturn(value) {
    return asm32(assemble([{ op: 'addi', rd: A0, rs1: 0, imm: value }, { op: 'ret' }]));
}

function registerCb(scratch) {
    const cbAddr = scratch + BLE_CB_OFF;
    return asm32(assemble([
        ...li(T1, cbAddr),
        { op: 'sw', rs2: A0, rs1: T1, imm: 0 },
        // MUST return ESP_OK (0): esp_nimble_hci_init treats any nonzero
        // return as failure and aborts NimBLE startup silently (the sketch
        // ignores init()'s bool, so the host task is never created and no
        // HCI byte is ever sent). The pre-0.41 stub left A0 holding the
        // callback pointer, which is nonzero.
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ]));
}

/**
 * Parked VHCI inbound-injection body (C3 Arduino BLE: test console -> host).
 * Entered via a JAL overwrite of the sketch-global ble_console_inject stub
 * with a0 = packet type (4 = HCI event, 2 = ACL), a1 = flat buffer
 * ([evtcode][len]... / [handle][len][cid]...).
 * Copies [type][flat...] into the VHCI mirror slot (same layout the
 * send_packet shim + host mirror use) and invokes the registered host
 * receive callback exactly like sendPacket's tail (plain fn(data) vs
 * struct recv(data, len) sniffed by pointer top bits). Returns 0.
 * Uses t0-t5/a0-a3/sp only (caller-saved); preserves ra + sp.
 */
function vhciInjectPark({ scratch }) {
    const evtBase = scratch + BLE_EVT_OFF;
    const cbBase = scratch + BLE_CB_OFF;
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        // T1 = payload length: evt -> lbu[a1+1]+2; acl -> lbu[a1+2]+lbu[a1+3]<<8+4.
        { op: 'lbu', rd: T1, rs1: A1, imm: 1 },
        { op: 'addi', rd: T1, rs1: T1, imm: 2 },
        { op: 'addi', rd: T5, rs1: 0, imm: 4 },
        { op: 'beq', rs1: A0, rs2: T5, label: 'vinj_lenok' },
        { op: 'lbu', rd: T1, rs1: A1, imm: 2 },
        { op: 'lbu', rd: T2, rs1: A1, imm: 3 },
        { op: 'slli', rd: T2, rs1: T2, sh: 8 },
        { op: 'or', rd: T1, rs1: T1, rs2: T2 },
        { op: 'addi', rd: T1, rs1: T1, imm: 4 },
        { label: 'vinj_lenok' },
        // Stash total length in A2 (caller-saved, unused by the caller).
        { op: 'addi', rd: A2, rs1: T1, imm: 0 },
        // Copy [type][flat 0..len] to evtBase.
        ...li(T0, evtBase),
        { op: 'sb', rs2: A0, rs1: T0, imm: 0 },
        { op: 'addi', rd: T0, rs1: T0, imm: 1 },
        { op: 'addi', rd: T3, rs1: 0, imm: 0 },
        { label: 'vinj_copy' },
        { op: 'bge', rs1: T3, rs2: T1, label: 'vinj_copied' },
        { op: 'lbu', rd: T2, rs1: A1, imm: 0 },
        { op: 'sb', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: A1, rs1: A1, imm: 1 },
        { op: 'addi', rd: T0, rs1: T0, imm: 1 },
        { op: 'addi', rd: T3, rs1: T3, imm: 1 },
        { op: 'jal', rd: 0, label: 'vinj_copy' },
        { label: 'vinj_copied' },
        // Invoke the registered callback (same sniff as sendPacket tail).
        ...li(T1, cbBase),
        { op: 'lw', rd: T1, rs1: T1, imm: 0 },
        { op: 'beq', rs1: T1, rs2: 0, label: 'vinj_done' },
        { op: 'addi', rd: A1, rs1: A2, imm: 1 }, // a1 = total incl. type byte
        ...li(T0, evtBase),
        { op: 'addi', rd: A0, rs1: T0, imm: 0 },
        { op: 'srli', rd: T4, rs1: T1, sh: 20 },
        { op: 'addi', rd: T5, rs1: T4, imm: -0x400 },
        { op: 'beq', rs1: T5, rs2: 0, label: 'vinj_call' },
        { op: 'addi', rd: T5, rs1: T4, imm: -0x420 },
        { op: 'beq', rs1: T5, rs2: 0, label: 'vinj_call' },
        { op: 'addi', rd: T5, rs1: T4, imm: -0x403 },
        { op: 'beq', rs1: T5, rs2: 0, label: 'vinj_call' },
        { op: 'lw', rd: T1, rs1: T1, imm: 4 },
        { op: 'beq', rs1: T1, rs2: 0, label: 'vinj_done' },
        { label: 'vinj_call' },
        { op: 'jalr_ra', rs1: T1 },
        { label: 'vinj_done' },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

function sendPacket(scratch, uartHi, give) {
    const evtBase = scratch + BLE_EVT_OFF;
    const cbBase = scratch + BLE_CB_OFF;
    const flagBase = scratch + BLE_FLAG_OFF;
    const p = [
        // prologue: save ra, a0 (pkt), a1 (len)
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'sw', rs2: A0, rs1: SP, imm: 8 },
        { op: 'sw', rs2: A1, rs1: SP, imm: 4 },
        { op: 'lui', rd: T0, imm: uartHi << 12 },

        // mark rendezvous BEFORE emitting B: the host discovers the WASM
        // linear-memory mirror by scanning for this magic pair (once per
        // boot), writes the HCI event to the evtBase mirror, then sets flag=1.
        // (UART RX is not used: pushed bytes are unreliable for the guest to
        // poll on this core — see BLE-OBSERVABILITY.md.)
        ...li(T1, flagBase),
        ...li(T2, BLE_MAGIC1),
        { op: 'sw', rs2: T2, rs1: T1, imm: 0 },
        ...li(T2, BLE_MAGIC2),
        { op: 'sw', rs2: T2, rs1: T1, imm: 4 },

        // ---- transmit ESC _ B ----
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 95 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 66 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },

        // ---- hex-encode command bytes ----
        { op: 'lw', rd: T3, rs1: SP, imm: 8 },   // t3 = pkt
        { op: 'lw', rd: T5, rs1: SP, imm: 4 },   // t5 = len
        { op: 'addi', rd: T4, rs1: 0, imm: 0 },  // t4 = index (was garbage -> empty frames)
        { label: 'tx_loop' },
        { op: 'bge', rs1: T4, rs2: T5, label: 'tx_done' },
        { op: 'lbu', rd: T1, rs1: T3, imm: 0 },
        { op: 'srli', rd: T2, rs1: T1, sh: 4 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'andi', rd: T2, rs1: T1, imm: 15 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T3, rs1: T3, imm: 1 },
        { op: 'addi', rd: T4, rs1: T4, imm: 1 },
        { op: 'jal', rd: 0, label: 'tx_loop' },
        { label: 'tx_done' },
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 92 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },

        // ---- wait for the host's shared-memory event (flag==1) ----
        ...li(T1, flagBase),
        { label: 'rx_wait' },
        { op: 'lw', rd: T2, rs1: T1, imm: 0 },
        { op: 'addi', rd: T2, rs1: T2, imm: -1 },
        { op: 'bne', rs1: T2, rs2: 0, label: 'rx_wait' },

        // call cb(event buffer) — skipped when no callback is registered
        // (firmware calling send_packet before register_callback used to jump
        // to address 0 and hang the emulator).
        // Two registrations exist: direct callers (BLETest) pass a plain
        // fn(data); the NimBLE stack (esp_nimble_hci_init) passes a POINTER
        // to esp_vhci_host_callback_t {notify_send_available, notify_recv},
        // whose recv takes (data, len). Sniff by top-12 address bits: code
        // lives at 0x400xxxxx (ROM/IRAM) or 0x420xxxxx (flash text); structs
        // live in rodata (0x3Cxxxxxx) or DRAM. (Known limit: a callback
        // placed in C6/H2/C5 SRAM at 0x408xxxxx would misread as a struct;
        // in practice callbacks are flash functions or rodata structs.)
        ...li(T1, cbBase),
        { op: 'lw', rd: T1, rs1: T1, imm: 0 },     // t1 = registered pointer
        { op: 'beq', rs1: T1, rs2: 0, label: 'skip_cb' },
        ...li(T3, evtBase),
        { op: 'lw', rd: A1, rs1: T3, imm: BLE_LEN_OFF - BLE_EVT_OFF }, // a1 = len (host-written)
        { op: 'srli', rd: T4, rs1: T1, sh: 20 },   // top-12 bits of pointer
        { op: 'addi', rd: T5, rs1: T4, imm: -0x400 },
        { op: 'beq', rs1: T5, rs2: 0, label: 'call_cb' },
        { op: 'addi', rd: T5, rs1: T4, imm: -0x420 },
        { op: 'beq', rs1: T5, rs2: 0, label: 'call_cb' },
        { op: 'addi', rd: T5, rs1: T4, imm: -0x403 },
        { op: 'beq', rs1: T5, rs2: 0, label: 'call_cb' },
        { op: 'lw', rd: T1, rs1: T1, imm: 4 },     // struct: recv = *(cb+4)
        { op: 'beq', rs1: T1, rs2: 0, label: 'skip_cb' },
        { label: 'call_cb' },
        ...li(A0, evtBase),                        // a0 = event buffer
        { op: 'jalr_ra', rs1: T1 },
        { label: 'after_cb' },
        { label: 'skip_cb' },

        // Re-give the VHCI send semaphore: on real hardware the controller
        // frees a buffer per packet and notifies (r_vhci_notify_... via ISR),
        // but there is no radio here — the JS virtual controller answers
        // instantly, so the transport would block on the second command
        // forever. Giving here models infinite controller buffers.
        // (ra was saved in the prologue; a0 is re-zeroed below.)
        ...(give ? [
            ...li(T1, give.semAddr),
            { op: 'lw', rd: T1, rs1: T1, imm: 0 },
            { op: 'beq', rs1: T1, rs2: 0, label: 'skip_give' },
            { op: 'addi', rd: A0, rs1: T1, imm: 0 },
            { op: 'addi', rd: A1, rs1: 0, imm: 0 },
            { op: 'addi', rd: A2, rs1: 0, imm: 0 },
            { op: 'addi', rd: A3, rs1: 0, imm: 0 },
            ...li(T2, give.sendAddr),
            { op: 'jalr_ra', rs1: T2 },
            { label: 'skip_give' },
        ] : []),

        // epilogue
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Parked LL-transport command body (C6/H2/C5 Arduino BLE: NimBLE LINK LAYER
 * transport, no VHCI symbols). Entered via a JAL redirect from
 * ble_transport_to_ll_cmd_impl with a0 = flat HCI cmd buffer
 * ([opcode u16 LE][param_len u8][params...], built by ble_hs_hci_cmd_send_buf).
 * Forwards the command as a B frame, polls the shared-memory mirror for the
 * virtual controller's answer, copies it (minus the 0x04 indicator) to the
 * stack and delivers it by calling ble_transport_host_recv_cb(4, buf), then
 * re-gives ble_hs_hci_sem (infinite virtual buffers, same rationale as the
 * VHCI send shim) and returns 0.
 * Uses t0-t6/a0-a7/sp only (caller-saved); preserves ra + s-regs + sp.
 * Mirror rendezvous reuses the C3 relative layout at cellBase+0x400, so the
 * host mirror/controller code works unchanged.
 */
function llCmdPark({ cellBase, uartFull, recvAddr }) {
    const mirror = cellBase + 0x400;
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'lui', rd: T0, imm: uartFull },
        // mirror rendezvous (host scans for the magic pair, writes evt+len, sets flag=1)
        ...li(T1, mirror),
        ...li(T2, BLE_MAGIC1),
        { op: 'sw', rs2: T2, rs1: T1, imm: 8 },
        ...li(T2, BLE_MAGIC2),
        { op: 'sw', rs2: T2, rs1: T1, imm: 12 },
        // ---- transmit ESC _ B ----
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 95 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 66 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // VHCI packet-type byte 0x01 -> 'a','b'
        { op: 'addi', rd: T2, rs1: 0, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 98 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // ---- hex-encode flat buffer (total = buf[2] + 3) ----
        { op: 'lbu', rd: T3, rs1: A0, imm: 2 },
        { op: 'addi', rd: T4, rs1: T3, imm: 3 },
        { op: 'addi', rd: T5, rs1: A0, imm: 0 },
        { label: 'll_tx_loop' },
        { op: 'beq', rs1: T4, rs2: 0, label: 'll_tx_done' },
        { op: 'lbu', rd: T3, rs1: T5, imm: 0 },
        { op: 'srli', rd: T2, rs1: T3, sh: 4 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'andi', rd: T2, rs1: T3, imm: 15 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T5, rs1: T5, imm: 1 },
        { op: 'addi', rd: T4, rs1: T4, imm: -1 },
        { op: 'jal', rd: 0, label: 'll_tx_loop' },
        { label: 'll_tx_done' },
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 92 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // ---- wait for the host's shared-memory event (flag==1) ----
        ...li(T1, mirror),
        { label: 'll_rx_wait' },
        { op: 'lw', rd: T2, rs1: T1, imm: 8 },
        { op: 'addi', rd: T2, rs1: T2, imm: -1 },
        { op: 'bne', rs1: T2, rs2: 0, label: 'll_rx_wait' },
        // ---- deliver: recv_cb(4, evt+1). The event buffer stays in the
        // mirror (persistent until the next command), NOT on the stack:
        // ble_hs_hci_ack keeps pointing at it through wait_for_ack and
        // process_ack, long after we return (stack would be garbage).
        { op: 'addi', rd: A0, rs1: 0, imm: 4 },
        { op: 'addi', rd: A1, rs1: T1, imm: 0x101 },
        ...li(T2, recvAddr),
        { op: 'jalr_ra', rs1: T2 },
        // No semaphore re-give: the only takes are wait_for_ack (satisfied by
        // rx_evt's real give) — the pre-send and rx_evt takes are neutered
        // below, so takes={wait} and gives={rx_evt} balance from zero.
        // epilogue
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

function makeTrampoline(targetAddr) {
    return asm32(assemble([...li(T0, targetAddr), { op: 'jalr', rd: 0, rs1: T0, imm: 0 }]));
}

/**
 * Replacement for esp_bt_controller_init: instead of running the real radio
 * init (which spins on absent PHY hardware), create the VHCI send semaphore
 * the NimBLE transport needs and report success.
 *
 * Why: ble_hci_trans_hs_cmd_tx does
 *   xQueueSemaphoreTake(vhci_send_sem /* NULL *\/, 2000) -> fails -> drops
 *   every packet before esp_vhci_host_send_packet is reached. Creating and
 *   giving the semaphore lets commands flow into our send_packet shim, where
 *   the JS virtual controller answers them (fully observable HCI).
 * (xSemaphoreCreateBinary/Give are macros -> resolve xQueueGenericCreate/
 * xQueueGenericSend; binary semaphore == create(1, 0, 3).)
 * Falls back to reporting success without the semaphore if any symbol is
 * missing (degraded: silent BLE, same as the old stub).
 */
function initWithSem(createAddr, sendAddr, semAddr) {
    return asm32(assemble([
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: A0, rs1: 0, imm: 1 },
        { op: 'addi', rd: A1, rs1: 0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 3 },  // queueQUEUE_TYPE_BINARY_SEMAPHORE
        ...li(T0, createAddr),
        { op: 'jalr_ra', rs1: T0 },              // a0 = xQueueGenericCreate(1, 0, 3)
        { op: 'beq', rs1: A0, rs2: 0, label: 'init_done' },
        ...li(T1, semAddr),
        { op: 'sw', rs2: A0, rs1: T1, imm: 0 },  // *vhci_send_sem = handle
        { op: 'addi', rd: A1, rs1: 0, imm: 0 },
        { op: 'addi', rd: A2, rs1: 0, imm: 0 },
        { op: 'addi', rd: A3, rs1: 0, imm: 0 },
        ...li(T0, sendAddr),
        { op: 'jalr_ra', rs1: T0 },              // xQueueGenericSend(handle, 0, 0, 0)
        { label: 'init_done' },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },  // return ESP_OK
        { op: 'ret' },
    ]));
}

/**
 * Build BLE shims + out-of-line writes for a given chip.
 * @param {object} elf - Elf32 instance (for symbol resolution + dead-init body addr)
 * @param {string} chip
 * @returns {{ shims: Record<string,Uint8Array>, extra: Array<{addr:number,bytes:Uint8Array}> }}
 */
export function prepareBleShims(elf, chip) {
    const uartHi = UART_HI[chip] ?? UART_HI.esp32c3;
    let scratch = BLE_SCRATCH[chip] ?? BLE_SCRATCH.esp32c3;
    const names = [
        'esp_bt_controller_init', 'esp_bt_controller_enable',
        'esp_vhci_host_check_send_available', 'esp_vhci_host_register_callback',
        'esp_vhci_host_send_packet',
        // The NimBLE transport (ble_hci_trans_hs_cmd_tx) calls the esp_
        // entry; direct callers (BLETest) use either entry. Both are
        // patched to share one out-of-line body.
        'API_vhci_host_send_packet', 'API_vhci_host_check_send_available',
        // Created+given by our init replacement so the transport's semaphore
        // take succeeds and packets reach the send_packet shim.
        'xQueueGenericCreate', 'xQueueGenericSend', 'vhci_send_sem',
        // ESP-NimBLE-controller scan-dup-filter config (C6/H2 LL images only).
        'ble_vhci_disc_duplicate_mode_disable', 'ble_vhci_disc_duplicate_mode_enable',
        'ble_vhci_disc_duplicate_set_max_cache_size', 'ble_vhci_disc_duplicate_set_period_refresh_time',
        'r_scan_duplicate_cache_refresh_cb', 'r_scan_duplicate_cache_refresh_timer_stop',
        'r_scan_duplicate_cache_refresh_timer_start', 'r_scan_duplicate_cache_refresh_set_time',
        'r_filter_duplicate_mode_enable', 'r_filter_duplicate_mode_config',
        'r_filter_duplicate_mode_disable', 'r_filter_duplicate_set_ring_list_max_num',
        'r_filter_duplicate_ad_type_config', 'r_filter_duplicate_data_base_init',
        // LL-transport images (C6/H2/C5 Arduino BLE): route HCI around the
        // ROM link layer (see llCmdPark).
        'r_ble_hci_trans_cfg_hs', 'ble_transport_to_ll_cmd_impl',
        'ble_transport_free', 'r_ble_ll_init', 'ble_transport_host_recv_cb',
        'ble_hs_hci_cmd_tx', 'ble_hs_hci_rx_evt', 'ble_hs_hci_sem',
        'r_ble_controller_init',
        'esp_ble_register_bb_funcs', 'r_ble_controller_init',
        'r_sdkconfig_get_opts', 'r_esp_ble_msys_init', 'ble_transport_alloc_cmd',
        'r_ble_ll_set_public_addr', 'ble_transport_to_ll_acl_impl',
        'ble_console_inject',
        'ble_emu_scratch', 'r_os_mbuf_free_chain',
        'ble_hs_hci_ack',
    ];
    const { found } = elf.resolve(names);
    const byName = Object.fromEntries(found.map(s => [s.name, s]));
    // Prefer the sketch-provided linker-placed scratch: the fixed legacy
    // bases can sit inside firmware .dram0.data (C3: 0x3fc94000 is inside
    // .data — mirror/event writes then smash live globals once the layout
    // shifts) or in the heap's path. Same relative layout, just relocated.
    // Soft: fall back to the legacy base.
    const emuScratch = byName['ble_emu_scratch'];
    if (emuScratch && emuScratch.size >= 0x300) {
        scratch = emuScratch.addr >>> 0;
    }
    const shims = {};
    const extra = [];

    if (byName['esp_bt_controller_init']) {
        const initAddr = byName['esp_bt_controller_init'].addr;
        const initSize = byName['esp_bt_controller_init'].size;
        const give = (byName['xQueueGenericSend'] && byName['vhci_send_sem']) ?
            { sendAddr: byName['xQueueGenericSend'].addr, semAddr: byName['vhci_send_sem'].addr } : null;
        const big = sendPacket(scratch, uartHi, give);
        // Park the out-of-line body AFTER the init replacement itself: the
        // init shim (up to 96B) lives at initAddr, so the body must not start
        // at +16 anymore (an 88B init shim would overlap and corrupt both).
        const RESERVED = 96;
        const shimAddr = initAddr + RESERVED;
        const bodyFits = shimAddr + big.length <= initAddr + initSize;
        // Both send_packet entry points share one out-of-line body.
        for (const entry of ['esp_vhci_host_send_packet', 'API_vhci_host_send_packet']) {
            if (!byName[entry]) continue;
            const size = byName[entry].size;
            if (big.length <= size) {
                shims[entry] = big;
            } else if (bodyFits && size >= makeTrampoline(shimAddr).length) {
                shims[entry] = makeTrampoline(shimAddr);
                if (!extra.length) extra.push({ addr: shimAddr, bytes: big });
            }
        }
        shims['esp_bt_controller_init'] = stubReturn(0);
        if (byName['xQueueGenericCreate'] && byName['xQueueGenericSend'] && byName['vhci_send_sem']) {
            const initShim = initWithSem(
                byName['xQueueGenericCreate'].addr,
                byName['xQueueGenericSend'].addr,
                byName['vhci_send_sem'].addr);
            // The out-of-line send_packet body starts at +RESERVED: the init
            // replacement must fit before it or both get corrupted.
            if (initShim.length <= RESERVED && initShim.length <= initSize) {
                shims['esp_bt_controller_init'] = initShim;
            } else {
                console.warn('[ble] init shim too large, keeping success stub (BLE will be silent)');
            }
        }
        shims['esp_bt_controller_enable'] = stubReturn(0);
        shims['esp_vhci_host_check_send_available'] = stubReturn(1);
        shims['esp_vhci_host_register_callback'] = registerCb(scratch);
        // Test-only inbound injection (VHCI images, e.g. C3): patch the
        // sketch-global ble_console_inject stub into a JAL to a parked body
        // that copies [type][flat] into the VHCI mirror slot and invokes the
        // registered host receive callback. LL images handle this separately
        // (j to recv_cb); skip here when the LL receive path exists (C3
        // carries the LL symbols dead — gate on recv_cb, not cmd_impl).
        // Soft: skip if symbols/shapes/ranges differ.
        const injFn = byName['ble_console_inject'];
        if (injFn && byName['esp_vhci_host_send_packet'] && !byName['ble_transport_host_recv_cb']) {
            const injBody = vhciInjectPark({ scratch });
            const injAt = extra.length ? shimAddr + big.length : shimAddr;
            const injJal = injAt - injFn.addr;
            if (injFn.size >= 4 && injAt + injBody.length <= initAddr + initSize &&
                injJal >= -(1 << 20) && injJal < (1 << 20)) {
                const ijw = ((((injJal >> 20) & 1) << 31) | (((injJal >> 1) & 0x3ff) << 21) |
                    (((injJal >> 11) & 1) << 20) | (((injJal >> 12) & 0xff) << 12)) | 0x6f;
                const ij = new Uint8Array(4);
                new DataView(ij.buffer).setUint32(0, ijw >>> 0, true);
                extra.push({ addr: injFn.addr, bytes: ij });
                extra.push({ addr: injAt, bytes: injBody });
            } else {
                console.warn('[ble] VHCI console-inject skipped (size/range/fit)');
            }
        }
        // ESP-NimBLE-controller images (C6/H2: LL transport, no VHCI send
        // symbols): stub the scan-duplicate-filter config calls. The real
        // ones dereference LL env structs that only exist after radio init
        // (which we skip), faulting in r_filter_duplicate_mode_disable.
        // Filter config is irrelevant to a virtual controller. Scoped to
        // non-VHCI images so C3 keeps its real functions. The r_ ROM family
        // (same story, reached via ble_controller_scan_duplicate_config)
        // is stubbed too.
        if (!byName['esp_vhci_host_send_packet'] && !byName['API_vhci_host_send_packet']) {
            for (const n of ['ble_vhci_disc_duplicate_mode_disable', 'ble_vhci_disc_duplicate_mode_enable', 'ble_vhci_disc_duplicate_set_max_cache_size', 'ble_vhci_disc_duplicate_set_period_refresh_time', 'r_scan_duplicate_cache_refresh_cb', 'r_scan_duplicate_cache_refresh_timer_stop', 'r_scan_duplicate_cache_refresh_timer_start', 'r_scan_duplicate_cache_refresh_set_time', 'r_filter_duplicate_mode_enable', 'r_filter_duplicate_mode_config', 'r_filter_duplicate_mode_disable', 'r_filter_duplicate_set_ring_list_max_num', 'r_filter_duplicate_ad_type_config', 'r_filter_duplicate_data_base_init']) {
                if (byName[n]) shims[n] = stubReturn(0);
            }
        }
        if (byName['API_vhci_host_check_send_available']) {
            shims['API_vhci_host_check_send_available'] = stubReturn(1);
        }

        // LL-transport images (no VHCI symbols at all): route HCI around the
        // ROM link layer. r_ble_hci_trans_cfg_hs only stores callbacks into
        // the (radio-less, NULL) LL env struct -> pure success stub.
        // Radio-touching inits are stubbed whole (their exact register
        // pokes are unknowable; host-side init runs REAL): modem clocks,
        // PHY modem, coex, baseband funcs, and the ROM controller init.
        // ble_transport_to_ll_cmd_impl (li a1,0 + j na_...) -> JAL into the
        // parked llCmdPark body (flat cmd in a0). ble_transport_free -> ret
        // (protects our stack event buffer from the ROM mbuf free at the end
        // of ble_hs_hci_cmd_tx). The body parks in dead r_ble_ll_init space
        // (its only caller is the skipped controller init, so it never runs).
        const llNames = ['r_ble_hci_trans_cfg_hs', 'ble_transport_to_ll_cmd_impl',
            'ble_transport_free', 'r_ble_ll_init', 'ble_transport_host_recv_cb',
            'ble_hs_hci_cmd_tx', 'ble_hs_hci_rx_evt', 'ble_hs_hci_sem',
            'esp_bt_controller_init',
            'esp_ble_register_bb_funcs', 'r_ble_controller_init',
            'r_sdkconfig_get_opts', 'r_esp_ble_msys_init', 'ble_transport_alloc_cmd'];
        // Radio-touching callees stubbed whole (esp_phy_modem_init and
        // coex_core_init are already ret/li-a0-0 stubs in these builds).
        const radioSkips = ['esp_ble_register_bb_funcs', 'r_ble_controller_init',
            'r_ble_ll_set_public_addr'];
        const hasVhci = byName['esp_vhci_host_send_packet'] || byName['API_vhci_host_send_packet'];
        if (!hasVhci && llNames.every((n) => byName[n])) {
            // Drop the blanket controller-init stub: host-side init runs
            // REAL here; radio callees are stubbed individually below.
            delete shims['esp_bt_controller_init'];
            const cfg = byName['r_ble_hci_trans_cfg_hs'];
            const redirect = byName['ble_transport_to_ll_cmd_impl'];
            const freeFn = byName['ble_transport_free'];
            const semAddr = byName['ble_hs_hci_sem'].addr;
            const parkBase = byName['r_ble_ll_init'].addr + 16;
            // Verify the redirect site still has the expected shape
            // (li a1,0 (0x4581) + j (opcode 0x6f)) before overwriting, and
            // that ble_transport_free starts with a jump we can ret over.
            const dv = new DataView(elf.buf.buffer, elf.buf.byteOffset);
            const at = (vaddr) => {
                const off = elf.vaddrToFileOffset(vaddr);
                return off === null ? null : dv.getUint32(off, true);
            };
            const shapeOk = ((at(redirect.addr) >>> 0) & 0xffff) === 0x4581 &&
                ((at(freeFn.addr) >>> 0) & 0x7f) === 0x6f;
            // Radio-touching callees are stubbed whole (li a0,0 + ret needs
            // 8B; every call site feeds a bnez-a0 error check, and skipping
            // at the callee covers all callers on every chip build).
            const radioSkipped = [];
            for (const n of radioSkips) {
                if (byName[n].size >= 8) {
                    shims[n] = makeRet0();
                    radioSkipped.push(n);
                }
            }
            // Neuter the two ble_hs_hci_sem takes (pre-send in cmd_tx,
            // ack-side in rx_evt): these are NPL sem_pend calls returning an
            // error code (0 = success), and with no radio nothing ever gives
            // the sem, so the first takes would fail/timeout. Patched to
            // li a0,0 (fabricated success); the ack-wait take stays real and
            // is satisfied by rx_evt's genuine give on each delivered event.
            const takes = [
                ...findSemTakes(elf, byName['ble_hs_hci_cmd_tx'].addr, byName['ble_hs_hci_cmd_tx'].size, semAddr),
                ...findSemTakes(elf, byName['ble_hs_hci_rx_evt'].addr, byName['ble_hs_hci_rx_evt'].size, semAddr),
            ];
            const cellBase = I2C_CELL_BASE[chip] ?? I2C_CELL_BASE.esp32c3;
            const uartFull = (UART_HI[chip] ?? UART_HI.esp32c3) << 12;
            // Prefer the sketch-provided scratch (linker-placed, heap-safe)
            // over the fixed legacy base: fixed RAM collides with the
            // firmware heap once .bss grows (observed: +192B .bss stalled
            // init after AdvEnable #1). Layout from bleBase mirrors the
            // legacy one (mirror +0x400, fake config +0x600, cmd slot +0x800
            // .. +0x908), so bleBase = scratch - 0x400. Soft: fall back.
            let bleBase = cellBase;
            const emuScratch = byName['ble_emu_scratch'];
            if (emuScratch && emuScratch.size >= 0x508) {
                bleBase = (emuScratch.addr - 0x400) >>> 0;
            }
            const body = llCmdPark({ cellBase: bleBase, uartFull, recvAddr: byName['ble_transport_host_recv_cb'].addr });
            const jalOff = parkBase - redirect.addr;
            const cjOk = takes.every((t) => {
                const d = t.target - t.at;
                return d >= -2048 && d <= 2046 && (d & 1) === 0;
            });
            if (shapeOk && takes.length === 2 && cjOk && radioSkipped.length === radioSkips.length &&
                cfg.size >= 8 && redirect.size >= 6 && freeFn.size >= 4 &&
                parkBase + body.length <= byName['r_ble_ll_init'].addr + byName['r_ble_ll_init'].size &&
                jalOff >= -(1 << 20) && jalOff < (1 << 20)) {
                shims['r_ble_hci_trans_cfg_hs'] = makeRet0();
                shims['ble_transport_free'] = makeRetNop();
                // r_sdkconfig_get_opts reads the config struct out of the
                // (never allocated, radio-side) LL env -> point it at 256
                // pristine-zero bytes instead (feature defaults). Soft: skip
                // with a warning if the shape differs.
                if (byName['r_sdkconfig_get_opts'] && byName['r_sdkconfig_get_opts'].size >= 10) {
                    const go = byName['r_sdkconfig_get_opts'];
                    const fake = (bleBase + 0x600) >>> 0;
                    const hi = ((fake + 0x800) >> 12) & 0xfffff;
                    const lo = fake - (hi << 12);
                    if (lo >= -2048 && lo < 2048) {
                        // lui a0,HI; addi a0,a0,LO; c.ret (10B exact fit).
                        const blob = new Uint8Array(10);
                        const bdv = new DataView(blob.buffer);
                        bdv.setUint32(0, (((hi << 12) | (10 << 7) | 0x37) >>> 0), true);
                        bdv.setUint32(4, ((((lo & 0xfff) << 20) | (10 << 15) | (10 << 7) | 0x13) >>> 0), true);
                        bdv.setUint16(8, 0x8082, true); // c.ret
                        extra.push({ addr: go.addr, bytes: blob });
                    } else {
                        console.warn('[ble] fake config addr not lui+addi-able, skipping');
                    }
                }
                // r_esp_ble_msys_init sets up ROM mbuf pools (radio-side
                // state); with no radio it can only fault -> success stub.
                // (Verified: it faults in r_ble_ll_mem_low_prio_src_set on
                // the never-allocated LL env. Inbound mbufs are handled by
                // initializing just the host pool; see msysPoolInit below.)
                // The HCI command buffer comes from our static slot below.
                if (byName['r_esp_ble_msys_init'] && byName['r_esp_ble_msys_init'].size >= 8) {
                    shims['r_esp_ble_msys_init'] = makeRet0();
                }
                // ble_transport_alloc_cmd (ROM mbuf alloc) -> static 264B
                // slot via a parked body (the 6B trampoline fits jal+nop).
                // The host sends one command at a time and rewrites it fully
                // before use. Soft: skip if shapes differ.
                const allocFn = byName['ble_transport_alloc_cmd'];
                const allocOff = elf.vaddrToFileOffset(allocFn.addr);
                const allocIsTramp = allocOff !== null && allocFn.size >= 6;
                const staticBody = allocCmdStatic(bleBase + 0x800);
                const staticAt = parkBase + body.length;
                const allocJal = staticAt - allocFn.addr;
                if (byName['ble_transport_alloc_cmd'] && allocIsTramp &&
                    staticAt + staticBody.length <= byName['r_ble_ll_init'].addr + byName['r_ble_ll_init'].size &&
                    allocJal >= -(1 << 20) && allocJal < (1 << 20)) {
                    const ajw = ((((allocJal >> 20) & 1) << 31) | (((allocJal >> 1) & 0x3ff) << 21) |
                        (((allocJal >> 11) & 1) << 20) | (((allocJal >> 12) & 0xff) << 12)) | 0x6f;
                    const aj = new Uint8Array(6);
                    new DataView(aj.buffer).setUint32(0, ajw >>> 0, true);
                    aj[4] = 0x01; aj[5] = 0x00; // c.nop
                    extra.push({ addr: allocFn.addr, bytes: aj });
                    extra.push({ addr: staticAt, bytes: staticBody });
                }
                // Host->controller ACL (notifications): redirect
                // ble_transport_to_ll_acl_impl (same 6B li+j shape) into a
                // parked hex printer (console text for tests) that releases
                // the chain afterwards. Soft: skip if any symbol or the
                // shape differs.
                const aclFn = byName['ble_transport_to_ll_acl_impl'];
                const freeFn = byName['r_os_mbuf_free_chain'];
                if (aclFn && freeFn) {
                    const aclOff = elf.vaddrToFileOffset(aclFn.addr);
                    const aclShape = aclOff !== null && aclFn.size >= 6 &&
                        dv.getUint16(aclOff, true) === 0x4581;
                    const aclBody = llAclPrint({ uartFull, freeAddr: freeFn.addr });
                    const aclAt = staticAt + staticBody.length;
                    const aclJal = aclAt - aclFn.addr;
                    if (aclShape && aclAt + aclBody.length <=
                        byName['r_ble_ll_init'].addr + byName['r_ble_ll_init'].size &&
                        aclJal >= -(1 << 20) && aclJal < (1 << 20)) {
                        const aqw = ((((aclJal >> 20) & 1) << 31) | (((aclJal >> 1) & 0x3ff) << 21) |
                            (((aclJal >> 11) & 1) << 20) | (((aclJal >> 12) & 0xff) << 12)) | 0x6f;
                        const aq = new Uint8Array(6);
                        new DataView(aq.buffer).setUint32(0, aqw >>> 0, true);
                        aq[4] = 0x01; aq[5] = 0x00; // c.nop
                        extra.push({ addr: aclFn.addr, bytes: aq });
                        extra.push({ addr: aclAt, bytes: aclBody });
                    } else {
                        console.warn('[ble] LL ACL redirect skipped (shape/fit)');
                    }
                }
                // Test-only inbound injection: patch the sketch's global
                // ble_console_inject stub (4B+) into `j recv_cb`, tail-calling
                // the NimBLE host receive path (a local symbol the sketch
                // cannot reference). Soft: skip if either end is missing or
                // out of j range.
                const recvFn = byName['ble_transport_host_recv_cb'];
                const injFn = byName['ble_console_inject'];
                if (recvFn && injFn) {
                    const jOff = recvFn.addr - injFn.addr;
                    if (injFn.size >= 4 && jOff >= -(1 << 20) && jOff < (1 << 20)) {
                        const ijw = ((((jOff >> 20) & 1) << 31) | (((jOff >> 1) & 0x3ff) << 21) |
                            (((jOff >> 11) & 1) << 20) | (((jOff >> 12) & 0xff) << 12)) | 0x6f;
                        const ij = new Uint8Array(4);
                        new DataView(ij.buffer).setUint32(0, ijw >>> 0, true);
                        extra.push({ addr: injFn.addr, bytes: ij });
                    } else {
                        console.warn('[ble] console-inject redirect skipped (size/range)');
                    }
                }
                const jw = ((((jalOff >> 20) & 1) << 31) | (((jalOff >> 1) & 0x3ff) << 21) |
                    (((jalOff >> 11) & 1) << 20) | (((jalOff >> 12) & 0xff) << 12)) | 0x6f;
                const redir = new Uint8Array(6);
                new DataView(redir.buffer).setUint32(0, jw >>> 0, true);
                redir[4] = 0x01; redir[5] = 0x00; // c.nop
                extra.push({ addr: redirect.addr, bytes: redir });
                extra.push({ addr: parkBase, bytes: body });
                // C.J straight to each take's success path (+ c.nop pad).
                for (const t of takes) {
                    const off = t.target - t.at;
                    const cj = (0xa000 | 0x1 |
                        (((off >> 11) & 1) << 12) | (((off >> 4) & 1) << 11) |
                        (((off >> 8) & 3) << 9) | (((off >> 10) & 1) << 8) |
                        (((off >> 6) & 1) << 7) | (((off >> 7) & 1) << 6) |
                        (((off >> 1) & 7) << 3) | (((off >> 5) & 1) << 2)) >>> 0;
                    const patch = new Uint8Array(4);
                    new DataView(patch.buffer).setUint16(0, cj & 0xffff, true);
                    patch[2] = 0x01; patch[3] = 0x00; // c.nop
                    extra.push({ addr: t.at, bytes: patch });
                }
            } else {
                console.warn(`[ble] LL redirect skipped (shape=${shapeOk} takes=${takes.length} radio=${radioSkipped.length}), BLE will be silent`);
            }
        }
    }
    return { shims, extra, hooks: found };
}

/**
 * Static-buffer replacement for ble_transport_alloc_cmd (ROM mbuf alloc
 * needs ROM pools that only exist after radio init). The NimBLE host sends
 * one command at a time and always rewrites the buffer fully before use,
 * so a single static 264B slot (max HCI cmd: 3+255) is safe. Returns the
 * slot address in a0.
 */
function allocCmdStatic(scratch) {
    return asm32(assemble([
        ...li(A0, scratch),
        { op: 'ret' },
    ]));
}

function makeRet0() {
    return asm32(assemble([{ op: 'addi', rd: A0, rs1: 0, imm: 0 }, { op: 'ret' }]));
}

function makeRetNop() {
    // c.ret (2B) + c.nop (2B): 4B total for tiny trampoline bodies.
    return new Uint8Array([0x82, 0x80, 0x01, 0x00]);
}

/**
 * Parked host->controller ACL printer (a0 = os_mbuf chain, possibly
 * multi-block: the ATT/L2CAP response builder prepends headers as separate
 * mbufs, so a flat read prints adjacent-heap garbage). Walks om_data/om_len
 * via om_next, emitting `acl-tx <hex, capped at 64 bytes>\n` to the UART
 * console for tests. Uses t0-t4/a0-a2 only (caller-saved); preserves ra+sp.
 * mbuf layout: om_data@0, om_len@6 (u16 LE), om_next@12.
 *
 * After printing, the chain is released via r_os_mbuf_free_chain (the real
 * controller consumes+frees TX buffers; without this each ATT response
 * leaks pool blocks until injection allocs start failing).
 */
function llAclPrint({ uartFull, freeAddr }) {
    const p = [
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'lui', rd: T0, imm: uartFull },
        { op: 'addi', rd: T2, rs1: 0, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 99 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 108 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 45 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 116 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 120 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 32 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // T1 = mbuf budget (4 blocks max, guards against corrupt chains);
        // T4 = per-block byte cap (64). A1 = current mbuf (a0).
        { op: 'addi', rd: T1, rs1: 0, imm: 4 },
        { op: 'addi', rd: T4, rs1: 0, imm: 64 },
        { op: 'addi', rd: A1, rs1: A0, imm: 0 },
        { label: 'acl_mbuf' },
        { op: 'beq', rs1: A1, rs2: 0, label: 'acl_done' },
        { op: 'beq', rs1: T1, rs2: 0, label: 'acl_done' },
        { op: 'addi', rd: T1, rs1: T1, imm: -1 },
        // A2 = cursor = lw[A1+0]; T3 = min(len, 64).
        { op: 'lw', rd: A2, rs1: A1, imm: 0 },
        { op: 'lbu', rd: T3, rs1: A1, imm: 6 },
        { op: 'lbu', rd: T2, rs1: A1, imm: 7 },
        { op: 'slli', rd: T2, rs1: T2, sh: 8 },
        { op: 'or', rd: T3, rs1: T3, rs2: T2 },
        { op: 'bge', rs1: T3, rs2: T4, label: 'acl_capblk' },
        { op: 'jal', rd: 0, label: 'acl_nocapblk' },
        { label: 'acl_capblk' },
        { op: 'addi', rd: T3, rs1: T4, imm: 0 },
        { label: 'acl_nocapblk' },
        { label: 'acl_loop' },
        { op: 'beq', rs1: T3, rs2: 0, label: 'acl_next' },
        { op: 'lbu', rd: T2, rs1: A2, imm: 0 },
        { op: 'srli', rd: T2, rs1: T2, sh: 4 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'lbu', rd: T2, rs1: A2, imm: 0 },
        { op: 'andi', rd: T2, rs1: T2, imm: 15 }, { op: 'addi', rd: T2, rs1: T2, imm: 97 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 32 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: A2, rs1: A2, imm: 1 },
        { op: 'addi', rd: T3, rs1: T3, imm: -1 },
        { op: 'jal', rd: 0, label: 'acl_loop' },
        { label: 'acl_next' },
        { op: 'lw', rd: A1, rs1: A1, imm: 12 },
        { op: 'jal', rd: 0, label: 'acl_mbuf' },
        { label: 'acl_done' },
        { op: 'addi', rd: T2, rs1: 0, imm: 10 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        // Release the chain (a0 still holds the head: only A1/A2/T1-T4
        // were clobbered above).
        ...li(T2, freeAddr),
        { op: 'jalr_ra', rs1: T2 },
        { op: 'lw', rd: 1, rs1: SP, imm: 12 },
        { op: 'addi', rd: SP, rs1: SP, imm: 16 },
        { op: 'addi', rd: A0, rs1: 0, imm: 0 },
        { op: 'ret' },
    ];
    return asm32(assemble(p));
}

/**
 * Find `take(sem)` call sites to neuter: scan a function body for a C.JALR
 * preceded (within 14B) by `addi r,r,LOW12(semAddr)`, with a C.BEQZ/C.BNEZ
 * on a0 right after. Returns [{at, target}] where target is the branch
 * destination (the success path: takes return an NPL error code with
 * 0 == success). Patches replace [jalr+branch] (4B) with C.J to target —
 * a plain li-a0-0 would WRONGLY fall into the fail block (learned the hard
 * way: every command failed).
 */
function findSemTakes(elf, fnAddr, fnSize, semAddr) {
    const dv = new DataView(elf.buf.buffer, elf.buf.byteOffset);
    const at = (vaddr) => {
        const off = elf.vaddrToFileOffset(vaddr);
        return off === null ? null : dv.getUint16(off, true);
    };
    const LOW = semAddr & 0xfff;
    const hits = [];
    for (let o = 0; o + 2 <= fnSize; o += 2) {
        const hw = at(fnAddr + o);
        if (hw === null) break;
        if ((hw & 0xf07f) !== 0x9002) continue; // C.JALR
        let anchored = false;
        for (let back = 2; back <= 14 && o - back >= 0; back += 2) {
            // I-type addi with imm12 == LOW (any regs AND any halfword
            // alignment: the addi may sit at 2-mod-4, read as two halves).
            const woff = fnAddr + o - back;
            const w = at(woff);
            if (w === null) continue;
            const word = w | (at(woff + 2) << 16);
            if ((word & 0x7f) === 0x13 && ((word >>> 20) & 0xfff) === LOW) { anchored = true; break; }
        }
        if (!anchored) continue;
        const after = at(fnAddr + o + 2);
        // C.BEQZ/C.BNEZ on a0 (funct3 110/111, op 01, rs1' == 010 for a0,
        // since compressed regs map 000->s0 ... 010->a0 ... 111->a5).
        // Decode its destination: C.B off[8|4:3] from bits[12:10],
        // off[7:6|2:1|5] from bits[6:2].
        const br = after === null ? -1 : (after & 0xe003);
        if ((br === 0xc001 || br === 0xe003) && ((after >>> 7) & 0x7) === 2) {
            let off = (((after >> 12) & 1) << 8) | (((after >> 10) & 3) << 3) |
                (((after >> 5) & 3) << 6) | (((after >> 3) & 3) << 1) | (((after >> 2) & 1) << 5);
            if (off & 0x100) off -= 0x200;
            hits.push({ at: fnAddr + o, target: (fnAddr + o + 2 + off) >>> 0 });
        }
    }
    return hits;
}
