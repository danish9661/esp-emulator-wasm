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
def csr_reg(op, rd, csr, rs1):
    # CSRRS/CSRRC with register mask: op in ('set', 'clear').
    funct3 = 0x2 if op == 'set' else 0x3
    return ((csr & 0xFFF) << 20 | (rs1 & 0x1F) << 15 | funct3 << 12 | (rd & 0x1F) << 7 | 0x73)
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

def _mask_uart(saved):
    # Save UART0 INT_ENA and mask all UART0 interrupts across a request/reply
    # transaction. The Arduino Serial RX ISR would otherwise steal
    # host->firmware reply bytes out of the RX FIFO mid-poll (esp-emu >= 0.41
    # delivers UART RX interrupts promptly, where 0.39 effectively did not;
    # the orphaned poll then spins forever). t0 must already hold the UART0
    # base. RV32I-only. Pair with _unmask_uart(saved) on EVERY exit path.
    return [lw(saved, 5, 0x0C), sw(0, 5, 0x0C)]

def _unmask_uart(saved):
    return [sw(saved, 5, 0x0C)]

def shim_spi_transfer_byte_88():
    p = []
    p += [lui(5, 0x60000)]
    p += _mask_uart(6)                            # t1 = saved INT_ENA (free here)
    p += [lui(7, 0x536), addi(7, 7, -0xE5)]     # '\x1b_S'
    p += [andi(28, 7, 0xFF), sw(28, 5, 0), srli(7, 7, 8), bne(7, 0, -4 * 3)]
    p += [srli(28, 11, 4), addi(28, 28, 97), sw(28, 5, 0)]
    p += [andi(28, 11, 15), addi(28, 28, 97), sw(28, 5, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF), beq(7, 0, -4 * 2)]
    p += [lw(10, 5, 0)]                           # a0 = reply byte
    p += _unmask_uart(6)                          # restore INT_ENA, then return
    p += [_ret()]
    # NOTE: 25 words = 100B. Fits spiTransferByte(146)/spiWriteByte(122);
    # the 88B/64B NL twins get a JAL into the roomy twin via pair() in elf.mjs.
    return p

def shim_spi_transfer_short_nl():
    p = []
    p += [lui(5, 0x60000)]
    p += _mask_uart(12)                           # a2 = saved INT_ENA (a2 free)
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
    p += _unmask_uart(12)
    p += [_ret()]
    return p

def shim_spi_transfer_long_nl():
    p = []
    p += [lui(5, 0x60000)]
    p += _mask_uart(12)                           # a2 = saved INT_ENA (a2 free)
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
    p += _unmask_uart(12)
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
    ret_target = 54                               # index of _ret() (was 52 with
    # an off-by-one: the a3==0 early exit jumped one word PAST ret into the
    # next function; harmless by accident, fixed here)
    p += [beq(13, 0, 4 * (ret_target - 1))]     # 1: jump to ret
    p += _mask_uart(14)                           # a4 = saved INT_ENA (a4 free)
    
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

    p += _unmask_uart(14)
    p += [_ret()]                               # 54
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
    p += _mask_uart(11)                           # a1 = saved INT_ENA (a1 free)
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
    p += _unmask_uart(11)
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

def shim_touch_read():
    # uint16_t touchRead(uint8_t pin) — same wire shape as analogRead ('A'),
    # distinct kind 'T' so the host routes to the virtual touch pad model.
    # a0 = pin -> returns u16 raw in a0.
    p = []
    p += [lui(5, 0x60000)]                      # 0
    p += _mask_uart(11)                           # a1 = saved INT_ENA (a1 free)
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 2
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # 4
    p += [addi(7, 0, ord('T')), sw(7, 5, 0)]    # 6
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
    p += _unmask_uart(11)
    p += [_ret()]                               # 24
    return p

def shim_dac_write():
    # bool dacWrite(uint8_t pin, uint8_t value) — fire-and-forget like 'P'.
    # a0 = pin, a1 = value -> returns 1 (true).
    # NOTE: every firmware->host byte is nibble-encoded ('a'+nibble): the
    # UART0->JS string path decodes as UTF-8, so raw bytes >= 0x80 would be
    # replaced by U+FFFD. Body: D<pin><vhi><vlo>.
    p = []
    p += [lui(5, 0x60000)]                      # 0
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 2
    p += [addi(7, 0, 95), sw(7, 5, 0)]          # 4
    p += [addi(7, 0, ord('D')), sw(7, 5, 0)]    # 6: 'D'
    p += [andi(7, 10, 0x7F), sw(7, 5, 0)]       # 8: pin
    p += _emit_nibbles(11)                      # value as 2 nibbles
    p += [addi(7, 0, 27), sw(7, 5, 0)]          # 12
    p += [addi(7, 0, 92), sw(7, 5, 0)]          # 14
    p += [addi(10, 0, 1)]                       # 15: return true
    p += [_ret()]                               # 16
    return p

