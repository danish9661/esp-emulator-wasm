#!/usr/bin/env python3
"""Generate RISC-V SPI, I2C, and NeoPixel/RMT shims for Arduino ESP32 HAL (AGENT.md Phase 4 & Phase 5 SD Card)."""
import struct
import sys
from mkimg import (lui, addi, andi, srli, sw, sb, lw, lbu, beq, bne, jal,
                    UART0_FIFO, UART0_STATUS)
from shims import shim_i2cwrite, shim_i2cread

def slli(rd, rs1, shamt):
    return (shamt & 0x1F) << 20 | (rs1 & 0x1F) << 15 | 0x1 << 12 | (rd & 0x1F) << 7 | 0x13
def _ret(): return 1 << 15 | 0x67
def or_r(rd, rs1, rs2):
    return (rs2 & 0x1F) << 20 | (rs1 & 0x1F) << 15 | 0x6 << 12 | (rd & 0x1F) << 7 | 0x33
def sub_r(rd, rs1, rs2):
    return (0x20 << 25) | (rs2 & 0x1F) << 20 | (rs1 & 0x1F) << 15 | (0 << 12) | (rd & 0x1F) << 7 | 0x33

def shim_noop(): return [addi(10, 0, 0), _ret()]

def shim_spi_start_bus():
    # Return non-null dummy pointer 0x3FC90000 in a0
    return [lui(10, 0x3FC90), addi(10, 10, 0), _ret()]

def _emit_const(ch): return [addi(7, 0, ch), sw(7, 5, 0)]
def _emit_reg_low7(reg): return [andi(7, reg, 0x7F), sw(7, 5, 0)]
def _emit_nibbles(reg):
    return [
        srli(28, reg, 4), andi(28, 28, 15), addi(28, 28, 97), sw(28, 5, 0),
        andi(28, reg, 15), addi(28, 28, 97), sw(28, 5, 0)
    ]

def shim_spi_transfer_byte_88():
    p = []
    p += [lui(5, 0x60000)]
    p += [lui(7, 0x536), addi(7, 7, -0xE5)]     # '\x1b_S'
    p += [andi(28, 7, 0xFF), sw(28, 5, 0), srli(7, 7, 8), bne(7, 0, -4 * 3)]
    p += [srli(28, 11, 4), addi(28, 28, 97), sw(28, 5, 0)]
    p += [andi(28, 11, 15), addi(28, 28, 97), sw(28, 5, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF), beq(7, 0, -4 * 2)]
    p += [lw(10, 5, 0), _ret()]
    return p

def shim_spi_transfer_short_nl():
    p = []
    p += [lui(5, 0x60000)]
    p += [slli(11, 11, 16)]
    p += [addi(10, 0, 0)]
    p += [addi(6, 0, 2)]
    loop_start = len(p)
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 95), sw(7, 5, 0)]
    p += [addi(7, 0, 83), sw(7, 5, 0)]
    p += [srli(7, 11, 24)]
    p += [srli(28, 7, 4), addi(28, 28, 97), sw(28, 5, 0)]
    p += [andi(28, 7, 15), addi(28, 28, 97), sw(28, 5, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 92), sw(7, 5, 0)]
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    p += [lw(28, 5, 0), andi(28, 28, 0xFF)]
    p += [slli(10, 10, 8), or_r(10, 10, 28)]
    p += [slli(11, 11, 8), addi(6, 6, -1)]
    p += [bne(6, 0, -4 * (len(p) - loop_start))]
    p += [_ret()]
    return p

def shim_spi_transfer_long_nl():
    p = []
    p += [lui(5, 0x60000)]
    p += [addi(10, 0, 0)]
    p += [addi(6, 0, 4)]
    loop_start = len(p)
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 95), sw(7, 5, 0)]
    p += [addi(7, 0, 83), sw(7, 5, 0)]
    p += [srli(7, 11, 24)]
    p += [srli(28, 7, 4), addi(28, 28, 97), sw(28, 5, 0)]
    p += [andi(28, 7, 15), addi(28, 28, 97), sw(28, 5, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 92), sw(7, 5, 0)]
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    p += [lw(28, 5, 0), andi(28, 28, 0xFF)]
    p += [slli(10, 10, 8), or_r(10, 10, 28)]
    p += [slli(11, 11, 8), addi(6, 6, -1)]
    p += [bne(6, 0, -4 * (len(p) - loop_start))]
    p += [_ret()]
    return p

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

