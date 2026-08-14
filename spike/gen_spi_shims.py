#!/usr/bin/env python3
"""Generate RISC-V SPI shims for Arduino ESP32 HAL (AGENT.md Phase 4).

Wire protocol (ANSI APC):
  ESC _ 'S' 'B' <nibble1> <nibble0> ESC \\
      Single-byte transfer (spiTransferByte, spiTransferByteNL).
      Emits data byte, blocks polling UART0 RX FIFO for 1 byte reply, returns in a0.

  ESC _ 'S' 'W' <len low7> <payload nibbles...> ESC \\
      Block write (spiWriteNL). Fire-and-forget streaming.

  ESC _ 'S' 'X' <len low7> <payload nibbles...> ESC \\
      Full-duplex block transfer (spiTransferBytesNL).
      Streams payload, blocks polling UART0 RX FIFO for len bytes into *out.

  spiTransaction / spiStartBus / spiStopBus -> no-op (li a0, 0 / ret).
"""
import struct
import sys
from mkimg import (li, addi, andi, srli, sw, sb, lw, lbu, beq, bne, jal,
                    UART0_FIFO, UART0_STATUS)

ESC, APC_START, APC_END = 27, ord('_'), ord('\\')

T0, T1, T2, T3, T4 = 5, 6, 7, 28, 29
A0, A1, A2, A3, A4, A5 = 10, 11, 12, 13, 14, 15

def _ret():
    return 1 << 15 | 0x67  # jalr x0, x1, 0

def _emit_const(ch):
    return [addi(T2, 0, ch), sw(T2, T0, 0)]

def _emit_reg_low7(reg):
    return [andi(T2, reg, 0x7F), sw(T2, T0, 0)]

def _emit_nibbles(reg):
    return [
        srli(T3, reg, 4), andi(T3, T3, 15), addi(T3, T3, 97), sw(T3, T0, 0),
        andi(T3, reg, 15), addi(T3, T3, 97), sw(T3, T0, 0)
    ]

def shim_noop():
    """No-op return ESP_OK (0)."""
    return [addi(A0, 0, 0), _ret()]

def shim_spi_transfer_byte():
    """uint8_t spiTransferByte(spi_t *spi, uint8_t data) -> reply byte in a0."""
    # a0 = spi, a1 = data
    p = list(li(T0, UART0_FIFO)) + list(li(T1, UART0_STATUS))
    for ch in (ESC, APC_START, ord('S'), ord('B')):
        p += _emit_const(ch)
    p += _emit_nibbles(A1)
    for ch in (ESC, APC_END):
        p += _emit_const(ch)

    # Poll RX FIFO for 1 byte reply
    p += [lw(T2, T1, 0), andi(T2, T2, 0xFF)]  # poll RXFIFO_CNT
    p += [beq(T2, 0, -4 * 2)]                 # spin until nonzero
    p += [lw(A0, T0, 0), andi(A0, A0, 0xFF)]  # pop FIFO -> a0
    p += [_ret()]
    return p

def shim_spi_write_nl():
    """void spiWriteNL(spi_t *spi, const uint8_t *data, uint32_t size)"""
    # a0 = spi, a1 = data, a2 = size
    p = list(li(T0, UART0_FIFO))
    for ch in (ESC, APC_START, ord('S'), ord('W')):
        p += _emit_const(ch)
    p += _emit_reg_low7(A2)  # size (low 7 bits)

    # Loop over data bytes
    loop_head = len(p)
    p += [0]  # placeholder: beq a2, zero, done
    body = [lbu(T2, A1, 0)] + _emit_nibbles(T2)
    body += [addi(A1, A1, 1), addi(A2, A2, -1)]
    body += [jal(0, -4 * (len(body) + 1))]
    p[loop_head] = beq(A2, 0, 4 * (len(body) + 1))
    p += body

    for ch in (ESC, APC_END):
        p += _emit_const(ch)
    p += [_ret()]
    return p

def shim_spi_transfer_bytes_nl():
    """void spiTransferBytesNL(spi_t *spi, const uint8_t *data, uint8_t *out, uint32_t size)"""
    # a0 = spi, a1 = data, a2 = out, a3 = size
    p = list(li(T0, UART0_FIFO)) + list(li(T1, UART0_STATUS))
    for ch in (ESC, APC_START, ord('S'), ord('X')):
        p += _emit_const(ch)
    p += _emit_reg_low7(A3)  # size
    p += [addi(T4, A3, 0)]   # stash size for RX loop

    # TX Loop: if data pointer is null, emit dummy 0x00 bytes
    tx_loop = len(p)
    p += [0]  # placeholder: beq a3, zero, end_tx
    tx_body = []
    tx_body += [beq(A1, 0, 8), lbu(T2, A1, 0), jal(0, 8), addi(T2, 0, 0)]
    tx_body += _emit_nibbles(T2)
    tx_body += [beq(A1, 0, 8), addi(A1, A1, 1)]
    tx_body += [addi(A3, A3, -1), jal(0, -4 * (len(tx_body) + 2))]
    p[tx_loop] = beq(A3, 0, 4 * (len(tx_body) + 1))
    p += tx_body

    for ch in (ESC, APC_END):
        p += _emit_const(ch)

    # RX Loop: if out pointer is null, drain FIFO to discard; else store to *out
    rx_loop = len(p)
    p += [0]  # placeholder: beq t4, zero, done
    rx_body = [lw(T2, T1, 0), andi(T2, T2, 0xFF)]  # poll RXFIFO_CNT
    rx_body += [beq(T2, 0, -4 * 2)]
    rx_body += [lw(T3, T0, 0)]
    rx_body += [beq(A2, 0, 8), sb(T3, A2, 0), addi(A2, A2, 1)]
    rx_body += [addi(T4, T4, -1), jal(0, -4 * (len(rx_body) + 1))]
    p[rx_loop] = beq(T4, 0, 4 * (len(rx_body) + 1))
    p += rx_body

    p += [_ret()]
    return p

if __name__ == '__main__':
    all_shims = {
        'spiTransferByte': shim_spi_transfer_byte(),
        'spiTransferByteNL': shim_spi_transfer_byte(),
        'spiWriteNL': shim_spi_write_nl(),
        'spiTransferBytesNL': shim_spi_transfer_bytes_nl(),
        'spiTransferBytes': shim_spi_transfer_bytes_nl(),
        'spiTransaction': shim_noop(),
        'spiStartBus': shim_noop(),
    }
    for name, words in all_shims.items():
        blob = b''.join(struct.pack('<I', w) for w in words)
        print(f'{name:20s}: {len(blob):3d} bytes ({len(words)} instructions)')