def shim_sdmmc_read():
    # int emuSdmmcReadSectors(uint32_t lba, uint8_t *buf, uint32_t count)
    # a0 = lba, a1 = buf, a2 = count (sectors, 512B each).
    # Emits ESC _ M R <lba:8nib> <count:4nib> ESC \ then polls count*512 bytes.
    # Masks UART0 RX interrupts across the bulk poll: the Arduino Serial RX
    # ISR would otherwise steal FIFO bytes into its ring buffer mid-transfer
    # (observed on P4: first transfer fine, later ones starve). Uses t1 as the
    # saved-mask slot (reloaded after, since _emit-free header keeps it safe;
    # t2/t3/t4 are Poll scratch).
    p = []
    p += [lui(5, 0x60000)]
    p += [lw(6, 5, 0x0C)]                       # t1 = saved INT_ENA
    p += [sw(0, 5, 0x0C)]                       # mask all UART0 interrupts
    for ch in (27, ord('_'), ord('M'), ord('R')): p += _emit_const(ch)
    # lba as 8 nibbles (32-bit)
    for sh in (28, 24, 20, 16, 12, 8, 4, 0):
        p += [srli(7, 10, sh), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    # count as 4 nibbles (16-bit, max 64 sectors per call)
    for sh in (12, 8, 4, 0):
        p += [srli(7, 12, sh), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    for ch in (27, ord('\\')): p += _emit_const(ch)
    # total = count * 512 -> t3; poll that many bytes into a1
    p += [slli(28, 12, 9)]                      # t3 = count << 9
    skip = len(p); p += [0]                     # placeholder: beq t3,0,done
    rx_start = len(p)
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    p += [lw(7, 5, 0)]
    p += [sb(7, 11, 0)]
    p += [addi(11, 11, 1)]
    p += [addi(28, 28, -1)]
    p += [bne(28, 0, -4 * (len(p) - rx_start))]
    done = len(p)
    p[skip] = beq(28, 0, 4 * (done - skip))
    p += [sw(6, 5, 0x0C)]                       # restore UART0 INT_ENA
    p += [addi(10, 0, 0), _ret()]               # return 0 (OK)
    return p

def shim_sdmmc_write(chunk_size=None):
    # int emuSdmmcWriteSectors(uint32_t lba, const uint8_t *buf, uint32_t count)
    # a0 = lba, a1 = buf, a2 = count. Payload is split into 128B chunk frames
    # (`M W <lba:8><count:4><nibbles>`, reassembled by the host) because a
    # single multi-KB TX frame poisons subsequent RX on some chips (H2): the
    # tail chars go missing at batch boundaries and eat the next frame.
    # Nibble-encoded: firmware->host bytes must stay 7-bit (UTF-8 string path).
    # Temps: t1 = remaining (the ONLY live value across _emit_nibbles, which
    # clobbers t3), t4 = chunk len, t2 = scratch. a0/a2 are read-only
    # (lba/count re-emitted per chunk); a1 is the cursor. Chunk len spills to
    # the stack frame across the TX loop.
    import os as _os
    if chunk_size is None:
        chunk_size = int(_os.environ.get('SDMMC_CHUNK', '128'))
    p = []
    p += [lui(5, 0x60000)]
    p += [addi(2, 2, -16)]                      # frame for chunk-len spill
    p += [slli(6, 12, 9)]                       # t1 = remaining bytes
    skip_all = len(p); p += [0]                 # placeholder: beq t1,0,done
    chunk_start = len(p)
    p += [addi(29, 6, 0)]                       # t4 = remaining (t1; t3 is _emit scratch!)
    p += [addi(7, 0, chunk_size)]
    p += [bltu(29, 7, 8)]                       # if remaining < chunk keep t4
    p += [addi(29, 0, chunk_size)]              # else t4 = chunk
    p += [sw(29, 2, 0)]                         # spill chunk len
    for ch in (27, ord('_'), ord('M'), ord('W')): p += _emit_const(ch)
    for sh in (28, 24, 20, 16, 12, 8, 4, 0):
        p += [srli(7, 10, sh), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    for sh in (12, 8, 4, 0):
        p += [srli(7, 12, sh), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    tx_start = len(p)
    p += [lbu(7, 11, 0)] + _emit_nibbles(7)
    p += [addi(11, 11, 1)]
    p += [addi(29, 29, -1)]
    p += [bne(29, 0, -4 * (len(p) - tx_start))]
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [lw(29, 2, 0)]                         # restore chunk len
    p += [sub_r(6, 6, 29)]                      # remaining -= chunk len
    p += [bne(6, 0, -4 * (len(p) - chunk_start))]
    done = len(p)
    p[skip_all] = beq(6, 0, 4 * (done - skip_all))
    p += [addi(2, 2, 16)]
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_camera_read_band():
    # int emuCameraReadBand(uint8_t *buf, uint32_t offset, uint32_t len)
    # a0 = buf, a1 = byte offset into the canonical 96x96 frame, a2 = byte count.
    # The frame is pulled in small bands (512B) because some chips (P4) cannot
    # sink multi-KB host->firmware replies: mid-size transfers corrupt, large
    # ones hang the polling shim. Bands of <=512B verify bit-exact everywhere.
    # Emits ESC _ F <off:8nib> <len:4nib> ESC \ then polls 4B len + len bytes.
    # Masks UART0 RX interrupts across the bulk poll (see shim_sdmmc_read);
    # t5 holds the saved mask (t1 is the len accumulator here).
    p = []
    p += [lui(5, 0x60000)]
    p += [lw(30, 5, 0x0C)]                      # t5 = saved INT_ENA
    p += [sw(0, 5, 0x0C)]                       # mask all UART0 interrupts
    for ch in (27, ord('_'), ord('F')): p += _emit_const(ch)
    for sh in (28, 24, 20, 16, 12, 8, 4, 0):
        p += [srli(7, 11, sh), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    for sh in (12, 8, 4, 0):
        p += [srli(7, 12, sh), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [addi(29, 10, 0)]                      # t4 = buf cursor (save a0 first!)
    # poll 4-byte big-endian length into t1
    p += [addi(6, 0, 0)]                        # t1 = len
    p += [addi(28, 0, 4)]                       # t3 = 4
    len_loop = len(p)
    len_poll = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - len_poll))]
    p += [lw(7, 5, 0), andi(7, 7, 0xFF)]
    p += [slli(6, 6, 8), or_r(6, 6, 7)]
    p += [addi(28, 28, -1)]
    p += [bne(28, 0, -4 * (len(p) - len_loop))]
    # poll t1 payload bytes into cursor, remaining in t3
    p += [addi(28, 6, 0)]                       # t3 = len
    p += [addi(10, 6, 0)]                       # a0 = len (return value)
    skip = len(p); p += [0]                     # placeholder: beq t3,0,done
    rx_start = len(p)
    rx_poll = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - rx_poll))]
    p += [lw(7, 5, 0)]
    p += [sb(7, 29, 0)]
    p += [addi(29, 29, 1)]
    p += [addi(28, 28, -1)]
    p += [bne(28, 0, -4 * (len(p) - rx_start))]
    done = len(p)
    p[skip] = beq(28, 0, 4 * (done - skip))
    p += [sw(30, 5, 0x0C)]                      # restore UART0 INT_ENA
    p += [_ret()]
    return p