def shim_spi_transfer_bytes_nl(chunk_max=16):
    p = []
    p += [lui(5, 0x60000)]
    ret_target = 52
    p += [beq(13, 0, 4 * (ret_target - 1))]     # 1: jump to ret
    
    # Outer chunk loop (up to chunk_max bytes per chunk)
    chunk_start = len(p)                        # 2
    p += [addi(6, 0, chunk_max)]                # 2: t1 = chunk_max
    shift = 4 if chunk_max == 16 else 5 if chunk_max == 32 else 6
    p += [srli(28, 13, shift)]                  # 3: t3 = a3 >> shift
    p += [bne(28, 0, 4 * 2)]                    # 4: if a3 >= chunk_max skip
    p += [addi(6, 13, 0)]                       # 5: t1 = a3
    
    # Emit \x1b_SX
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 7
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # 9
    p += [addi(7, 0, 83), sw(7, 5, 0)]          # 11
    p += [addi(7, 0, 88), sw(7, 5, 0)]          # 13
    
    # Emit 2-byte length
    p += [srli(7, 6, 7), andi(7, 7, 0x7F), sw(7, 5, 0)] # 16
    p += [andi(7, 6, 0x7F), sw(7, 5, 0)]                 # 18
    
    # TX loop
    p += [addi(28, 6, 0)]                       # 19: t3 = chunk_len
    p += [addi(29, 11, 0)]                      # 20: t4 = data
    tx_start = len(p)                           # 21
    p += [addi(7, 0, 0xFF)]                     # 21: t2 = 0xFF
    p += [beq(29, 0, 4 * 3)]                    # 22: if NULL skip (offset +12)
    p += [lbu(7, 29, 0)]                        # 23: t2 = *data
    p += [addi(29, 29, 1)]                      # 24: data++
    
    p += [srli(30, 7, 4), addi(30, 30, 97), sw(30, 5, 0)] # 27
    p += [andi(30, 7, 15), addi(30, 30, 97), sw(30, 5, 0)]# 30
    p += [addi(28, 28, -1)]                     # 31
    p += [bne(28, 0, -4 * (len(p) - tx_start))] # 32
    
    p += [beq(11, 0, 4 * 2)]                    # 33
    p += [addi(11, 29, 0)]                      # 34: a1 = data
    
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 36
    p += [addi(7, 0, 92), sw(7, 5, 0)]          # 38
    
    # RX loop
    p += [addi(28, 6, 0)]                       # 39: t3 = chunk_len
    rx_start = len(p)                           # 40
    poll_start = len(p)                         # 40
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]     # 42
    p += [beq(7, 0, -4 * (len(p) - poll_start))]# 43
    p += [lw(30, 5, 0)]                         # 44
    p += [beq(12, 0, 4 * 3)]                    # 45
    p += [sb(30, 12, 0)]                        # 46
    p += [addi(12, 12, 1)]                      # 47
    p += [addi(28, 28, -1)]                     # 48
    p += [bne(28, 0, -4 * (len(p) - rx_start))] # 49
    
    p += [sub_r(13, 13, 6)]                     # 50: a3 -= t1
    p += [bne(13, 0, -4 * (len(p) - chunk_start))] # 51
    
    p += [_ret()]                               # 52
    return p

# void espShow(uint8_t pin, uint8_t *pixels, uint32_t numBytes, boolean is800KHz)
# a0 = pin, a1 = pixels, a2 = numBytes
def shim_espshow():
    p = [lui(5, 0x60000)]
    for ch in (27, ord('_'), ord('N')): p += _emit_const(ch)
    p += [andi(7, 10, 0x7F), sw(7, 5, 0)]
    p += [andi(7, 12, 0x7F), sw(7, 5, 0)]
    
    tx_head = len(p)
    p += [0]
    tx_body = [lbu(7, 11, 0)] + _emit_nibbles(7) + [addi(11, 11, 1), addi(12, 12, -1)]
    tx_body += [jal(0, -4 * (len(tx_body) + 1))]
    p[tx_head] = beq(12, 0, 4 * (len(tx_body) + 1))
    p += tx_body
    
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [_ret()]
    return p

