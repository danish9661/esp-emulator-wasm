#!/usr/bin/env python3
"""Compose bootable MicroPython flash images for ESP32-P4 and ESP32-C5.

The prebuilt MicroPython v1.29.0 `mpy_p4.bin` / `mpy_c5.bin` are APP-ONLY
images (0xE9 at offset 0). The P4/C5 ROM models in esp-emu need the Arduino
layout instead: 2nd-stage bootloader @0x2000, partition table @0x8000, app
@0x10000 (NOT 0x100000 — the model only accepts the Arduino shape).

Two extra fixes are applied, both verified against the stock images:
1. Factory partition enlarged to 0x1F0000 (stock Arduino factory 0x140000
   cannot hold the 1.6-1.9MB MP apps); OTA app1 slot dropped; partition
   MD5 row recomputed (row layout `eb eb` + 14x `ff` + digest, verified
   against the Arduino table with hashlib).
2. P4 only: the MP app header caps max_chip_rev_full at v1.99 (0xC7) while
   the emulated silicon reports v3.1, so the bootloader refuses it
   ("Factory app partition is not bootable"). The two bytes are raised to
   0xFFFF (like Arduino builds) and the appended SHA256 is recomputed
   (header bytes are NOT covered by the XOR checksum, only by the SHA).

Inputs (all checked in): samples/{p4,c5}/Blink.merged.bin (bootloader),
samples/mpy/mpy_{p4,c5}.bin (pristine app images, never modified).
Outputs: samples/mpy/mpy_{p4,c5}_flash.bin (4MB composed flash).

Usage: python3 spike/mk_mpy_p4c5.py
"""
import hashlib
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MPY = ROOT / 'samples' / 'mpy'
FLASH_SIZE = 0x400000
APP_OFF = 0x10000


def entry(etype, subtype, off, size, label):
    e = (b'\xaa\x50' + bytes([etype, subtype]) + struct.pack('<II', off, size)
         + label.encode() + b'\0' * (16 - len(label)) + b'\0\0\0\0')
    assert len(e) == 32
    return e


def partition_table():
    rows = [
        entry(0x1, 0x2, 0x9000, 0x5000, 'nvs'),
        entry(0x1, 0x0, 0xe000, 0x2000, 'otadata'),
        entry(0x0, 0x0, APP_OFF, 0x1F0000, 'factory'),
        entry(0x1, 0x82, 0x290000, 0x160000, 'spiffs'),
        entry(0x1, 0x3, 0x3f0000, 0x10000, 'coredump'),
    ]
    blob = b''.join(rows)
    return blob + b'\xeb\xeb' + b'\xff' * 14 + hashlib.md5(blob).digest()


def patch_p4_maxrev(app: bytearray) -> bytearray:
    assert (app[17], app[18]) == (0xC7, 0x00), 'unexpected P4 maxrev bytes'
    app[17], app[18] = 0xFF, 0xFF
    app[-32:] = hashlib.sha256(bytes(app[:-32])).digest()
    return app


def main() -> None:
    table = partition_table()
    for tag in ('p4', 'c5'):
        ard = (ROOT / 'samples' / tag / 'Blink.merged.bin').read_bytes()
        app = bytearray((MPY / f'mpy_{tag}.bin').read_bytes())
        if tag == 'p4':
            app = patch_p4_maxrev(app)
        flash = bytearray(b'\xff' * FLASH_SIZE)
        flash[0x2000:0x8000] = ard[0x2000:0x8000]  # 2nd-stage bootloader
        flash[0x8000:0x8000 + len(table)] = table
        assert APP_OFF + len(app) <= 0x200000, f'{tag} app too big: {hex(len(app))}'
        flash[APP_OFF:APP_OFF + len(app)] = app
        out = MPY / f'mpy_{tag}_flash.bin'
        out.write_bytes(flash)
        print(f'{tag}: wrote {out} ({len(flash):#x}, app ends {APP_OFF + len(app):#x})')


if __name__ == '__main__':
    sys.exit(main())
