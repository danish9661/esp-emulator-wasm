#!/usr/bin/env python3
"""Build a minimal bare-metal RV32 ESP app image for ESP32-C3 (no toolchain needed)."""
import struct

IRAM = 0x40380000

def lui(rd, imm20):      return (imm20 & 0xFFFFF) << 12 | rd << 7 | 0x37
def addi(rd, rs1, imm):  return (imm & 0xFFF) << 20 | rs1 << 15 | 0 << 12 | rd << 7 | 0x13
def sw(rs2, rs1, imm):
    i = imm & 0xFFF
    return (i >> 5) << 25 | rs2 << 20 | rs1 << 15 | 2 << 12 | (i & 0x1F) << 7 | 0x23
def lw(rd, rs1, imm):    return (imm & 0xFFF) << 20 | rs1 << 15 | 2 << 12 | rd << 7 | 0x03
def lbu(rd, rs1, imm):   return (imm & 0xFFF) << 20 | rs1 << 15 | 4 << 12 | rd << 7 | 0x03
def beq(rs1, rs2, off):
    o = off & 0x1FFF
    return (((o >> 12) & 1) << 31 | ((o >> 5) & 0x3F) << 25 | rs2 << 20 | rs1 << 15 |
            0 << 12 | ((o >> 1) & 0xF) << 8 | ((o >> 11) & 1) << 7 | 0x63)
def srli(rd, rs1, sh):   return (sh & 0x1F) << 20 | rs1 << 15 | 5 << 12 | rd << 7 | 0x13
def andi(rd, rs1, imm):  return (imm & 0xFFF) << 20 | rs1 << 15 | 7 << 12 | rd << 7 | 0x13
def bne(rs1, rs2, off):
    o = off & 0x1FFF
    return (((o >> 12) & 1) << 31 | ((o >> 5) & 0x3F) << 25 | rs2 << 20 | rs1 << 15 |
            1 << 12 | ((o >> 1) & 0xF) << 8 | ((o >> 11) & 1) << 7 | 0x63)
def jal(rd, off):
    o = off & 0x1FFFFF
    imm = (((o >> 20) & 1) << 31 | ((o >> 1) & 0x3FF) << 21 |
           ((o >> 11) & 1) << 20 | ((o >> 12) & 0xFF) << 12)
    return imm | rd << 7 | 0x6F

def li(rd, val):
    """32-bit load immediate -> (lui, addi) pair."""
    hi = (val + 0x800) >> 12
    lo = val - (hi << 12)
    return [lui(rd, hi & 0xFFFFF), addi(rd, rd, lo)]

CHIP_ID = {'esp32c3': 5, 'esp32c6': 13, 'esp32h2': 16}

def build_esp_image(words, entry=IRAM, path='out.bin', chip='esp32c3'):
    """Emit an ESP-IDF app image (magic 0xE9) with a single loadable segment."""
    code = b''.join(struct.pack('<I', w) for w in words)
    hdr = struct.pack('<BBBBIB3sHBHH4sB',
                      0xE9, 1, 0x02, 0x20, entry, 0xEE, b'\x00' * 3,
                      CHIP_ID[chip], 0, 0, 0xFFFF, b'\x00' * 4, 0)
    body = struct.pack('<II', entry, len(code)) + code
    img = hdr + body
    pad = (16 - (len(img) + 1) % 16) % 16          # checksum byte lands on 16B boundary
    img += b'\x00' * pad
    ck = 0xEF
    for b in code:
        ck ^= b
    img += bytes([ck])
    open(path, 'wb').write(img)
    return len(code)

GPIO_OUT_REG    = 0x60004004
GPIO_ENABLE_REG = 0x60004020

def prog_gpio(out_val, en_val=None):
    """Drive GPIO_ENABLE then GPIO_OUT with distinct values, then spin."""
    if en_val is None:
        en_val = out_val
    p = []
    p += li(5, GPIO_ENABLE_REG)
    p += li(6, en_val)
    p += [sw(6, 5, 0)]
    p += li(5, GPIO_OUT_REG)
    p += li(6, out_val)
    p += [sw(6, 5, 0)]
    p += [jal(0, 0)]
    return p


def prog_blink(mask=0x4, delay=800):
    """Toggle GPIO_OUT between `mask` and 0 forever, with a delay loop between."""
    p = []
    p += li(5, GPIO_ENABLE_REG)
    p += li(6, 0xFF)
    p += [sw(6, 5, 0)]
    p += li(5, GPIO_OUT_REG)
    loop_start = len(p)
    for val in (mask, 0):
        p += li(6, val)
        p += [sw(6, 5, 0)]
        p += li(7, delay)
        p += [addi(7, 7, -1), bne(7, 0, -4)]
    p += [jal(0, -4 * (len(p) - loop_start))]
    return p


GPIO_IN_REG = 0x6000403C
UART0_FIFO  = 0x60000000

