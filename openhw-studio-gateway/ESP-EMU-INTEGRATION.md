# Gateway Client Integration (esp-emu + future chips)

How simulators talk to this gateway, what esp-emu implements today, and the
exact wire contract for bringing up new clients (Pico 1/2, STM32F4 Ethernet,
and beyond). No gateway code changes were needed for any of this.

## Endpoints (all on `ws://HOST:5095`)

| Path | Payload | Direction |
|---|---|---|
| `/api/network-gateway?sessionId=ROOM` | **Raw Ethernet frames**, one frame per WS binary message | both |
| `/api/ble-gateway` | Raw HCI packets (proxied to Bumble TCP `127.0.0.1:9544`) | both |
| `/api/thread-gateway?sessionId=ROOM` | Raw 802.15.4 frames, room broadcast | both |

Rooms: clients sharing a `sessionId` share one virtual network (multiplayer
hub). No `sessionId` = private isolated room. All frames are broadcast to
room peers; gVisor also sees everything (private mode shares one gVisor
instance across rooms).

## Wire rules learned the hard way

1. **One raw frame per message, no length prefix.** The emulator's
   `wifi_tx_drain()` returns length-prefixed batches (`u32 LE len` + bytes);
   split them and send each frame as its own binary message. A prefixed blob
   parses as garbage ethertype and is silently dropped.
2. **You must answer ARP for your own IP.** gVisor resolves the client MAC
   before delivering anything (DNS replies included). No ARP answer = total
   downstream silence, with zero errors logged. Verified: answering ARP for
   the client IP unblocks the full DNS path.
3. **DHCP is intercepted, not forwarded.** UDP dport 67 is answered by
   `handleDHCP` directly (`192.168.4.x`, gateway `.1`); it never reaches
   gVisor.
4. **Pump the event loop.** Single-threaded JS harnesses must yield
   (`await setImmediate`) between step batches or WS `onmessage` never fires
   and the gateway "looks dead". (The browser worker already time-slices.)
5. **Egress is environment-dependent.** gVisor dials origins directly; some
   routes may be dead where you run this (here: Cloudflare-fronted hosts
   answer, some origins time out). Prefer reliable targets for tests
   (`http://example.com/`) and **retry whole flows** — see
   `spike/31-verify-wifi.mjs`.

## What esp-emu implements today

- WiFi STA (`worker.js`: `set_wifi_config` / `wifi_tx_drain` split /
  `wifi_rx_push`; also drivable headless from Node via the same wasm
  exports). The emulator self-assigns `192.168.4.2`; DHCP exchange still
  happens on the wire.
- Verified end to end: `spike/sketches/WiFiDemo/WiFiDemo.ino` (C3, DHCP +
  HTTP + HTTPS + MQTT) + `spike/31-verify-wifi.mjs` (DHCP `192.168.4.x`,
  marker asserts, best-of-5 attempts) + `samples/wifidemo.{elf,merged.bin}`
  + `spike/mqtt_broker.mjs` (minimal local broker).
- Test rig (deterministic, no internet roulette): the verify script spawns
  local servers — HTTP `:18081`, HTTPS `:18443` (self-signed cert), MQTT
  `:1885` — on the host LAN IP and passes it to the sketch via a
  `URLBASE <ip>` console line at boot (5s window, lab default baked in).
  Servers die with the test run (best-effort kill).
- BLE over the gateway: C3/C6/H2/C5 run an in-sim virtual HCI controller
  (`core/ble_controller.mjs`) plus a fabricated peer (`25-verify-hci.mjs`
  §5) for offline/CI; a PoC routes the same HCI through a real Bumble
  stack instead (see below). `/api/ble-gateway` serves the Bumble-TCP side.

## BLE: real-device emulation via Bumble (proven PoC)

Verdict: **yes, it works** — the emulated NimBLE host runs unmodified
against the real Bumble stack, which is the prerequisite for a physical
phone talking to the emulated ESP32.

How it was proven (Sep 2026, no root, no radio hardware):
- `spike/bumble_hci_poc.py` serves a Bumble virtual controller on TCP
  `127.0.0.1:9545` (same convention as `vhci_bridge.py`'s emu side).
- `spike/ble_bumble_fwd.mjs` boots C3 BLEDemo with `BLEController.handle`
  patched to forward HCI over TCP and deliver Bumble's answers into the
  shared-memory mirror (async-safe: the guest polls the flag across steps;
  15s timeout falls back to the local stub). Result: `init done` +
  `advertising started` + `ble-done` — full bring-up against real stack
  code (`BUMBLE-BACKED BRING-UP: PASS`).
- Two Bumble 0.0.231 gaps hit: ESP vendor `0xfc01` and `0x204e`
  (privacy mode) raise inside Bumble's async handlers (no reply → host
  would hang); the forwarder answers those two locally.