# void neopixelWrite(uint8_t pin, uint8_t r, uint8_t g, uint8_t b)
# a0 = pin, a1 = r, a2 = g, a3 = b
def shim_neopixelwrite():
    p = [lui(5, 0x60000)]
    for ch in (27, ord('_'), ord('N')): p += _emit_const(ch)
    p += [andi(7, 10, 0x7F), sw(7, 5, 0)]
    p += [addi(7, 0, 3), sw(7, 5, 0)]
    for reg in (11, 12, 13):
        p += _emit_nibbles(reg)
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [_ret()]
    return p

def shim_analog_read(is_mv=False):
    p = []
    p += [lui(5, 0x60000)]                      # 0
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 2
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # 4
    ch = ord('V') if is_mv else ord('A')
    p += [addi(7, 0, ch), sw(7, 5, 0)]          # 6
    p += [andi(7, 10, 0x7F), sw(7, 5, 0)]       # 8: pin
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 10
    p += [addi(7, 0, 92), sw(7, 5, 0)]          # 12
    
    # Read 2 bytes (hi, lo)
    p += [addi(10, 0, 0)]                       # 13: a0 = 0
    p += [addi(6, 0, 2)]                        # 14: t1 = 2
    loop_start = len(p)                         # 15
    poll_start = len(p)                         # 15
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]     # 15, 16
    p += [beq(7, 0, -4 * (len(p) - poll_start))]# 17
    p += [lw(28, 5, 0), andi(28, 28, 0xFF)]     # 18, 19
    p += [slli(10, 10, 8), or_r(10, 10, 28)]    # 20, 21: a0 = (a0 << 8) | byte
    p += [addi(6, 6, -1)]                       # 22
    p += [bne(6, 0, -4 * (len(p) - loop_start))]# 23
    p += [_ret()]                               # 24
    return p

def shim_analog_write():
    p = []
    p += [lui(5, 0x60000)]                      # 0
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 2
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # 4
    p += [addi(7, 0, ord('P')), sw(7, 5, 0)]    # 6: 'P'
    p += [andi(7, 10, 0x7F), sw(7, 5, 0)]       # 8: pin
    p += [srli(7, 11, 7), andi(7, 7, 0x7F), sw(7, 5, 0)] # 11: duty >> 7
    p += [andi(7, 11, 0x7F), sw(7, 5, 0)]       # 13: duty & 0x7F
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 15
    p += [addi(7, 0, 92), sw(7, 5, 0)]          # 17
    p += [_ret()]                               # 18
    return p

def bltu(rs1, rs2, offset):
    imm12 = (offset >> 12) & 1
    imm10_5 = (offset >> 5) & 0x3F
    imm4_1 = (offset >> 1) & 0xF
    imm11 = (offset >> 11) & 1
    return (imm12 << 31) | (imm10_5 << 25) | (rs2 & 0x1F) << 20 | (rs1 & 0x1F) << 15 | 0x6 << 12 | (imm4_1 << 8) | (imm11 << 7) | 0x63

def shim_i2s_write():
    p = []
    p += [lui(5, 0x60000)]                      # 0: t0 = 0x60000000
    p += [beq(13, 0, 4 * 2)]                    # 1: if bytes_written != 0
    p += [sw(12, 13, 0)]                        # 2: *bytes_written = size
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 4: '\x1b'
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # 6: '_'
    p += [addi(7, 0, ord('I')), sw(7, 5, 0)]    # 8: 'I'
    p += [srli(7, 12, 7), andi(7, 7, 0x7F), sw(7, 5, 0)] # 11: len_hi
    p += [andi(7, 12, 0x7F), sw(7, 5, 0)]       # 13: len_lo
    p += [beq(12, 0, 4 * 6)]                    # 14
    loop_start = len(p)                         # 15
    p += [lbu(7, 11, 0), sw(7, 5, 0)]           # 15, 16: *src
    p += [addi(11, 11, 1)]                      # 17: src++
    p += [addi(12, 12, -1)]                     # 18: size--
    p += [bne(12, 0, -4 * (len(p) - loop_start))]# 19
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 21: '\x1b'
    p += [addi(7, 0, 92), sw(7, 5, 0)]          # 23: '\\'
    p += [addi(10, 0, 0)]                       # 24: return 0 (ESP_OK)
    p += [_ret()]                               # 25
    return p

