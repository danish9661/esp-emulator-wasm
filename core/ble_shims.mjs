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

import { assemble, asm32, li, jalr, A0, A1, T0, T1, T2, T3, T4, T5, SP } from './rvasm.mjs';

// Per-chip DRAM scratch for runtime data (callback ptr + event buffer). Lives in the
// firmware's RAM; .bss is zeroed at boot but that is fine — the firmware writes cb
// and the event bytes here at runtime.
export const BLE_SCRATCH = {
    esp32c3: 0x3fc94000,
    esp32c6: 0x40814000,
    esp32h2: 0x40814000,
    esp32p4: 0x4ff44000,
};
const CB_OFF = 0;
const EVT_OFF = 0x100;

const UART_HI = { esp32c3: 0x60000, esp32c6: 0x60000, esp32h2: 0x60000, esp32p4: 0x500ca };

function stubReturn(value) {
    return asm32(assemble([{ op: 'addi', rd: A0, rs1: 0, imm: value }, { op: 'ret' }]));
}

function registerCb(scratch) {
    const cbAddr = scratch + CB_OFF;
    return asm32(assemble([
        ...li(T1, cbAddr),
        { op: 'sw', rs2: A0, rs1: T1, imm: 0 },
        { op: 'ret' },
    ]));
}

function sendPacket(scratch, uartHi) {
    const evtBase = scratch + EVT_OFF;
    const cbBase = scratch + CB_OFF;
    const p = [
        // prologue: save ra, a0 (pkt), a1 (len)
        { op: 'addi', rd: SP, rs1: SP, imm: -16 },
        { op: 'sw', rs2: 1, rs1: SP, imm: 12 },
        { op: 'sw', rs2: A0, rs1: SP, imm: 8 },
        { op: 'sw', rs2: A1, rs1: SP, imm: 4 },
        { op: 'lui', rd: T0, imm: uartHi << 12 },

        // ---- transmit ESC _ B ----
        { op: 'addi', rd: T2, rs1: 0, imm: 27 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 95 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },
        { op: 'addi', rd: T2, rs1: 0, imm: 66 }, { op: 'sw', rs2: T2, rs1: T0, imm: 0 },

        // ---- hex-encode command bytes ----
        { op: 'lw', rd: T3, rs1: SP, imm: 8 },   // t3 = pkt
        { op: 'lw', rd: T5, rs1: SP, imm: 4 },   // t5 = len
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

        // ---- receive ESC _ E <2hex len> <hex event> ESC \ ----
        ...li(T3, evtBase),                       // t3 = event buffer base

        { label: 'rx_esc' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_esc' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'bne', rs1: T1, rs2: 27, label: 'rx_esc' },
        { label: 'rx_und' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_und' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'bne', rs1: T1, rs2: 95, label: 'rx_esc' },
        { label: 'rx_E' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_E' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'bne', rs1: T1, rs2: 69, label: 'rx_esc' },

        // length: 2 hex chars
        { label: 'rx_lenhi' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_lenhi' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'addi', rd: T1, rs1: T1, imm: -97 }, { op: 'slli', rd: T4, rs1: T1, sh: 4 },
        { label: 'rx_lenlo' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_lenlo' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'addi', rd: T1, rs1: T1, imm: -97 }, { op: 'addi', rd: T4, rs1: T4, imm: T1 },
        { op: 'addi', rd: T5, rs1: 0, imm: 0 },  // index

        { label: 'rx_data' },
        { op: 'bge', rs1: T5, rs2: T4, label: 'rx_endesc' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_data' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'addi', rd: T1, rs1: T1, imm: -97 }, { op: 'slli', rd: T1, rs1: T1, sh: 4 },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_data' },
        { op: 'lbu', rd: T2, rs1: T0, imm: 0 }, { op: 'addi', rd: T2, rs1: T2, imm: -97 }, { op: 'or', rd: T1, rs1: T1, rs2: T2 },
        { op: 'sb', rs2: T1, rs1: T3, imm: 0 },
        { op: 'addi', rd: T3, rs1: T3, imm: 1 },
        { op: 'addi', rd: T5, rs1: T5, imm: 1 },
        { op: 'jal', rd: 0, label: 'rx_data' },

        { label: 'rx_endesc' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_endesc' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'bne', rs1: T1, rs2: 27, label: 'rx_endesc' },
        { op: 'lw', rd: T2, rs1: T0, imm: 0x1C }, { op: 'andi', rd: T2, rs1: T2, imm: 0xFF }, { op: 'beq', rs1: T2, rs2: 0, label: 'rx_endesc' },
        { op: 'lbu', rd: T1, rs1: T0, imm: 0 }, { op: 'bne', rs1: T1, rs2: 92, label: 'rx_endesc' },

        // call cb(event buffer)
        ...li(T1, cbBase),
        { op: 'lw', rd: T1, rs1: T1, imm: 0 },     // t1 = cb pointer
        ...li(A0, evtBase),                        // a0 = event buffer
        { op: 'jalr_ra', rs1: T1 },
        { label: 'after_cb' },

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
    ];
    const { found } = elf.resolve(names);
    const byName = Object.fromEntries(found.map(s => [s.name, s]));
    const shims = {};
    const extra = [];

    if (byName['esp_bt_controller_init']) {
        const initAddr = byName['esp_bt_controller_init'].addr;
        const initSize = byName['esp_bt_controller_init'].size;
        const big = sendPacket(scratch, uartHi);
        const shimAddr = initAddr + 16; // park inside dead init body
        if (byName['esp_vhci_host_send_packet']) {
            const spSize = byName['esp_vhci_host_send_packet'].size;
            if (big.length <= spSize) {
                // small enough to inline; otherwise trampoline into init body
                shims['esp_vhci_host_send_packet'] = big;
            } else if (shimAddr + big.length <= initAddr + initSize) {
                shims['esp_vhci_host_send_packet'] = makeTrampoline(shimAddr);
                extra.push({ addr: shimAddr, bytes: big });
            }
        }
        shims['esp_bt_controller_init'] = stubReturn(0);
        shims['esp_bt_controller_enable'] = stubReturn(0);
        shims['esp_vhci_host_check_send_available'] = stubReturn(1);
        shims['esp_vhci_host_register_callback'] = registerCb(scratch);
    }
    return { shims, extra, hooks: found };
}