def prog_readreg(addr=None, delay=400):
    """Poll `addr` forever, emit its low byte as two chars ('a'+nibble)."""
    p = []
    p += li(5, GPIO_IN_REG if addr is None else addr)
    p += li(7, UART0_FIFO)
    loop = len(p)
    p += [lw(12, 5, 0)]
    for sh in (4, 0):
        p += [srli(28, 12, sh), andi(28, 28, 15), addi(28, 28, 97), sw(28, 7, 0)]
    p += li(28, delay)
    p += [addi(28, 28, -1), bne(28, 0, -4)]
    p += [jal(0, -4 * (len(p) - loop))]
    return p


def prog_blinkread(mask=0x4, delay=300):
    """Drive GPIO_OUT, then read GPIO_IN back and print its low byte. Read-only probe."""
    p = []
    p += li(5, GPIO_ENABLE_REG)
    p += li(28, 0xFF)
    p += [sw(28, 5, 0)]
    p += li(5, GPIO_OUT_REG)
    p += li(6, GPIO_IN_REG)
    p += li(7, UART0_FIFO)
    loop = len(p)
    for val in (mask, 0):
        p += li(28, val)
        p += [sw(28, 5, 0), lw(12, 6, 0)]
        for sh in (4, 0):
            p += [srli(29, 12, sh), andi(29, 29, 15), addi(29, 29, 97), sw(29, 7, 0)]
        p += [addi(29, 0, 32), sw(29, 7, 0)]          # space separator
        p += li(28, delay)
        p += [addi(28, 28, -1), bne(28, 0, -4)]
    p += [jal(0, -4 * (len(p) - loop))]
    return p


UART0_STATUS = 0x6000001C

def prog_uartecho():
    """Poll UART0 RXFIFO_CNT, pop each byte, echo it back +1. No console driver."""
    p = []
    p += li(5, UART0_STATUS)
    p += li(6, UART0_FIFO)
    loop = len(p)
    p += [lw(7, 5, 0), andi(7, 7, 0xFF), bne(7, 0, 8), jal(0, -4 * 3)]
    p += [lw(28, 6, 0), addi(28, 28, 1), sw(28, 6, 0), jal(0, -4 * 7)]
    return p


def shim_i2cwrite():
    """Replacement body for Arduino's i2cWrite(num, address, buff, size, timeout).

    Emits "#<addr><data...>\n" to UART0, one char per nibble ('a'+nibble), then
    returns ESP_OK. Position-independent: the only absolute address is the UART FIFO,
    so the same blob can be written over any i2cWrite.
    a0=num a1=address a2=buff a3=size
    """
    T0, T1, T2, T3 = 5, 6, 7, 28
    A0, A1, A2, A3 = 10, 11, 12, 13
    p = []
    p += li(T0, UART0_FIFO)
    p += [addi(T1, 0, ord('#')), sw(T1, T0, 0)]
    for sh in (4, 0):                                   # 2 nibbles of the address
        p += [srli(T2, A1, sh), andi(T2, T2, 15), addi(T2, T2, 97), sw(T2, T0, 0)]
    loop = len(p)
    body = [lbu(T2, A2, 0)]
    for sh in (4, 0):                                   # 2 nibbles of each data byte
        body += [srli(T3, T2, sh), andi(T3, T3, 15), addi(T3, T3, 97), sw(T3, T0, 0)]
    body += [addi(A2, A2, 1), addi(A3, A3, -1)]
    body += [jal(0, -4 * (len(body) + 1))]              # back to loop head
    p += [beq(A3, 0, 4 * (len(body) + 1))]              # size==0 -> skip body
    p += body
    p += [addi(T1, 0, 10), sw(T1, T0, 0)]               # newline
    p += [addi(A0, 0, 0), jalr_ret()]                   # return ESP_OK
    return p

def jalr_ret():
    return 1 << 15 | 0 << 12 | 0 << 7 | 0x67            # jalr x0, x1, 0


if __name__ == '__main__':
    import sys
    if sys.argv[1] == 'blinkread':
        prog = prog_blinkread()
        out = sys.argv[2]
    elif sys.argv[1] == 'readgpio':
        prog = prog_readreg()
        out = sys.argv[2]
    elif sys.argv[1] == 'shim-i2cwrite':
        words = shim_i2cwrite()
        blob = b''.join(struct.pack('<I', w) for w in words)
        open(sys.argv[2], 'wb').write(blob)
        print(f'wrote {len(blob)} bytes of shim -> {sys.argv[2]}')
        raise SystemExit
    elif sys.argv[1] == 'uartecho':
        prog = prog_uartecho()
        out = sys.argv[2]
    elif sys.argv[1] == 'readreg':
        prog = prog_readreg(int(sys.argv[2], 0))
        out = sys.argv[3]
    elif sys.argv[1] == 'blink':
        prog = prog_blink()
        out = sys.argv[2]
    elif sys.argv[1] == 'gpio':
        prog = prog_gpio(int(sys.argv[2], 0), int(sys.argv[3], 0))
        out = sys.argv[4]
    else:
        UART0_FIFO = 0x60000000
        prog = li(5, UART0_FIFO)
        for ch in b'OK\r\n':
            prog += [addi(6, 0, ch), sw(6, 5, 0)]
        prog += [jal(0, 0)]
        out = sys.argv[1]
    n = build_esp_image(prog, path=out)
    print(f'wrote {n} bytes of code, entry=0x{IRAM:08x}')
