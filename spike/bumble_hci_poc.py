#!/usr/bin/env python3
"""PoC: Bumble virtual controller servingHCI over TCP for esp-emu.

Proves the emulator host stack can run against a REAL Bluetooth stack
(Bumble) instead of the in-sim JS virtual controller — the prerequisite
for real-device emulation (phone connects via Bumble radio/dongle).

Usage:
  python3 spike/bumble_hci_poc.py            # serves TCP 127.0.0.1:9545
  # then run the node forwarder (see spike/ble_bumble_fwd.mjs)

No root needed (no VHCI/BlueZ side — controller only, LocalLink radio).
"""
import asyncio
import logging

logging.basicConfig(level=logging.WARNING)

PORT = 9545


async def main():
    from bumble.controller import Controller
    from bumble.transport import open_transport

    async with await open_transport(f'tcp-server:127.0.0.1:{PORT}') as (source, sink):
        print(f'[bumble-poc] serving HCI on TCP 127.0.0.1:{PORT}', flush=True)
        Controller('emu-ble', source, sink)
        print('[bumble-poc] controller up (HCI_Reset + full LL emulation)', flush=True)
        await asyncio.get_running_loop().create_future()


if __name__ == '__main__':
    asyncio.run(main())
