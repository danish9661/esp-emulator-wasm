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

import { assemble, asm32, li, jalr, A0, A1, A2, A3, T0, T1, T2, T3, T4, T5, SP } from './rvasm.mjs';

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

function makeTrampoline(targetAddr) {
    // lui T0, hi ; addi T0, T0, lo ; jalr x0, T0, 0
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
    const scratch = BLE_SCRATCH[chip] ?? BLE_SCRATCH.esp32c3;
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
    ];
    const { found } = elf.resolve(names);
    const byName = Object.fromEntries(found.map(s => [s.name, s]));
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
        if (byName['API_vhci_host_check_send_available']) {
            shims['API_vhci_host_check_send_available'] = stubReturn(1);
        }
    }
    return { shims, extra, hooks: found };
}