def shim_lcd_draw():
    # void emuLcdDraw(const EmuLcdReq *req)
    # req = {x1,y1,x2,y2 (u16), px (ptr), len (u32 byte count)}.
    # Emits ESC _ L <coords:16nib> <len:8nib> <raw bytes> ESC \.
    # Only a0 is a parameter, so t1/t2/t3/t4/a1/a2 are free temporaries.
    p = []
    p += [lui(5, 0x60000)]
    p += [lw(11, 10, 16), lw(12, 10, 20)]       # a1 = px, a2 = len
    for ch in (27, ord('_'), ord('L')): p += _emit_const(ch)
    for off in (0, 4, 8, 12):                   # x1, y1, x2, y2 as 4 nibbles each
        p += [lw(7, 10, off)]
        for sh in (12, 8, 4, 0):
            p += [srli(28, 7, sh), andi(28, 28, 15), addi(28, 28, 97), sw(28, 5, 0)]
    p += [lw(7, 10, 20)]                        # len as 8 nibbles
    for sh in (28, 24, 20, 16, 12, 8, 4, 0):
        p += [srli(28, 7, sh), andi(28, 28, 15), addi(28, 28, 97), sw(28, 5, 0)]
    skip = len(p); p += [0]                     # placeholder: beq len,0,trailer
    tx_start = len(p)
    # Nibble-encoded payload (firmware->host must stay 7-bit: see dac note).
    p += [lbu(28, 11, 0)]
    p += [srli(7, 28, 4), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    p += [andi(7, 28, 15), addi(7, 7, 97), sw(7, 5, 0)]
    p += [addi(11, 11, 1)]
    p += [addi(12, 12, -1)]
    p += [bne(12, 0, -4 * (len(p) - tx_start))]
    trailer = len(p)
    p[skip] = beq(12, 0, 4 * (trailer - skip))
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [_ret()]
    return p

def shim_idf_i2c_write(a0=10):
    # esp_err_t i2c_master_transmit(handle, wbuf, wsize, timeout), or legacy
    # i2c_master_write_to_device(port, addr, wbuf, wsize, timeout) with a0=11.
    # The v5 handle IS the 7-bit address (our add_device shim stores dev_addr
    # as the handle). Same wire format as Arduino i2cWrite so all host
    # parsers work unchanged. Timeout ignored.
    # regs: addr=a0, buf=a0+1, size=a0+2.
    A0, A1, A2 = a0, a0 + 1, a0 + 2
    p = [lui(5, 0x60000)]
    for ch in (27, ord('_'), ord('W')): p += _emit_const(ch)
    p += _emit_reg_low7(A0)                       # device address
    tx_head = len(p)
    p += [0]
    tx_body = [lbu(7, A1, 0)] + _emit_nibbles(7) + [addi(A1, A1, 1), addi(A2, A2, -1)]
    tx_body += [jal(0, -4 * (len(tx_body) + 1))]
    p[tx_head] = beq(A2, 0, 4 * (len(tx_body) + 1))
    p += tx_body
    for ch in (27, ord('\\')): p += _emit_const(ch)
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_idf_i2c_read(a0=10):
    # esp_err_t i2c_master_receive(handle, rbuf, rsize, timeout), or legacy
    # i2c_master_read_from_device(port, addr, rbuf, rsize, timeout) with a0=11.
    # regs: addr=a0, buf=a0+1, size=a0+2.
    A0, A1, A2 = a0, a0 + 1, a0 + 2
    p = [lui(5, 0x60000)]
    p += _mask_uart(6)                            # t1 = saved INT_ENA (t1 free)
    for ch in (27, ord('_'), ord('R')): p += _emit_const(ch)
    p += _emit_reg_low7(A0)                       # device address
    p += _emit_reg_low7(A2)                       # requested length
    for ch in (27, ord('\\')): p += _emit_const(ch)
    loop_start = len(p)
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    p += [lw(28, 5, 0), andi(28, 28, 0xFF)]
    p += [sb(28, A1, 0)]
    p += [addi(A1, A1, 1), addi(A2, A2, -1)]
    p += [bne(A2, 0, -4 * (len(p) - loop_start))]
    p += _unmask_uart(6)
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_idf_i2c_write_read():
    # esp_err_t i2c_master_transmit_receive(handle, wbuf, wsize, rbuf, rsize, t/o).
    # a0 = addr, a1 = wbuf, a2 = wsize, a3 = rbuf, a4 = rsize (a5 timeout ignored).
    # Emits a W frame then an R frame back-to-back; host answers the R part.
    p = [lui(5, 0x60000)]
    p += _mask_uart(6)                            # t1 = saved INT_ENA (t1 free)
    for ch in (27, ord('_'), ord('W')): p += _emit_const(ch)
    p += _emit_reg_low7(10)
    tx_head = len(p)
    p += [0]
    tx_body = [lbu(7, 11, 0)] + _emit_nibbles(7) + [addi(11, 11, 1), addi(12, 12, -1)]
    tx_body += [jal(0, -4 * (len(tx_body) + 1))]
    p[tx_head] = beq(12, 0, 4 * (len(tx_body) + 1))
    p += tx_body
    for ch in (27, ord('\\')): p += _emit_const(ch)
    # R phase: addr + rsize, then poll rsize bytes into rbuf (a3), count in a4.
    for ch in (27, ord('_'), ord('R')): p += _emit_const(ch)
    p += _emit_reg_low7(10)
    p += _emit_reg_low7(14)
    for ch in (27, ord('\\')): p += _emit_const(ch)
    loop_start = len(p)
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    p += [lw(28, 5, 0), andi(28, 28, 0xFF)]
    p += [sb(28, 13, 0)]
    p += [addi(13, 13, 1), addi(14, 14, -1)]
    p += [bne(14, 0, -4 * (len(p) - loop_start))]
    p += _unmask_uart(6)
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_idf_i2c_add_device():
    # esp_err_t i2c_master_bus_add_device(bus, dev_config, ret_handle).
    # a0 = bus (ignored), a1 = i2c_device_config_t*, a2 = handle*.
    # Reads device_address (u16 @ +4) and stores it AS the handle, so later
    # transmit/receive calls (which only get the opaque handle) recover the
    # address without version-dependent struct knowledge. Returns ESP_OK.
    p = [lui(5, 0x60000)]
    p += [lw(7, 11, 4), slli(7, 7, 16), srli(7, 7, 16)]  # t2 = config->device_address
    p += [sw(7, 12, 0)]                           # *ret_handle = addr
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_idf_i2c_new_bus():
    # esp_err_t i2c_new_master_bus(bus_config, ret_handle): dummy handle 1.
    p = [lui(5, 0x60000)]
    p += [addi(7, 0, 1), sw(7, 11, 0)]            # *ret_handle = 1
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_idf_spi_add_device():
    # esp_err_t spi_bus_add_device(host, dev_config, handle*).
    # Stores a dummy DRAM pointer (relocated per chip like spiStartBus) and
    # returns ESP_OK. Our transmit shim only uses the transaction struct.
    p = [lui(10, 0x3FC90), addi(10, 10, 0)]
    p += [sw(10, 12, 0)]                          # *handle = dummy bus ptr
    p += [addi(10, 0, 0), _ret()]
    return p

def shim_idf_spi_xfer():
    # esp_err_t spi_device_transmit(handle, trans) and polling variant.
    # a0 = handle (ignored — single virtual bus), a1 = spi_transaction_t*.
    # Full-duplex data phase only (cmd/addr phases not modeled): streams the
    # tx_buffer (0xFF fill when NULL, tx_data[] on USE_TXDATA) through chunked
    # SX frames and stores replies to rx_buffer (rx_data[] on USE_RXDATA).
    # Returns ESP_OK. Layout (RV32): flags@0, cmd@4, addr@8, length@16 (bits),
    # rxlength@20, freq@24, user@28, tx_buffer@32, rx_buffer@36.
    # a1/a2/a3 are reused as tx/rx cursors + remaining (free on entry), so the
    # proven chunk-loop body from shim_spi_transfer_bytes_nl is reused verbatim.
    # a4 holds the saved UART0 INT_ENA across both exit paths (ret0 + fallthrough).
    p = [lui(5, 0x60000)]
    p += _mask_uart(14)                           # a4 = saved INT_ENA
    p += [lw(7, 11, 0)]                           # t2 = flags
    p += [lw(28, 11, 32)]                         # t3 = tx_buffer (maybe NULL)
    p += [lw(29, 11, 36)]                         # t4 = rx_buffer (maybe NULL)
    p += [andi(7, 7, 8), beq(7, 0, 8)]            # USE_TXDATA?
    p += [addi(28, 11, 32)]                       #   t3 = trans+32 (tx_data)
    p += [lw(7, 11, 0), andi(7, 7, 4), beq(7, 0, 8)]  # USE_RXDATA?
    p += [addi(29, 11, 36)]                       #   t4 = trans+36 (rx_data)
    p += [lw(6, 11, 16), srli(6, 6, 3)]           # t1 = nbytes = length>>3
    p += [addi(11, 28, 0)]                        # a1 = tx cursor
    p += [addi(12, 29, 0)]                        # a2 = rx cursor
    p += [addi(13, 6, 0)]                         # a3 = remaining
    skip0 = len(p); p += [0]                      # placeholder: beq a3,0,ret0
    # --- verbatim chunk loop (16B chunks, SX frames) ---
    chunk_start = len(p)
    p += [addi(6, 0, 16)]
    p += [srli(28, 13, 4)]
    p += [bne(28, 0, 4 * 2)]
    p += [addi(6, 13, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 95), sw(7, 5, 0)]
    p += [addi(7, 0, 83), sw(7, 5, 0)]
    p += [addi(7, 0, 88), sw(7, 5, 0)]
    p += [srli(7, 6, 7), andi(7, 7, 0x7F), sw(7, 5, 0)]
    p += [andi(7, 6, 0x7F), sw(7, 5, 0)]
    p += [addi(28, 6, 0)]
    p += [addi(29, 11, 0)]
    tx_start = len(p)
    p += [addi(7, 0, 0xFF)]
    p += [beq(29, 0, 4 * 3)]
    p += [lbu(7, 29, 0)]
    p += [addi(29, 29, 1)]
    p += [srli(30, 7, 4), addi(30, 30, 97), sw(30, 5, 0)]
    p += [andi(30, 7, 15), addi(30, 30, 97), sw(30, 5, 0)]
    p += [addi(28, 28, -1)]
    p += [bne(28, 0, -4 * (len(p) - tx_start))]
    p += [beq(11, 0, 4 * 2)]
    p += [addi(11, 29, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 92), sw(7, 5, 0)]
    p += [addi(28, 6, 0)]
    rx_start = len(p)
    poll_start = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, -4 * (len(p) - poll_start))]
    p += [lw(30, 5, 0)]
    p += [beq(12, 0, 4 * 3)]
    p += [sb(30, 12, 0)]
    p += [addi(12, 12, 1)]
    p += [addi(28, 28, -1)]
    p += [bne(28, 0, -4 * (len(p) - rx_start))]
    p += [sub_r(13, 13, 6)]
    p += [bne(13, 0, -4 * (len(p) - chunk_start))]
    ret0 = len(p)
    p[skip0] = beq(13, 0, 4 * (ret0 - skip0))
    p += _unmask_uart(14)
    p += [addi(10, 0, 0), _ret()]                 # return ESP_OK
    return p

