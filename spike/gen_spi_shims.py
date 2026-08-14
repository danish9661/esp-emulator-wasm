#!/usr/bin/env python3
"""Generate RISC-V SPI and I2C shims for Arduino ESP32 HAL (AGENT.md Phase 4)."""
import struct
import sys
from mkimg import (lui, addi, andi, srli, sw, sb, lw, lbu, beq, bne, jal,
                    UART0_FIFO, UART0_STATUS)
from shims import shim_i2cwrite, shim_i2cread

def _ret(): return 1 << 15 | 0x67
def shim_noop(): return [addi(10, 0, 0), _ret()]

def shim_spi_transfer_byte_88():
    p = []
    p += [lui(5, 0x60000)]                      # 1: t0 = 0x60000000
    p += [lui(7, 0x536), addi(7, 7, -0xE5)]     # 3: t2 = 0x535F1B ('\x1b_S')
    p += [andi(28, 7, 0xFF), sw(28, 5, 0), srli(7, 7, 8), bne(7, 0, -4 * 3)] # 7: emit 3 bytes
    p += [srli(28, 11, 4), addi(28, 28, 97), sw(28, 5, 0)]                   # 10: high nibble
    p += [andi(28, 11, 15), addi(28, 28, 97), sw(28, 5, 0)]                  # 13: low nibble
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]          # 17: emit '\x1b\\'
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF), beq(7, 0, -4 * 2)]                # 20: poll RXFIFO_CNT
    p += [lw(10, 5, 0), _ret()]                                               # 22: lw a0, 0(t0); ret
    return p

def _emit_const(ch): return [addi(7, 0, ch), sw(7, 5, 0)]
def _emit_reg_low7(reg): return [andi(7, reg, 0x7F), sw(7, 5, 0)]
def _emit_nibbles(reg):
    return [
        srli(28, reg, 4), andi(28, 28, 15), addi(28, 28, 97), sw(28, 5, 0),
        andi(28, reg, 15), addi(28, 28, 97), sw(28, 5, 0)
    ]

def shim_spi_write_nl():
    p = [lui(5, 0x60000)]
    for ch in (27, ord('_'), ord('S'), ord('W')): p += _emit_const(ch)
    p += _emit_reg_low7(12)  # a2 = size
    tx_head = len(p)
    p += [0]
    tx_body = [lbu(7, 11, 0)] + _emit_nibbles(7) + [addi(11, 11, 1), addi(12, 12, -1)]
    tx_body += [jal(0, -4 * (len(tx_body) + 1))]
    p[tx_head] = beq(12, 0, 4 * (len(tx_body) + 1))
    p += tx_body
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [_ret()]
    return p

def shim_spi_transfer_bytes_nl():
    p = [lui(5, 0x60000)]
    p += [lui(7, 0x58536), addi(7, 7, -0xE5)]
    p += [andi(28, 7, 0xFF), sw(28, 5, 0), srli(7, 7, 8), bne(7, 0, -4 * 3)]
    p += [andi(28, 13, 0x7F), sw(28, 5, 0)]    # a3 = size
    p += [addi(29, 13, 0)]                     # t4 = size for RX
    
    tx_head = len(p)
    p += [0]
    tx_body = []
    tx_body += [beq(11, 0, 8), lbu(7, 11, 0), jal(0, 8), addi(7, 0, 0)]
    tx_body += [srli(28, 7, 4), addi(28, 28, 97), sw(28, 5, 0)]
    tx_body += [andi(28, 7, 15), addi(28, 28, 97), sw(28, 5, 0)]
    tx_body += [beq(11, 0, 8), addi(11, 11, 1)]
    tx_body += [addi(13, 13, -1)]
    tx_body += [jal(0, -4 * (len(tx_body) + 1))]
    p[tx_head] = beq(13, 0, 4 * (len(tx_body) + 1))
    p += tx_body
    
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]
    
    rx_head = len(p)
    p += [0]
    rx_body = []
    rx_body += [lw(7, 5, 0x1C), andi(7, 7, 0xFF), beq(7, 0, -4 * 2)]
    rx_body += [lw(28, 5, 0)]
    rx_body += [beq(12, 0, 8), sb(28, 12, 0), addi(12, 12, 1)]
    rx_body += [addi(29, 29, -1)]
    rx_body += [jal(0, -4 * (len(rx_body) + 1))]
    p[rx_head] = beq(29, 0, 4 * (len(rx_body) + 1))
    p += rx_body
    
    p += [_ret()]
    return p

if __name__ == '__main__':
    all_shims = {
        'i2cWrite': shim_i2cwrite(),
        'i2cRead': shim_i2cread(),
        'spiTransferByte': shim_spi_transfer_byte_88(),
        'spiTransferByteNL': shim_spi_transfer_byte_88(),
        'spiWriteNL': shim_spi_write_nl(),
        'spiWritePixelsNL': shim_spi_write_nl(),
        'spiWriteByteNL': shim_spi_transfer_byte_88(),
        'spiWriteShortNL': shim_spi_transfer_byte_88(),
        'spiWriteLongNL': shim_spi_transfer_byte_88(),
        'spiTransferBytesNL': shim_spi_transfer_bytes_nl(),
        'spiTransferBytes': shim_spi_transfer_bytes_nl(),
        'spiTransaction': shim_noop(),
        'spiStartBus': shim_noop(),
        'spiStopBus': shim_noop(),
        'spiSetClockDivider': shim_noop(),
        'spiSetBitOrder': shim_noop(),
        'spiSetDataMode': shim_noop(),
    }
    out_lines = ['// Auto-generated RISC-V shims for esp-emu (I2C and SPI, AGENT.md Phase 4)', 'export const SHIMS = {']
    for name, words in all_shims.items():
        blob = b''.join(struct.pack('<I', w) for w in words)
        b_arr = ', '.join(str(b) for b in blob)
        out_lines.append(f'    {name}: new Uint8Array([{b_arr}]),')
        print(f'{name:20s}: {len(blob):3d} bytes')
    out_lines.append('};\n')
    open('shims.mjs', 'w').write('\n'.join(out_lines))
    print('shims.mjs generated!')
