#!/usr/bin/env python3
"""Generate the I2C shim blobs (AGENT.md Phase 3).

Frames use ANSI APC (ESC _ ... ESC \\), which terminals — xterm.js included —
discard silently, so protocol traffic never corrupts the user's serial console.

Frame layout:
    ESC _ 'W' <addr> <data nibbles...> ESC \\      write, fire-and-forget
    ESC _ 'R' <addr> <len>             ESC \\      read request; host replies with
                                                  <len> raw bytes via uart_input()

The address and length go out as raw bytes (both are <= 0x7F, so they survive the
UTF-8 decode of run_batch()'s return value). Payload bytes can be >= 0x80, so those
stay nibble-encoded as 'a'+nibble.

Both blobs are position-independent — the only absolute addresses are the UART0
FIFO and status registers — so a blob can be written over any copy of its function.
"""
import struct
import sys

from mkimg import (li, addi, andi, srli, sw, sb, lw, lbu, beq, jal,
                   UART0_FIFO, UART0_STATUS)

ESC, APC_START, APC_END = 27, ord('_'), ord('\\')

T0, T1, T2, T3, T4 = 5, 6, 7, 28, 29
A0, A1, A2, A3, A5 = 10, 11, 12, 13, 15


def _ret():
    return 1 << 15 | 0x67                      # jalr x0, x1, 0


def _emit_const(ch):
    return [addi(T2, 0, ch), sw(T2, T0, 0)]


def _emit_reg_low7(reg):
    return [andi(T2, reg, 0x7F), sw(T2, T0, 0)]


def shim_i2cwrite():
    """i2cWrite(num, address, buff, size, timeout) -> ESP_OK, payload emitted."""
    p = list(li(T0, UART0_FIFO))
    for ch in (ESC, APC_START, ord('W')):
        p += _emit_const(ch)
    p += _emit_reg_low7(A1)                    # device address

    loop = len(p)
    body = [lbu(T2, A2, 0)]
    for sh in (4, 0):                          # payload byte -> two printable chars
        body += [srli(T3, T2, sh), andi(T3, T3, 15), addi(T3, T3, 97), sw(T3, T0, 0)]
    body += [addi(A2, A2, 1), addi(A3, A3, -1)]
    body += [jal(0, -4 * (len(body) + 1))]
    p += [beq(A3, 0, 4 * (len(body) + 1))]
    p += body

    for ch in (ESC, APC_END):
        p += _emit_const(ch)
    p += [addi(A0, 0, 0), _ret()]
    return p


def shim_i2cread():
    """i2cRead(num, address, buff, size, timeout, readCount) -> ESP_OK, buff filled."""
    p = list(li(T0, UART0_FIFO)) + list(li(T1, UART0_STATUS))
    # Mask UART0 RX interrupts across the transaction: the Arduino Serial RX
    # ISR would otherwise steal host->firmware reply bytes mid-poll (esp-emu
    # >= 0.41 delivers UART RX interrupts promptly). A0 (bus num, unused by
    # the shim) holds the saved INT_ENA; restored before the final addi.
    p += [lw(A0, T0, 0x0C), sw(0, T0, 0x0C)]
    for ch in (ESC, APC_START, ord('R')):
        p += _emit_const(ch)
    p += _emit_reg_low7(A1)                    # device address
    p += _emit_reg_low7(A3)                    # requested length
    for ch in (ESC, APC_END):
        p += _emit_const(ch)
    p += [addi(T4, A3, 0)]                     # stash length for *readCount

    rxloop = len(p)
    p += [0]                                   # placeholder: beq a3,0,done
    p += [lw(T2, T1, 0), andi(T2, T2, 0xFF)]   # poll RXFIFO_CNT
    p += [beq(T2, 0, -4 * 2)]                  # spin until a byte lands
    p += [lw(T3, T0, 0), sb(T3, A2, 0)]        # pop FIFO -> *buff
    p += [addi(A2, A2, 1), addi(A3, A3, -1)]
    p += [jal(0, -4 * (len(p) - rxloop))]
    p[rxloop] = beq(A3, 0, 4 * (len(p) - rxloop))

    p += [sw(A0, T0, 0x0C)]                    # restore UART0 INT_ENA
    p += [beq(A5, 0, 8), sw(T4, A5, 0)]        # *readCount = length, if non-null
    p += [addi(A0, 0, 0), _ret()]
    return p


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'spike'
    for name, fn in (('i2cwrite', shim_i2cwrite), ('i2cread', shim_i2cread)):
        blob = b''.join(struct.pack('<I', w) for w in fn())
        path = f'{out}/shim_{name}.bin'
        open(path, 'wb').write(blob)
        print(f'{path}: {len(blob)} bytes')