def add_r(rd, rs1, rs2):
    return (rs2 & 0x1F) << 20 | (rs1 & 0x1F) << 15 | 0x0 << 12 | (rd & 0x1F) << 7 | 0x33

def shim_idf_i2c_cmd_begin():
    # esp_err_t i2c_master_cmd_begin(port, cmd_handle, ticks_to_wait).
    # a0 = port (ignored: single virtual bus, like the v5 shims),
    # a1 = cmd handle, a2 = timeout ticks (ignored: executes instantly).
    # Walks the REAL command list built by i2c_master_{start,write,read,stop}
    # (20B nodes: 16B desc + next ptr at +16; head at handle+0) and executes
    # it as standard W/R APC frames — the same wire format as the idf-v5
    # shims, so every host parser works unchanged. Returns ESP_OK (0);
    # null handle and unknown node modes return 1.
    # Node desc (16B), reverse-engineered from the builder disassembly:
    #   w0: mode tag is (w0>>11): 6=start, 2=stop, 1=write, 3=read
    #   w1: write: payload byte if w3==1 else data pointer (multi-write with
    #       len==1 tail-calls write_byte, so multi always has len>=2);
    #       read: dest pointer always
    #   w2: 0
    #   w3: 1 (single) or byte count (multi)
    # Bus-faithful execution: consecutive WRITE nodes merge into one W frame
    # (the header goes out at the first payload byte, so addr-only phases
    # emit nothing; the first write byte after START/STOP is the stripped
    # address). A consecutive READ run (start remembered in a7) is RE-WALKED
    # twice at flush: first to sum lengths, then one R frame whose replies
    # scatter straight back into each node dest. Re-walking keeps all state
    # in firmware-owned nodes. Run replies are capped at 127B per frame by
    # the 7-bit length byte (same limit as the v5 R shim).
    # Regs: t0=UART base; a1=node cursor; a3=addr|0xFF(none); a4=hdr-open;
    # a7=read-run start|0; a6=saved INT_ENA; rest scratch. Frame: 16B stack
    # ([ra][single-byte slot]). Call discipline: single jal depth only —
    # SYNC falls through into FRUN (no link), CLOSEW/FRUN are leaves.
    p = [lui(5, 0x60000)]
    p += [lw(16, 5, 0x0C), sw(0, 5, 0x0C)]
    p += [addi(2, 2, -16), sw(1, 2, 0)]
    p += [addi(13, 0, 0xFF)]
    p += [addi(14, 0, 0)]
    p += [addi(17, 0, 0)]
    p += [beq(11, 0, 0)];  f_nullh = len(p) - 1
    p += [lw(11, 11, 0)]
    loop = len(p)
    p += [beq(11, 0, 0)];  f_done = len(p) - 1
    p += [lw(6, 11, 0), srli(6, 6, 11)]
    p += [addi(7, 0, 6), beq(6, 7, 0)];  f_start = len(p) - 1
    p += [addi(7, 0, 2), beq(6, 7, 0)];  f_stop = len(p) - 1
    p += [addi(7, 0, 1), beq(6, 7, 0)];  f_write = len(p) - 1
    p += [addi(7, 0, 3), beq(6, 7, 0)];  f_read = len(p) - 1
    p += [0];  j_fail = len(p) - 1
    p[f_start] = beq(6, 7, 4 * (len(p) - f_start))
    p += [0];  j_sync_s = len(p) - 1
    p += [addi(13, 0, 0xFF)]
    p += [0];  j_next_s = len(p) - 1
    p[f_stop] = beq(6, 7, 4 * (len(p) - f_stop))
    p += [0];  j_sync_t = len(p) - 1
    p += [0];  j_next_t = len(p) - 1
    p[f_write] = beq(6, 7, 4 * (len(p) - f_write))
    p += [0];  j_frun_w = len(p) - 1
    p += [lw(12, 11, 12)]
    p += [lw(28, 11, 4)]
    p += [addi(29, 0, 1), bne(12, 29, 0)];  f_multi = len(p) - 1
    p += [sb(28, 2, 4), addi(28, 2, 4)]
    p[f_multi] = bne(12, 29, 4 * (len(p) - f_multi))
    wloop = len(p)
    p += [beq(12, 0, 0)];  f_wend = len(p) - 1
    p += [lbu(29, 28, 0)]
    p += [addi(31, 0, 0xFF), bne(13, 31, 0)];  f_have = len(p) - 1
    p += [srli(13, 29, 1)]
    p += [0];  j_emit_end = len(p) - 1
    p[f_have] = bne(13, 31, 4 * (len(p) - f_have))
    p += [bne(14, 0, 0)];  f_hdrok = len(p) - 1
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 95), sw(7, 5, 0)]
    p += [addi(7, 0, 87), sw(7, 5, 0)]
    p += [andi(7, 13, 0x7F), sw(7, 5, 0)]
    p += [addi(14, 0, 1)]
    p[f_hdrok] = bne(14, 0, 4 * (len(p) - f_hdrok))
    p += [srli(7, 29, 4), andi(7, 7, 15), addi(7, 7, 97), sw(7, 5, 0)]
    p += [andi(7, 29, 15), addi(7, 7, 97), sw(7, 5, 0)]
    emit_end = len(p)
    p[j_emit_end] = jal(0, -4 * (j_emit_end - emit_end))
    p += [addi(28, 28, 1), addi(12, 12, -1)]
    p += [bne(12, 0, 0)];  b_wloop = len(p) - 1
    p[b_wloop] = bne(12, 0, -4 * (b_wloop - wloop))
    p[f_wend] = beq(12, 0, 4 * (len(p) - f_wend))
    p += [0];  j_next_w = len(p) - 1
    p[f_read] = beq(6, 7, 4 * (len(p) - f_read))
    p += [0];  j_closew_r = len(p) - 1
    p += [bne(17, 0, 0)];  f_have_run = len(p) - 1
    p += [addi(17, 11, 0)]
    p[f_have_run] = bne(17, 0, 4 * (len(p) - f_have_run))
    p += [0];  j_next_r = len(p) - 1
    nxt = len(p)
    p += [lw(11, 11, 16)]
    p += [0];  b_loop = len(p) - 1
    p[b_loop] = jal(0, -4 * (b_loop - loop))
    done = len(p)
    p[f_done] = beq(11, 0, 4 * (done - f_done))
    p += [0];  j_sync_d = len(p) - 1
    p += [lw(1, 2, 0), addi(2, 2, 16)]
    p += [sw(16, 5, 0x0C)]
    p += [addi(10, 0, 0), _ret()]
    fail = len(p)
    p[j_fail] = jal(0, 4 * (fail - j_fail))
    p[f_nullh] = beq(11, 0, 4 * (fail - f_nullh))
    p += [lw(1, 2, 0), addi(2, 2, 16)]
    p += [sw(16, 5, 0x0C)]
    p += [addi(10, 0, 1), _ret()]
    sync = len(p)
    p[j_sync_s] = jal(1, 4 * (sync - j_sync_s))
    p[j_sync_t] = jal(1, 4 * (sync - j_sync_t))
    p[j_sync_d] = jal(1, 4 * (sync - j_sync_d))
    p += [beq(14, 0, 0)];  c_sync = len(p) - 1
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]
    p[c_sync] = beq(14, 0, 4 * (len(p) - c_sync))
    p += [addi(14, 0, 0)]
    frun = len(p)
    p[j_frun_w] = jal(1, 4 * (frun - j_frun_w))
    p += [beq(17, 0, 0)];  f_norun = len(p) - 1
    p += [addi(28, 17, 0)]
    p += [addi(30, 17, 0)]
    p += [addi(17, 0, 0)]
    p += [addi(15, 0, 0)]
    fsum = len(p)
    p += [beq(28, 0, 0)];  f_send = len(p) - 1
    p += [lw(6, 28, 0), srli(6, 6, 11)]
    p += [addi(7, 0, 3), bne(6, 7, 0)];  f_send2 = len(p) - 1
    p += [lw(6, 28, 12)]
    p += [add_r(15, 15, 6)]
    p += [lw(28, 28, 16)]
    p += [0];  b_fsum = len(p) - 1
    p[b_fsum] = jal(0, -4 * (b_fsum - fsum))
    p[f_send] = beq(28, 0, 4 * (len(p) - f_send))
    p[f_send2] = bne(6, 7, 4 * (len(p) - f_send2))
    p += [beq(15, 0, 0)];  f_empty = len(p) - 1
    p += [addi(7, 0, 27), sw(7, 5, 0)]
    p += [addi(7, 0, 95), sw(7, 5, 0)]
    p += [addi(7, 0, 82), sw(7, 5, 0)]
    p += [andi(7, 13, 0x7F), sw(7, 5, 0)]
    p += [andi(7, 15, 0x7F), sw(7, 5, 0)]
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]
    p[f_empty] = beq(15, 0, 4 * (len(p) - f_empty))
    p += [addi(28, 30, 0)]
    fscat = len(p)
    p += [beq(15, 0, 0)];  f_scat = len(p) - 1
    p += [lw(6, 28, 0), srli(6, 6, 11)]
    p += [addi(7, 0, 3), bne(6, 7, 0)];  f_scat2 = len(p) - 1
    p += [lw(29, 28, 4), lw(30, 28, 12)]
    p += [lw(28, 28, 16)]
    p += [beq(30, 0, 0)];  f_skip0 = len(p) - 1
    p[f_skip0] = beq(30, 0, 4 * (fscat - f_skip0))
    fbyte = len(p)
    p += [lw(7, 5, 0x1C), andi(7, 7, 0xFF)]
    p += [beq(7, 0, 0)];  b_spoll = len(p) - 1
    p[b_spoll] = beq(7, 0, -4 * (b_spoll - fbyte))
    p += [lw(7, 5, 0), sb(7, 29, 0)]
    p += [addi(29, 29, 1), addi(30, 30, -1), addi(15, 15, -1)]
    p += [bne(30, 0, 0)];  b_fbyte = len(p) - 1
    p[b_fbyte] = bne(30, 0, -4 * (b_fbyte - fbyte))
    p += [0];  b_scat = len(p) - 1
    p[b_scat] = jal(0, -4 * (b_scat - fscat))
    p[f_scat] = beq(15, 0, 4 * (len(p) - f_scat))
    p[f_scat2] = bne(6, 7, 4 * (len(p) - f_scat2))
    p[f_norun] = beq(17, 0, 4 * (len(p) - f_norun))
    p += [_ret()]
    closew = len(p)
    p[j_closew_r] = jal(1, 4 * (closew - j_closew_r))
    p += [beq(14, 0, 0)];  c_closew = len(p) - 1
    p += [addi(7, 0, 27), sw(7, 5, 0), addi(7, 0, 92), sw(7, 5, 0)]
    p[c_closew] = beq(14, 0, 4 * (len(p) - c_closew))
    p += [addi(14, 0, 0)]
    p += [_ret()]
    for j in (j_next_s, j_next_t, j_next_w, j_next_r):
        p[j] = jal(0, -4 * (j - nxt))
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
        'spiWriteByte': shim_spi_transfer_byte_88(),
        'spiWriteByteNL': shim_spi_transfer_byte_88(),
        'spiWriteNL': shim_spi_write_nl(),
        'spiWritePixelsNL': shim_spi_write_nl(),
        'spiTransferShort': shim_spi_transfer_short_nl(),
        'spiTransferShortNL': shim_spi_transfer_short_nl(),
        'spiWriteShort': shim_spi_transfer_short_nl(),
        'spiWriteShortNL': shim_spi_transfer_short_nl(),
        'spiTransferLong': shim_spi_transfer_long_nl(),
        'spiTransferLongNL': shim_spi_transfer_long_nl(),
        'spiWriteLong': shim_spi_transfer_long_nl(),
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
        'touchRead': shim_touch_read(),
        'touchAttachInterrupt': shim_noop(),
        'touchDetachInterrupt': shim_noop(),
        'dacWrite': shim_dac_write(),
        'dacDisable': shim_noop(),
        'emuSdmmcReadSectors': shim_sdmmc_read(),
        'emuSdmmcWriteSectors': shim_sdmmc_write(),
        'emuCameraReadBand': shim_camera_read_band(),
        'emuLcdDraw': shim_lcd_draw(),
        'spi_bus_initialize': shim_noop(),
        'spi_bus_add_device': shim_idf_spi_add_device(),
        'spi_device_transmit': shim_idf_spi_xfer(),
        'spi_device_polling_transmit': shim_idf_spi_xfer(),
        'i2c_new_master_bus': shim_idf_i2c_new_bus(),
        'i2c_master_bus_add_device': shim_idf_i2c_add_device(),
        'i2c_master_transmit': shim_idf_i2c_write(),
        'i2c_master_receive': shim_idf_i2c_read(),
        'i2c_master_transmit_receive': shim_idf_i2c_write_read(),
        'i2c_master_probe': shim_noop(),
        'i2c_param_config': shim_noop(),
        'i2c_driver_install': shim_noop(),
        'i2c_master_write_to_device': shim_idf_i2c_write(11),
        'i2c_master_read_from_device': shim_idf_i2c_read(11),
        'touchRead': shim_touch_read(),
        'touchAttachInterrupt': shim_noop(),
        'touchDetachInterrupt': shim_noop(),
        'dacWrite': shim_dac_write(),
        'dacDisable': shim_noop(),
        'emuSdmmcReadSectors': shim_sdmmc_read(),
        'emuSdmmcWriteSectors': shim_sdmmc_write(),
        'emuCameraReadBand': shim_camera_read_band(),
        'emuLcdDraw': shim_lcd_draw(),
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