def shim_twai_transmit():
    p = []
    # a0 = a1 if a1 != 0 (for v2 API)
    p += [beq(11, 0, 4 * 2)]
    p += [addi(10, 11, 0)]
    
    p += [lui(5, 0x60000)]                      # t0 = 0x60000000
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # '\x1b'
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # '_'
    p += [addi(7, 0, ord('C')), sw(7, 5, 0)]    # 'C'
    
    # load message fields: flags at 0, id at 4, dlc at 8, data at 9
    p += [lw(29, 10, 0)]                        # flags (offset 0)
    p += [lw(6, 10, 4)]                         # id (offset 4)
    p += [lbu(28, 10, 8)]                       # dlc (offset 8)
    
    # emit flags and dlc (masked to 7-bit safe ASCII)
    p += [andi(7, 29, 0x7F), sw(7, 5, 0)]       # flags
    p += [andi(7, 28, 0x0F), sw(7, 5, 0)]       # dlc (0..8)
    
    # emit 4 bytes of identifier in 7-bit chunks
    p += [srli(7, 6, 21), andi(7, 7, 0x7F), sw(7, 5, 0)] # id >> 21
    p += [srli(7, 6, 14), andi(7, 7, 0x7F), sw(7, 5, 0)] # id >> 14
    p += [srli(7, 6, 7), andi(7, 7, 0x7F), sw(7, 5, 0)]  # id >> 7
    p += [andi(7, 6, 0x7F), sw(7, 5, 0)]                 # id & 0x7F
    
    # loop dlc times to emit data bytes (at offset 9(a0))
    p += [addi(30, 10, 9)]                      # t5 = data ptr (offset 9)
    p += [beq(28, 0, 4 * 6)]                    # if dlc == 0 skip data loop
    loop_start = len(p)
    p += [lbu(7, 30, 0), sw(7, 5, 0)]           # *data ptr
    p += [addi(30, 30, 1)]                      # data ptr++
    p += [addi(28, 28, -1)]                     # dlc--
    p += [bne(28, 0, -4 * (len(p) - loop_start))]
    
    # trailer '\x1b\\'
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 92), sw(7, 5, 0)]
    p += [addi(10, 0, 0)]                       # return 0 (ESP_OK)
    p += [_ret()]
    return p

def shim_twai_receive():
    p = []
    # a0 = a1 if a1 != 0
    p += [beq(11, 0, 4 * 2)]
    p += [addi(10, 11, 0)]
    
    p += [lui(5, 0x60000)]                      # t0 = 0x60000000
    # emit '\x1b_CR\x1b\\'
    p += [lui(7, 0x52436), addi(7, 7, -0x0E5)]  # t2 = '\x1b_CR'
    # loop 4 bytes
    loop_hdr = len(p)
    p += [andi(28, 7, 0xFF), sw(28, 5, 0), srli(7, 7, 8), bne(7, 0, -4 * 3)]
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)] # '\x1b\\'
    
    # poll UART0 RX for status byte
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    
    # read status byte (0 = timeout, 1 = frame available)
    p += [lw(7, 5, 0), andi(7, 7, 0xFF)]
    branch_timeout = len(p)
    p += [0]                                    # placeholder
    
    # read flags at offset 0
    p += [lw(28, 5, 0), sw(28, 10, 0)]
    
    # read 4-byte ID in 7-bit chunks into t1
    p += [addi(6, 0, 0), addi(29, 0, 4)]        # t1 = 0, count = 4
    id_loop = len(p)
    p += [slli(6, 6, 7), lw(28, 5, 0), andi(28, 28, 0x7F), or_r(6, 6, 28)]
    p += [addi(29, 29, -1)]
    p += [bne(29, 0, -4 * (len(p) - id_loop))]
    p += [sw(6, 10, 4)]                         # identifier at offset 4
    
    # read dlc
    p += [lw(28, 5, 0), sb(28, 10, 8)]          # dlc at offset 8
    
    # read 8 data bytes at offset 9
    p += [addi(30, 10, 9), addi(29, 0, 8)]      # data ptr, count = 8
    data_loop = len(p)
    p += [lw(28, 5, 0), sb(28, 30, 0), addi(30, 30, 1)]
    p += [addi(29, 29, -1)]
    p += [bne(29, 0, -4 * (len(p) - data_loop))]
    
    p += [addi(10, 0, 0), _ret()]               # return 0 (ESP_OK)
    
    # timeout
    timeout_target = len(p)
    p[branch_timeout] = beq(7, 0, 4 * (timeout_target - branch_timeout))
    p += [addi(10, 0, 0x107), _ret()]           # return ESP_ERR_TIMEOUT
    return p