What remains for a real phone in the loop:
1. Bumble needs a real radio: USB BT dongle driven by Bumble, or the
   existing `vhci_bridge.py` BlueZ path (needs root + `/dev/vhci`).
2. Web path: DONE in esp-emu (`worker.js` HCI pump over this gateway's
   `/api/ble-gateway` WS + "Real radio" UI toggle in the BLE Monitor panel;
   `core/ble_hci_pump.mjs` shared by the worker and headless
   `spike/33-verify-ble-pump.mjs`). B-frame bytes are H4 already, so the
   pump is a byte copy; the guest's mirror-flag poll makes it async-safe.
   The fabricated in-sim peer stays for CI/offline; Bumble is "real radio" mode.

## Bringing up Pico 1/2 / STM32F4-Ethernet (checklist)

1. Open `ws://HOST:5095/api/network-gateway?sessionId=<room>` (binary).
2. Send raw Ethernet frames (one per message); receive broadcasts + gVisor
   replies the same way.
3. Answer ARP requests for the IP you use, or nothing comes back (rule 2).
4. DHCP optional (gateway intercepts it); static `192.168.4.x/24`, gw `.1`,
   DNS `8.8.8.8` also works.
5. Caveats: the `localhost:8080 → :80` port forward assumes the ESP32 web
   flow (private mode); multiplayer = share a `sessionId`; rooms are
   destroyed when the last client leaves.

## Thread / Matter status (probed Sep 2026 — radio unmodeled, bring-up scoped)

- ELF/map fully readable like BLE (`otPlatRadio{Enable,Receive,Transmit}`,
  `esp_ieee802154_*`, done/failed callbacks — all hookable sizes; driver is
  file-backed, patchable). OT stack boots clean (Disabled/Detached, no Guru).
- **Blocker: the 15.4 radio peripheral is not modeled.** `esp_ieee802154_enable()`
  returns -1 (`intr_alloc: No free interrupt inputs for ZB_MAC interrupt`),
  radio state stays INVALID (255), energy scans start (rc=0) but never
  progress/complete, and waiting on radio events trips the interrupt watchdog
  (`esp_openthread_radio.c:717`). Probe fixture: `spike/sketches/ThreadDemo/`.
- Bring-up path (same BLE playbook, real project): shim
  `esp_ieee802154_{enable,transmit,receive}` + done-callbacks + a virtual
  15.4 controller (beacon responses for scans, frame routing between nodes)
  plumbed to `/api/thread-gateway` here (which already room-broadcasts).
  Phase 1a LANDED in esp-emu (Sep 2026): `core/thread_shims.mjs`
  (`esp_ieee802154_enable/disable`→0, `otPlatRadioGetState`→RECEIVE,
  `otPlatRadioTransmit`→APC `G` tap), `core/thread_controller.mjs`,
  `spike/32-verify-thread.mjs` (C6 beacon request ch 15 observed in JS).
  Phase 1b LANDED: sync TxDone in the Transmit shim, energy completion via
  a deferred smart-GetState poll-point (sync EnergyScanDone wedges SubMac
  at kStateEnergyScan → Links::Send asserts mac_links.hpp:536), full PSDU
  in `G` frames, and E2E `spike/34-verify-thread-gw.mjs` (guest TX → room
  → peer, SKIP-gated). Phase 1c LANDED: fabricated ext-src beacons
  (PAN 0x1234, OT's own payload, sync ReceiveDone with Mac+1 borrowed —
  ConvertBeacon requires ext-src and dwell substate) so active scans return
  results on C6/H2/C5 (`32-verify-thread`, 57 asserts).
- Arduino ships OpenThread/Matter/Zigbee libs (firmware builds); WASM has
  zero 15.4 glue today.
- Matter: needs Thread operational (above) or WiFi-operational (works) plus
  BLE commissioning (BTP GATT over the fabricated peer — unexplored) plus a
  commissioner (no chip-tool in this env) plus a Matter app build. Nearest
  term is the Thread radio itself.

## Changelog (this integration)

- 2026-09-10: first E2E proof (DHCP + HTTP 200 through gateway + gVisor
  NAT). Added `spike/sketches/WiFiDemo/`, `samples/wifidemo.*`,
  `spike/31-verify-wifi.mjs` (gateway-optional: SKIP exit 0 when unreachable).
  No gateway source changes.
- 2026-09-10: BLE-over-gateway PoC (Bumble virtual controller on TCP +
  `spike/ble_bumble_fwd.mjs` forwarder; full NimBLE bring-up against the
  real stack). Docs only; web HCI pump + real radio still open.
- 2026-09-10: gateway default port 5099 → 5095 (`GW_PORT` env override
  added; product behavior unchanged otherwise). HTTPS (TLS to local,
  `setInsecure`) + MQTT (local broker round trip) verified through the
  gateway; public-internet proofs (example.com HTTP/HTTPS 200) captured
  separately during bring-up.