if __name__ == '__main__':
    all_shims = {
        'i2cWrite': shim_i2cwrite(),
        'i2cRead': shim_i2cread(),
        'spiTransferByte': shim_spi_transfer_byte_88(),
        'spiTransferByteNL': shim_spi_transfer_byte_88(),
        'spiWriteByteNL': shim_spi_transfer_byte_88(),
        'spiWriteNL': shim_spi_write_nl(),
        'spiWritePixelsNL': shim_spi_write_nl(),
        'spiTransferShortNL': shim_spi_transfer_short_nl(),
        'spiWriteShortNL': shim_spi_transfer_short_nl(),
        'spiTransferLongNL': shim_spi_transfer_long_nl(),
        'spiWriteLongNL': shim_spi_transfer_long_nl(),
        'spiTransferBytesNL': shim_spi_transfer_bytes_nl(16),
        'spiTransaction': shim_noop(),
        'spiEndTransaction': shim_noop(),
        'spiSimpleTransaction': shim_noop(),
        'spiStartBus': shim_spi_start_bus(),
        'spiStopBus': shim_noop(),
        'spiGetClockDiv': shim_noop(),
        'spiSetClockDivider': shim_noop(),
        'spiSetBitOrder': shim_noop(),
        'spiSetDataMode': shim_noop(),
        'espShow': shim_espshow(),
        'neopixelWrite': shim_neopixelwrite(),
        'rmtInit': shim_noop(),
        '_rmtWrite': shim_noop(),
        'rmtWrite': shim_noop(),
        '_rmtDetachBus': shim_noop(),
        'analogRead': shim_analog_read(False),
        '__analogRead': shim_analog_read(False),
        'analogReadMilliVolts': shim_analog_read(True),
        '__analogReadMilliVolts': shim_analog_read(True),
        '__analogInit': shim_noop(),
        'analogWrite': shim_analog_write(),
        'ledcWrite': shim_analog_write(),
        'ledcAttach': shim_noop(),
        'ledcAttachChannel': shim_noop(),
        'ledcDetachBus': shim_noop(),
        'analogSetWidth': shim_noop(),
        '__analogSetWidth': shim_noop(),
        'analogSetAttenuation': shim_noop(),
        '__analogSetAttenuation': shim_noop(),
        'analogSetPinAttenuation': shim_noop(),
        '__analogSetPinAttenuation': shim_noop(),
        'i2s_driver_install': shim_noop(),
        'i2s_set_pin': shim_noop(),
        'i2s_start': shim_noop(),
        'i2s_stop': shim_noop(),
        'i2s_driver_uninstall': shim_noop(),
        'i2s_write': shim_i2s_write(),
        'twai_driver_install': shim_noop(),
        'twai_driver_install_v2': shim_noop(),
        'twai_start': shim_noop(),
        'twai_start_v2': shim_noop(),
        'twai_stop': shim_noop(),
        'twai_driver_uninstall': shim_noop(),
        'twai_transmit': shim_twai_transmit(),
        'twai_transmit_v2': shim_twai_transmit(),
        'twai_receive': shim_twai_receive(),
        'twai_receive_v2': shim_twai_receive(),
    }
    out_lines = ['// Auto-generated RISC-V shims for esp-emu (I2C, SPI, NeoPixel, ADC, PWM, I2S, TWAI)', 'export const SHIMS = {']
    for name, words in all_shims.items():
        blob = b''.join(struct.pack('<I', w) for w in words)
        b_arr = ', '.join(str(b) for b in blob)
        out_lines.append(f'    {name}: new Uint8Array([{b_arr}]),')
        print(f'{name:24s}: {len(blob):3d} bytes')
    out_lines.append('};\n')
    open('shims.mjs', 'w').write('\n'.join(out_lines))
    print('shims.mjs generated!')

