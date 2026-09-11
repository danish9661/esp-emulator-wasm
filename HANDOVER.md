# HANDOVER — esp-emu (ESP-RV32 WASM Emulator)

> **Copy-paste this whole file into a new session / agent to resume work.**
> Last update: **2026-09-10**, branch `main` @ `ef37025` + Waves E/F/G/H uncommitted (Thread Phase 1a→1b→1c→1d + BLE pump + CI; all suites green, see §2 Waves E/F/G/H).
> WASM core: **0.42.0** live in `pkg/` (`pkg.prev/` is 0.41.0, `pkg.prev-0.39/` kept for bisection). All suites listed below are **green** on this commit except where noted SKIP.

---

## 1. You are taking over this repo

**Repo:** `espc3 wasm` — blazing-fast **in-browser WebAssembly RV32 emulator** for Espressif ESP32-C3 / C6 / H2 / P4 / C5 (+ S31 smoke).

**WASM core:** `pkg/esp_emu_bg.wasm` + `pkg/esp_emu.js` compiled from `espressif/esp-emulator` **0.42.0** (`pkg.prev` is 0.41.0; see `core/esp32c3.mjs:74` per-instance isolation fix for 0.42 H2 regression).

**Frontend:** `index.html` + `app.js` (XTerm.js, OLED/TFT canvases, GPIO grid) + `worker.js` (WASM instance, UART/APC routing, WiFi glue).  
**SDK:** `index.mjs` re-exports `core/esp32c3.mjs` (`ESP32C3.create({chip})`, `loadFirmware(flash,elf)`, `step(n)`, `gpio/i2c/spi/adc/pwm/i2s/twai/touch/dac/sdmmc/camera/lcd/uart0` controllers) — `rp2040js`-style, works in browser & Node.  
**Sibling gateway:** `../openhw-studio-gateway` (Go, gVisor) — **not** tracked in this repo; see `openhw-studio-gateway/ESP-EMU-INTEGRATION.md` for the client contract. Default port is now **5095** (`GW_PORT` env override).

**First principle:** **zero guest modifications** — unmodified Arduino/IDF/MicroPython `.bin` + `.elf`. ELFs are only for **load-time symbol patching**.

### 1.1 Core idea in 30s

```
ELF symbols --planHooks--> patch list --prepareSpiShims/prepareBleShims/prepareIdfShims--> RV32I shims
flash image --EspImage.writeAtVaddr--> reseal (checksum+SHA) --> WASM load_firmware
shim writes APC frame to UART0 FIFO (0x60000000; P4 0x500CA000) --> worker/core/uart parses --> virtual device
device reply --> uart_input (dribbled 16B/batch) OR shared-memory flag poll (BLE events) --> guest resumes
WiFi: native emulator glue (set_wifi_config / wifi_tx_drain split / wifi_rx_push) --> goes straight to gateway
BLE: B+E plus shared-memory mirror; 15.4: probed, unmodeled (see §7)
```

- Shims use **only RV32I** (`addi/lui/slli/srli/andi/or/lw/sw/sb/bne/beq/jalr`) → same bytes on RV32IMC/IMAC/IMAFC.
- **APC frames:** `\x1b_<kind><nibble-payload>\x1b\` — `W/R` I2C, `Q` I2C probe/scan (`P` was taken by PWM — collision once broke PWM, caught by 18-verify), `S/SX` SPI, `N` NeoPixel, `A/V` ADC, `P` PWM, `I` I2S, `C` TWAI, `T` Touch, `D` DAC, `M` SDMMC, `F` Camera, `L` LCD, `B/E` BLE. Firmware→host is nibble-encoded (`'a'+nibble`) because UART→JS is a UTF-8 string (≥0x80 → U+FFFD; I2S is the audible exception). Host→firmware is **dribbled 16B/batch** via `reply_queue.mjs` (larger pushes lose tail in HW RX FIFO). Always `pump()`.
- **BLE shared memory:** `B` still crosses as UART TX; `E` returns via `core/ble_mirror.mjs` — shim writes magic `DEADBEEF/BEAC0001` to per-chip DRAM scratch, emits `B`, polls `flag==1`; host scans WASM linear memory for the magic (once/boot), writes event, sets `flag=1`. No UART RX involved (unreliable for the guest to poll on this core).
- **Per-chip scratch (shims.mjs → relocateShimsForChip):** `UART0_BASE` C3/C6/H2/C5 `0x60000000`, P4 `0x500CA000`; `SPI_BUS_BASE` C3 `0x3fc90000`, C6/H2/C5 `0x40810000`, P4 `0x4ff40000`; `BLE_SCRATCH`/`I2C_CELL_BASE` C3 `0x3fc91000`, C6/H2/C5 `0x40820000`, P4 `0x4ff48000`; `I2C_CELL=0x3FC91`, `PWM_TAB=0x40` offset, fake config `+0x600`, static alloc `+0x800`. LL scratch now prefers the **linker-placed `ble_emu_scratch`** over fixed RAM (fixed bases collide with heap/`.dram0.data` once `.bss` grows — C3's `0x3fc94000` sits inside `.data`).
- **WASM per-instance isolation:** `core/esp32c3.mjs:82` busts Node's ESM cache (`esp_emu.js?instance=N`) so each MCU gets its own linear memory/dlmalloc heap. Without it, pkg 0.42 shares one heap and the H2 suite aborts on the 3rd instance (see `issue.md` #3).
- **App offsets:** `EspImage` knows `0x10000` and `0x100000` (P4/C5 Arduino use `0x100000`; MPY composed flashes use `0x10000` — see §3.5).

### 1.2 Supported chips (what the WASM core ships)

| Chip   | Core            | Mem              | Wireless            | ROM banner                        | Status |
|--------|-----------------|------------------|---------------------|-----------------------------------|--------|
| C3     | RV32IMC 160MHz  | 400K SRAM 384K ROM | WiFi4 BLE5 22 GPIO | `ESP-ROM:esp32c3-api1-20210207`    | full |
| C6     | RV32IMAC 160MHz | 512K SRAM 320K ROM | WiFi6 BLE5 15.4 30 GPIO | `ESP-ROM:esp32c6-20220919`    | full |
| H2     | RV32IMAC 96MHz  | 320K SRAM 128K ROM | BLE5 15.4 19 GPIO | `ESP-ROM:esp32h2-20221101`         | full |
| C5     | RV32IMAC 240MHz | 384K SRAM          | WiFi6 BLE5 15.4 29 GPIO | `ESP-ROM:esp32c5-eco2-20250121` | 22/22 (no TWAI/BLE radio model) |
| P4     | RV32IMAFC 400MHz dual | 768K SRAM | no radio, HP | `ESP-ROM:esp32p4-20230811`          | full |
| S31    | dual RV32 320MHz | 512K 60 GPIO | WiFi6 BT5.4 15.4 | `ESP-ROM:esp32s31-20251218`       | target+ROM smoke only |

---

## 2. What we were doing (last 3 waves — all committed, all green)

### Wave A — Fabricated BLE peer on LL chips (a0be2a7)
Console-driven **real GAP/GATT/L2CAP/ATT** over the NimBLE LL transport (C6/H2/C5 routed around ROM `r_ble_ll_*`): `!conn` (LE Conn Complete) + `!advterm` (set-terminated unpark) + `!rver`/`!feat` (version/features completes; controller answers Command Status for `0x041D`/`0x2016`) → `onConnect` + `ble_hs_conn` exists. Then `!disc`/`!find` (Read-By-Group/FindInfo), `!wr 11 0100` (CCCD; first flipping WRITE is applied+subscribes but 0x13 response is lost in-sim — retry, idempotent), console text → ATT Notify (0x1B + payload). Outbound ATT prints as `acl-tx <hex>` (mbuf-chain walk, chain freed afterwards); inbound uses flat EVT / `ble_hs_mbuf_from_flat` ACL with a sketch-registered msys pool (`mp_flags|=0x02`). Sculpted `25-verify-hci.mjs` §5 + `PROTOCOLS.md`/`README.md`. CI work started (`.github/workflows/verify.yml` — subsequently moved to defer, see git log).

### Wave B — C3 BLE parity + WASM isolation + full ATT on all chips (092536b, 4362f7b)
- **H2 dlmalloc root-cause:** `initSync` caches `wasm` per glue module → all MCUs share one linear memory/dlmalloc heap (`a.memory.buffer === b.memory.buffer`). Two running instances corrupt it, third aborts. Fix: fresh module per `create()` (`core/esp32c3.mjs:84 wasmInstanceCounter`). Full H2 suite green.
- **C3 fabricated peer:** `vhciInjectPark` routes `ble_console_inject` into the registered VHCI host callback (flat bytes both kinds); responses travel as B-frame ACL on the HCI tap, answered with Number-Of-Completed-Packets. Sketch pool via manual `os_mempool/mbuf_pool/msys_register` (no `r_` one-call helper on VHCI images); VHCI scratch via `ble_emu_scratch`.
- **Harvest bug:** tap used `>10`, dropping the exactly-10B Write Response — fixed to `>=10`. Full ATT now on **C6+C3+H2+C5** (`25-verify-hci.mjs` §5 `full=true` for all four), plus prior `C3/C6/H2/C5` health etc.
- **Write-response race bounded:** lost iff the WRITE flips subscription state; no-change writes always respond.
- **Regressions:** 18/21/22/23/24/25/26/27/28/30 all green.

### Wave C — P4/C5 MicroPython boot recipe (c53ecfb) + P4 GPIO fix (787c80f)
The MP `mpy_p4/c5.bin` are **app-only**. P4/C5 need Arduino layout: bootloader `@0x2000` (not 0x0/0x1000), partition table `@0x8000`, app `@0x10000` (not 0x100000). Fixes: factory enlarged to `0x1F0000` (stock `0x140000` too small) with dropped OTA app1 slot and recomputed partition-MD5 row (`eb eb`+14×`ff`+digest, verified against Arduino table); P4 header `max_chip_rev_full` raised v1.99→any (`0xFFFF` like Arduino) with re-sealed SHA256 (header bytes outside XOR checksum). Generator `spike/mk_mpy_p4c5.py` composes `samples/mpy/mpy_*_flash.bin` (checked in). Results: **REPL+I2C+SPI+ADC+PWM on both**, GPIO too on C5; full MP suite `30-verify-mpy` extended.
- **P4 GPIO deep-dive:** P4 GPIO **IS modeled** (OUT→`0x4cbe960`, ENABLE→`+8`, IN-coupled at `+16`), proven by guest/linear co-movement. Earlier miss was the whole-word-zero calibration gate vs `0x20000` boot baseline; relaxed to per-pin-zero in `spike/mpy_repl.mjs`, IN discovery now optional. P4 MP quirk: `Pin(16+)` drives OUT but never sets ENABLE — suite uses low pins. ADC on GPIO16+ (Pin16→ch0).

### Wave D — WiFi E2E via gateway + BLE-over-Bumble PoC + Thread probe (2ec9573, 18647f4, ef37025)
- **WiFi E2E (2ec9573 → 18647f4):** `WiFiDemo` (C3 DHCP + HTTP+HTTPS+MQTT) + `samples/wifidemo.*` + `spike/31-verify-wifi.mjs` (gateway-optional SKIP, per-protocol best-of-5, spawns local HTTP:18081/HTTPS:18443(self-signed)/MQTT:1885 servers, passes `URLBASE <hostIP>`). During bring-up, verified DHCP `192.168.4.2` + HTTP 200 559B through the real gateway, then moved rig to deterministic local servers (public routes flap in sandboxes). Debugged E-loop starvation, `ssl.wrap_socket`→`SSLContext`, stale-server squats, unique MQTT IDs.
- **Gateway default port 5099→5095 + `GW_PORT` env override** (all product behavior otherwise unchanged).
- **BLE-over-Bumble PoC (2ec9573):** `spike/bumble_hci_poc.py` (Bumble Controller on TCP 9545) + `spike/ble_bumble_fwd.mjs` (forwarder patching `BLEController.handle` → TCP → shared-mirror deliver, 15s fallback to local stub, two ops `0xfc01`/`0x204e` answered locally — Bumble 0.0.231 gaps). Result: `BUMBLE-BACKED BRING-UP: PASS` (init+advertise+ble-done against real stack). No root/radio; web HCI pump + real dongle/BlueZ still open.
- **Thread/15.4 probe (ef37025):** `spike/sketches/ThreadDemo/ThreadDemo.ino` (OT bring-up, link enable, energy scan, radio state poll, direct `esp_ieee802154_*` return codes). Finding: OT boots clean (Disabled) but **15.4 radio is unmodeled** (`esp_ieee802154_enable()`→`-1`, `intr_alloc: No free interrupt inputs for ZB_MAC interrupt`, radio INVALID 255, scans start rc=0 yet never progress; blocking trips IWDT at `esp_openthread_radio.c:717`). ELF/map fully hookable — same BLE playbook applies.

### Wave E — Thread Phase 1a + Web HCI pump + CI (uncommitted, all green)
- **Thread Phase 1a:** `core/thread_shims.mjs` (`esp_ieee802154_enable/disable`→ret0, `otPlatRadioReceive`→ret0, `otPlatRadioGetState`→li-2+c.ret RECEIVE was 255, `otPlatRadioTransmit`→APC `G` tap ch+len) + `core/thread_controller.mjs` + `G` route in `core/uart.mjs`/`worker.js` + `thread` tier in `elf.mjs`/`core/esp32c3.mjs`. Two bugs caught live: `lui` imm must be the FULL base (0x60000000, `rvasm` `lui` op takes `>>>12` itself — 0x60000 encoded T0=0x60000 → Store fault at Transmit+8), and the pump stays silent when the firmware has no 15.4 symbols. `spike/32-verify-thread.mjs` asserts enable 0 + radio 2 + TX tap (beacon ch 15) + no Guru. `samples/threaddemo_c6.*` checked in.
- **Web HCI pump:** `core/ble_hci_pump.mjs` (B-frame bytes ARE H4 — byte copy to `/api/ble-gateway`; `0xfc01`/`0x204e` + ACL stay local; closed-transport fallback) wired into `worker.js` (`ble_connect/disconnect/set_mode`, `ble_status` posts) + "Real radio" toggle in the BLE Monitor panel + `THREAD` tag in the Peripheral Monitor. `spike/33-verify-ble-pump.mjs` proves local/forward/gaps/ACL/fallback headless (5 tests, no gateway needed).
- **CI:** `verify.yml` split into 7 jobs (ble build+25, c3, multichip, mpy, thread-pump, wifi SKIP-gated, bumble-poc `continue-on-error`). YAML-validated; thread-pump + SKIP path run locally.

### Wave F — Thread Phase 1b: scan completion + gateway E2E (uncommitted, all green)
- **Sync-completion hazard root-caused:** calling EnergyScanDone inside the EnergyScan shim runs SubMac::HandleEnergyScanDone BEFORE SubMac::EnergyScan's own `SetState(kStateEnergyScan)` continuation → state wedged at 5 → next `Links::Send` asserts `mac_links.hpp:536` (`SuccessOrAssert(mSubMac.Send())`, Send returns 13 in state 5). Found by disassembly, not guessing.
- **Deferred completion:** EnergyScan park sets a flag (word at `I2C_CELL_BASE+0x20`); smart GetState park delivers EnergyScanDone on a later poll (rssi -60), when the machine is quiescent. Sketch retries ActiveScan from `loop()` after the energy callback (back-to-back scans correctly return BUSY while occupied).
- **Mid-entry coverage:** ALL MAC traffic enters via `Radio::Transmit`'s tail-jump to Transmit+0x5A (full entry uncalled) — main TX shim lives at +0x5A with a `j` at +0x00. Both parks live in dead `ieee802154_mac_init` (266B; only caller esp-enable is stubbed). Full PSDU now rides in `G` frames; `H` = energy-scan telemetry.
- **Address corrections:** real `otPlatRadioTransmit` = 0x42038fa6 (not 0x42038f0e — previous-fn tail misread), real `GetState` = WEAK 6B stub at 0x42040fe8 (0x42040f44 was mid-ReceiveDone misread). Extras confirm all six sites.
- **Results:** energy (ch 15, -60) + active scans complete (alarm expiry, no beacons), beacon PSDU `030800ffffffff070000`, `34-verify-thread-gw` proves guest TX → room → peer (SKIP-gated). TxStarted call omitted (3 insns the budget lacks; documented in-shim).
- **Web HCI pump:** `core/ble_hci_pump.mjs` (B-frame bytes ARE H4 — byte copy to `/api/ble-gateway`; `0xfc01`/`0x204e` + ACL stay local; closed-transport fallback) wired into `worker.js` (`ble_connect/disconnect/set_mode`, `ble_status` posts) + "Real radio" toggle in the BLE Monitor panel + `THREAD` tag in the Peripheral Monitor. `spike/33-verify-ble-pump.mjs` proves local/forward/gaps/ACL/fallback headless (5 tests, no gateway needed).
- **CI:** `verify.yml` split into 7 jobs (ble build+25, c3, multichip, mpy, thread-pump, wifi SKIP-gated, bumble-poc `continue-on-error`). YAML-validated; thread-pump + SKIP path run locally.

### Wave G — Thread Phase 1c: fabricated beacons on C6/H2/C5 (uncommitted, all green)
- **ConvertBeacon demands ext-src:** short-src sets Address mode 1, Convert silently drops anything with mode != 2 — verified against OT's own `PrepareBeacon` (8-byte ext addr + payload `FF 0F 00 00`), not guessed. Beacon rebuilt: FCF 0xD000 (dst NONE, src EXT, 2006), PAN 0x1234, ext C4:22:…, OT payload, LEN 23.
- **Delivery needs Mac+1==1:** `HandleReceivedFrame` routes beacons to Report only in dwell substate, but nested-TX delivery runs before OT advances it (reads 0x00 at TX). Borrowed (=1) around the ReceiveDone call; dwell setup rewrites it right after. Probed via NULL-Report (same-batch done proved handler/Mac*) and Convert-direct (retcode 6 = parse error, drove the packing fixes).
- **Packing pitfalls hit live:** dropped 0xFF (shifted fields), missing FCS-pad bytes (GTS/pending counts go nonzero → OOB), tail word dropped in probe churn (A5 garbage → same). Each caught by memory readback, not reasoning.
- **Layout:** beacon park moved to dead `ieee802154_transmit_at` (254B IRAM; only caller was the replaced Transmit); flash→IRAM is ~24MB so all cross-links are `li`+`jalr` (JAL impossible); IRAM writability verified via image LOAD segment.
- **Results:** `active-scan pan=0x1234 ch=15 rssi=-50` on all three chips; `32-verify-thread` (57 asserts) + `samples/threaddemo_{c6,h2,c5}.*`.

### Wave H — Thread Phase 1d: RX injection + multi-node relay (uncommitted, all green)
- **Inbound slot:** host stages a complete otRadioFrame+PSDU at `I2C_CELL+0x180` (magic `THRD` @+160, discovered by linear scan); the inbound park delivers it on the next TX instead of the fabricated beacon (consumes the slot; empty slot falls back). GetState plants magic with conditional-init (never clobbers live slots, never resurrects consumed ones).
- **Mapping rule (hard-won):** JS-staged bytes are NOT guest-visible in place — staged delivery went silent with zero Guru while fabricated (guest-built) reported. Fix: guest-copy 160B slot→rxBase via mac_init copySub before delivery (guest-to-guest always lands). Verified by readback + clone experiments.
- **Frame discipline (hard-won):** chained parks must leave exactly the frames their downstream epilogue pops — inbound pops its own frame before falling through, else the return lands mid-detect and loops forever (1 TX → 6826 prints, no completion).
- **Results:** `35-verify-thread-inject` (host beacon pan=0x5678 on C6/H2/C5, fabricated suppressed) + `36-verify-thread-multi` (C6 TX → relay → H2 reports pan=0xAAAA, A keeps 0x1234).

### Wave I — Thread Phase 1e: two-node attach via relay (uncommitted, all green)
- **Result:** `37-verify-thread-attach` C6 Leader + H2 Child (role=2) via harness relay in ~21 rounds; both stacks real OT, no host crypto. 32/35/36 still green.
- **SubMac-busy wedge (hard-won):** fabricated beacons on MLE-data TXs wedge SubMac busy forever (rescans rc=5, tx frozen; no-beacon stub unblocked retries/election/ads). Fix: txMain routes by TX frame type (MAC-command type 3 → inboundPark with dwell borrow + beacon fallback; MLE-data type 1 → inbound2Park in dead box (staged delivery or clean return, never a beacon)).
- **Dead OT TimerMilli (hard-won):** FRC/esp_timer ISR never fires in-sim (interrupt starvation) so delayed responses/retries/ads never send (150s ad-less leader with live ticks/etime/heap). Fix: `otPlatAlarmMilliGetNow` shimmed to FreeRTOS ticks (dead-box park, inline hook) + sketch pumps `otPlatAlarmMilliFired()` per loop + delay 5000→100.
- **Split scratch (hard-won):** HP DRAM is JS↔guest coherent but heap-owned (slot eaten by 60k steps; staging into live heap poisoned MLD with beacon bytes at tx=0). LP SRAM (0x50000000, all chips) is heap-excluded and park-RW reliable, but JS→guest staging is unreliable on H2. Split: staging slot in HP (transient ≤5s, fail-closed gates) on H2/C5 and in LP on C6 (per-chip `slotAddrFor`); delivery scratch (rxBase), counter, LP mirror (+0x200, clear of copySub's +0x100+160B blast radius) park-only in LP. deliverPark fixes copied mPsdu to the LP copy.
- **Heap phantoms (hard-won):** live heap message buffers match magic+len+type (runaway Adel 2→22). Fix: park-side mPsdu verification (== slot+32, planted by init/stage) in deliverPark + inboundPark + JS discovery; consume never touches phantoms.
- **Idle delivery:** getstatePark hop → deliverPark (own frame, single-pop; FCF gate holds beacons unless dwelling, data eager; NO Mac borrow (natural state correct; borrow may poison data)). a0 saved/restored across EnergyScanDone (its return clobbers instance → Mac borrow from garbage faulted). Relay cursors use frame.n (immune to controller 256-cap shift).
- **MLE wire (decoded, not guessed):** suite 0x00 + secCtl 0x15 (KeyIdMode2/Mic32) + counter LE + keySeq BE + keyIdx + enc(cmd+TLVs) + MIC4; suite 0 IS the secured suite; keyIdx = (seq&0x7f)+1.
- **Sketch:** ThreadDemo pumps alarms, delay 100, periodic rescan probe (SubMac liveness: rc=0) + heap/tick/etime/now diag. Rebuilt C6/H2 samples (C5 old build still passes 35).

### Wave J — Dataset agility + gateway E2E + multihop probe
- **39-verify-thread-key2:** same 2-node attach with reversed network key (`THREAD_KEY2` builds in /tmp, not committed) — green, proves the harness isn't key-locked and OT crypto works across datasets.
- **34-verify-thread-gw:** green with live gateway (`go build` → `:5095`, guest TX → room → peer).
- **38 multihop (BLOCKED, documented in-file):** C6 leader + C6B router + H2 child via router (firewalled C↔A). B (healthy C6) retries Parent Reqs every 750ms with fresh challenges, deterministically invalidating A's ~700ms in-flight response (challenge race; H2 wins 37 by accident — dead loop never retries). Tried: latest-wins, in-flight pause, optimistic hold, pump gating/windowing. Needs StartAt shim (proper waits) or OT-side stable retries. H2/C5 loops die fast (tick decay) so only C6 can route; two C6s need distinct EUIs (OT ignores base-MAC override, uses per-build random — C6 vs C6B draws differ, no collision).
- **MLE wire (host-decrypted via CTR crib):** Parent Req = cmd 09 + Mode + Challenge(8) + ScanMask + Version; ScanMask 0x80 (routers) confirmed — A must answer (and does, when timers/challenges align).

---

## 3. What has been done (state @ ef37025, all suites green)

### 3.1 Legacy I2C cmd-link — live on all 5 chips
`shim_idf_i2c_cmd_begin()` walks the real 20B node list (mode=`w0>>11`: 6/2/1/3, next@+16), merges consecutive WRITEs into one `W`, re-walks read runs for one `R`. Fits 582B. `27-verify` #3 asserts `cmdlink rc=0 got=DEADBE`. Multi-chip C6/H2/P4/C5 via `IDFI2CLegacyDemo`.

### 3.2 MicroPython v1.29.0 — live on all 5 chips
Prebuilts `ESP32_GENERIC_*` under `samples/mpy/` (`*.bin` + `*.elf`) plus **composed flashes** `mpy_*_flash.bin` for P4/C5 (see `spike/mk_mpy_p4c5.py`). Driven over UART0 by `spike/mpy_repl.mjs` (`bootMpy`/`replExec`/`calibrateGpioLive`: two-Pin co-movement + masked s0 check + ENABLE-adjacency + empirical IN sweep). `30-verify-mpy` asserts banner + `print` + `writeto/readfrom/readfrom_mem/scan([104])` + SPI XOR + GPIO + ADC (2048→32776 via Taylor) + PWM. P4: `bootMpy({binPath:'mpy_p4_flash.bin'})`, ADC Pin16→ch0, GPIO low-pins only. C5: Pin3→ch2, prints benign `mmap` lines.

### 3.3 BLE — host live on all BLE chips + fabricated peer

- **VHCI (C3):** `esp_vhci_host_register_callback` returns ESP_OK, `esp_vhci_host_send_packet` trampolines sharing one body parked at `init+96`, re-give VHCI sem per packet, snippet struct-vs-function callbacks, controller answers with full-length `0x1002/0x1003/0xfc01/0x2018`.
- **LL-transport (C6/H2/C5):** `r_ble_hci_trans_cfg_hs`→`ret0`, radio callees stubbed whole, `r_sdkconfig_get_opts`→pristine-zero, `ble_transport_alloc_cmd`→static 264B, scan/duplicate stubs, command redirect `ble_transport_to_ll_cmd_impl`→parked `llCmdPark` in dead `r_ble_ll_init` (emits `0x01`-prefixed `B`, polls mirror, `recv_cb(4, evtbuf)`; buffer lives in mirror, sem takes C.J→success). `acl-tx` mbuf-chain walk (`core/ble_shims.mjs:651 llAclPrint`) + free afterwards.
- **Fabricated peer:** §5 of `25-verify-hci.mjs` plus console bridge (`25-verify-hci.mjs` §4 `!hello`→`console-notify`). VHCI injector `vhciInjectPark` (`core/ble_shims.mjs:86`, gated on `esp_vhci_host_send_packet && !ble_transport_host_recv_cb`) routes C3 flat events/ACL into the registered host callback; LL uses `j recv_cb`. Sketch pool `bleNetPoolInit` (C6/H2/C5: `r_mem_malloc_mbufpkt_pool` 32×160 + `mp_flags|=0x02`; C3: `os_mempool_init`+`os_mbuf_pool_init`+`os_msys_register` + `ble_emu_scratch` arena). Host tap harvest fixed `>10`→`>=10` (Write Response is exactly 10B).
- **Bumble PoC:** see §9.

### 3.4 WiFi — E2E via gateway

Native emulator glue (`pkg/esp_emu.js:209 set_wifi_config / wifi_rx_push / wifi_tx_drain`, raw frames: `wifi_tx_drain()` batches are `u32-LE-len`+bytes, split one-per-WS message). **Gateway-wired** (`openhw-studio-gateway` on `ws://HOST:5095/api/network-gateway`): gVisor NAT, DHCP intercepted (192.168.4.x), ARP must be answered, pump event loop, route-dependent egress. `31-verify-wifi` spawns local HTTP/HTTPS/MQTT servers per attempt and passes `URLBASE`.

### 3.5 Loader + image robustness

- Per-hook try/catch in `core/esp32c3.mjs` forge loop (one ROM-absolute/XIP-missing hook warns instead of nuking the patch set).
- `EspImage` handles `0x10000` and `0x100000` app bases + checksum+SHA reseal; `relocateShimsForChip` handles UART/SPI/I2C bases; `prepareBleShims` shape-asserts every patch.
- Header-preserving `python3 spike/gen_spi_shims.py` (source of truth is `shims.mjs`).
- Per-instance WASM modules (`core/esp32c3.mjs:82 wasmInstanceCounter`).

### 3.6 Earlier waves (still true)

C5 bring-up (22/22, no TWAI/VHCI), S31 ROM smoke, IDF SPI/v5, Touch/DAC/SDMMC/Camera/LCD, timers/WDT/RTC/LittleFS/NVS, USB-Serial/JTAG C3. See `PROTOCOLS.md` tables.

---

## 4. Repo map (files that matter)

```
README.md / AGENT.md / PROTOCOLS.md (per-chip/ per-protocol matrix)
BLE-OBSERVABILITY.md / openhw-studio-gateway/ESP-EMU-INTEGRATION.md  (gateway contract + BLE/Thread/Matter)
issue.md (5 items; 1 + 3 + 5 resolved-locally with asks, 2 resolved, 4 blocked)

app.js / worker.js / index.html           browser UI + WASM worker (WiFi/BLE/thread gateways)
core/esp32c3.mjs        headless SDK (create/loadFirmware/step + controllers; WASM isolation)
core/{gpio,i2c,spi,adc,pwm,i2s,twai,touch,dac,sdmmc,camera,lcd,uart,ble_* ,rvasm}.mjs
reply_queue.mjs         16B dribbler

elf.mjs                 ELF + HOOK_TARGETS (arduino/idf/mp tiers) + planHooks + prepare*Shims
espimage.mjs            flash app-image surgery + reseal (0x10000 + 0x100000)
shims.mjs               RV32 bytes + bases + relocateShimsForChip
peripherals.mjs         virtual devices
spike/gen_spi_shims.py  shim assembler

samples/                prebuilt .merged.bin + .elf (top-level + c5/c6/h2/p4)
samples/mpy/            MPY v1.29.0 .bin+.elf per chip + composed flashes mpy_*_flash.bin
spike/mpy_repl.mjs      MP REPL harness (bootMpy/replExec/calibrateGpioLive)
spike/mk_mpy_p4c5.py    composes P4/C5 bootable flashes (bootloader + factory + SHA)
pkg/esp_emu.{js,wasm}   0.42.0 (pkg.prev 0.41.0, pkg.prev-0.39 kept)

Spike suites (all green on ef37025):
  18-verify-all.mjs     C3 15 (all protocols)               24-verify-new.mjs  C3 5 virtual
  25-verify-hci.mjs     HCI unit + direct x2 + BLEDemo health + §4 bridge + §5 fabricated peer (all BLE chips)
  26-verify-native.mjs  C3 5 native (Timer/WDT/RTC/LittleFS/NVS)
  27-verify-idf.mjs     C3 IDF SPI+I2C-v5+legacy+USB         21/22/23/28  C6/H2/P4/C5 per-chip (incl. cmd-link)
  29-verify-s31.mjs     S31 ROM/banner/chip-ID smoke         30-verify-mpy.mjs MPY all 5 chips
  31-verify-wifi.mjs    C3 WiFi E2E (DHCP+HTTP+HTTPS+MQTT via gateway)
  32-verify-thread.mjs  C6/H2/C5 Thread Phase 1b+1c (scans + beacons)
  33-verify-ble-pump.mjs HCI pump unit (local/forward/gaps/ACL/fallback)
  34-verify-thread-gw.mjs Thread GW E2E (guest TX → room → peer, SKIP-gated)
  35-verify-thread-inject.mjs Thread RX injection (host-staged beacons, all 3 chips)
  36-verify-thread-multi.mjs Thread multi-node relay (C6 TX → relay → H2 report)
  ble/bumble_hci_poc.py + ble_bumble_fwd.mjs  (Bumble PoC)
  ble_inspector.test.mjs / peripheral_inspector.test.mjs
  sketches/ThreadDemo/  OT bring-up probe (for 15.4 roadmap)
  sketches/WiFiDemo/    WiFi E2E sketch (HTTP+TLS+MQTT)
  sketches/{BLEDemo,BLEDetect,BLETest}  (enriched for BLE obs)

openhw-studio-gateway/  Go gateway (gVisor + ble/thread rooms; UNTACKED here, lives on dish)
```

---

## 5. How to compile and test (copy-paste)

### 5.1 Prerequisites

```bash
arduino-cli version   # 1.5.1+; core esp32:esp32 3.3.10
python3 --version     # 3.14 tested (for serve.py + mk_mpy)
go version            # 1.26 for the gateway (optional unless you touch it)
node --version        # v22
I2C state proper: install esptool for header/SHA tooling if you touch images (not needed for suites)
# isolated TMPDIR avoids PyInstaller collisions in sandboxes:
export TMPDIR=/tmp/isolated_path; mkdir -p /tmp/isolated_path
```

### 5.2 Compile (Arduino) + refresh samples

```bash
# Single sketch / chip
arduino-cli compile --fqbn esp32:esp32:esp32c3 spike/sketches/TouchDemo \
  --build-path /tmp/build

# Per chip (C6 example); C5 skips TWAI/VHCI; S31 has NO toolchain
for s in TouchDemo DACDemo SDMMCDemo CameraDemo LCDDemo IDFSPIDemo IDFI2CDemo IDFI2CLegacyDemo TimerDemo WDTDemo RTCDemo LittleFSDemo NVSDemo BLEDemo BLEDetect BLETest; do
  arduino-cli compile --fqbn esp32:esp32:esp32c6 spike/sketches/$s \
    --build-path /tmp/build_$s
done

# MicroPython composed flashes (do this once; outputs are checked in):
python3 spike/mk_mpy_p4c5.py   # writes samples/mpy/mpy_{p4,c5}_flash.bin

# WiFiDemo (for 31-verify):
arduino-cli compile --fqbn esp32:esp32:esp32c3 spike/sketches/WiFiDemo --build-path /tmp/wifibuild
cp /tmp/wifibuild/WiFiDemo.ino.merged.bin samples/wifidemo.merged.bin
cp /tmp/wifibuild/WiFiDemo.ino.elf         samples/wifidemo.elf
chmod 755 samples/wifidemo.elf

# ThreadDemo (probe only, optional):
arduino-cli compile --fqbn esp32:esp32:esp32c6 spike/sketches/ThreadDemo --build-path /tmp/thrbuild

# Refresh what verifiers load (your current workflow keeps samples/ in sync
# by hand; C3 top-level + per-chip c5/c6/h2/p4 dirs):
# Example BLEDemo:
for chip in esp32c3 esp32c6 esp32h2 esp32c5; do
  short=${chip#esp32}
  arduino-cli compile --fqbn esp32:esp32:$chip --build-path /tmp/blebuild_$chip spike/sketches/BLEDemo/BLEDemo.ino
  cp /tmp/blebuild_$chip/BLEDemo.ino.{elf,merged.bin,bin,bootloader.bin,partitions.bin,map} spike/sketches/BLEDemo/build/esp32.esp32.$chip/
  [ "$chip" != "esp32c3" ] && cp /tmp/blebuild_$chip/BLEDemo.ino.{elf,merged.bin,bin,bootloader.bin,partitions.bin,map} spike/sketches/BLEDemo/build_esp32$short/
done
```

Regenerate shims after editing `spike/gen_spi_shims.py` (run from repo root; preserves `shims.mjs` header):
```bash
python3 spike/gen_spi_shims.py
```

### 5.3 Test (headless, all real firmware)

**Batch size:** always `mcu.step(100000)` (H2/P4 drop UART tails on smaller batches — `AGENT.md:6`).

```bash
node spike/18-verify-all.mjs      # C3: 15 tests
node spike/24-verify-new.mjs      # C3: 5 virtual (Touch/DAC/SDMMC/Camera/LCD)
node spike/25-verify-hci.mjs      # C3: HCI unit + direct x2 + BLEDemo health + §4 bridge + §5 fabricated peer (all BLE chips)
node spike/26-verify-native.mjs   # C3: 5 native (Timer/WDT/RTC/LittleFS/NVS)
node spike/27-verify-idf.mjs      # C3: IDF SPI + I2C-v5 + legacy (incl. cmd-link) + USB

node spike/21-verify-c6.mjs       # C6: 18 demos
node spike/22-verify-h2.mjs       # H2: 18 demos (needs per-instance wasm fix)
node spike/23-verify-p4.mjs       # P4: 18 demos
node spike/28-verify-c5.mjs       # C5: 22 (no TWAI on silicon)
node spike/29-verify-s31.mjs      # S31: smoke

node spike/30-verify-mpy.mjs      # MPY: REPL+I2C+SPI+GPIO+ADC+PWM on C3/C6/H2/C5/P4
# 30-verify details: P4 ADC on GPIO16+(Pin16→ch0); low GPIOs for direction;
# C5 prints benign mmap lines; WiFi to go below.

node spike/32-verify-thread.mjs   # Thread Phase 1b+1c (C6/H2/C5 scans + beacons)
node spike/35-verify-thread-inject.mjs  # Thread Phase 1d RX injection (all 3 chips)
node spike/36-verify-thread-multi.mjs   # Thread multi-node relay (C6 -> H2)
node spike/33-verify-ble-pump.mjs # HCI pump unit (no gateway needed)

# WiFi — needs the gateway on ws://127.0.0.1:5095 (or GW_URL=...):
GW_URL=ws://127.0.0.1:5095/api/network-gateway node spike/31-verify-wifi.mjs
# Spawns local HTTP:18081 + HTTPS:18443 (self-signed) + MQTT:1885 brokers,
# passes URLBASE <hostIP> to the sketch, best-of-5 per-protocol. SKIP if no
# gateway (exit 0). Public-internet egress proven separately (example.com 200).

node spike/ble_inspector.test.mjs          # 53 assertions
node spike/peripheral_inspector.test.mjs   # 20 assertions

# BLE-over-Bumble PoC (needs `pip install bumble`):
python3 spike/bumble_hci_poc.py > /tmp/bumble.log 2>&1 &
sleep 3; node spike/ble_bumble_fwd.mjs     # expect BUMBLE-BACKED BRING-UP: PASS
```

Gateway (for WiFi/BLE PoC; otherwise suites skip):
```bash
# In openhw-studio-gateway/ (untracked sibling):
GW_PORT=5095 go run .          # default is 5095 since 2026-09-10; GW_PORT env overrides
# or: go build -o /tmp/gw5095-test . && GW_PORT=5095 /tmp/gw5095-test
```

### 5.4 Observe (CLIs that prove the monitor pipeline)

```bash
node spike/observe_ble.mjs BLEDemo --hci
node spike/observe_ble.mjs BLETest --hci
node spike/observe_peripheral.mjs idfspi
python3 serve.py 8080  # browser: http://localhost:8080
```

### 5.5 Browser

```bash
python3 serve.py 8080
# open http://localhost:8080 — Load Demo Firmware, watch OLED/TFT/NeoPixel/I2S + GPIO + BLE/Peripheral monitors + A/B Compare
```

### 5.6 One-liner (full regression)

```bash
node spike/ble_inspector.test.mjs && node spike/peripheral_inspector.test.mjs \
&& node spike/18-verify-all.mjs && node spike/24-verify-new.mjs \
&& node spike/25-verify-hci.mjs && node spike/26-verify-native.mjs \
&& node spike/27-verify-idf.mjs \
&& node spike/21-verify-c6.mjs && node spike/22-verify-h2.mjs \
&& node spike/23-verify-p4.mjs && node spike/28-verify-c5.mjs \
&& node spike/29-verify-s31.mjs && node spike/30-verify-mpy.mjs \
&& GW_URL=ws://127.0.0.1:5095/api/network-gateway node spike/31-verify-wifi.mjs
# Expected: parsers + all per-chip suites + WiFi E2E.
# Gateway-gated: 31-verify skips (exit 0) if the gateway isn't running.
```

---

## 6. Gotchas to keep in mind

1. **Mask discipline:** every reply-polling shim MUST `_mask_uart`/`_unmask_uart` on every exit (ISR would steal `uart_input` bytes mid-poll and spin forever — proven`t0==RA` fault). No unmasked additions.
2. **Frame-kind collisions:** `P` was taken by PWM; I2C probe uses `Q`. Check `core/uart.mjs` + `PROTOCOLS.md` table before adding kinds.
3. **ABI shapes differ:** Arduino `analogRead` returns in a0; IDF `adc_oneshot_read` stores to `*a2` (ESP_OK). Same wire, different epilogue.
4. **Per-chip bases:** `relocateShimsForChip` handles UART/SPI/I2C; GPIO OUT/EN/IN offsets probed live (`calibrateGpioLive`). C3 `0x3fc94000` sits inside `.data` on newer layouts — `ble_emu_scratch` solves it.
5. **GPIO calibration:** zero-heuristic never matches UART0-active firmware; use live two-Pin co-movement + ENABLE-adjacency + IN sweep. Never seed across instances. P4 GPIO IS modeled but `Pin(16+)` never sets ENABLE — use low pins for direction.
6. **MP quirks pinned in 30-verify:** H2 USB pins (no GPIO6/7), H2 ADC GPIO3→CH2, C6/H2/C5/C5/P4 16-bit LEDC→14-bit saturate(16383), `duty_u16(65535)` bumps, `read_u16` Taylor (2048→32776). P4 ADC on GPIO16+; P4/C5 composed flashes (see `spike/mk_mpy_p4c5.py`).
7. **P4/C5 Arduino layouts** put app0 at `0x100000` but emulator boots from `0x10000` with vestigial partition table — MPY composition uses factory enlarged to `0x1F0000` + SHA re-seal for P4 max-rev fix.
8. **Gateway wire rules (`openhw-studio-gateway/ESP-EMU-INTEGRATION.md`):** one raw frame per WS message (no len prefix), must answer ARP for own IP, gVisor vs DHCP intercept (`192.168.4.x`), pump event loop (`setImmediate`), egress is host-dependent — retry whole flows. Default port **5095** (`GW_PORT` env).
9. **WASM per-instance:** `core/esp32c3.mjs` isolates heaps per `create()`; don't remove `?instance=N` (H2 0.42 regression).
10. **Bulk RX + shared-mem rendezvous:** `reply_queue.mjs` dribbles 16B/batch + pump silent batches; BLE events prefer the mirror (`core/ble_mirror.mjs`).
11. **Build outputs:** `spike/sketches/**/build/esp32.esp32.esp32c3/` for C3 IDF; `build_<chip>/` elsewhere — don't mix when copying to `samples/`.

---

## 7. What's left (honest)

| Status | Item | Next step |
|---|---|---|
| ✅ done | Legacy I2C cmd-link (all chips), MPY all 5 chips (REPL+I2C+SPI+GPIO+ADC+PWM), WiFi E2E (HTTP+HTTPS+MQTT), BLE host live + fabricated peer (all BLE chips) + Bumble PoC, loader/WASM isolation, Thread full scan flow + fabricated beacons + RX injection + multi-node relay + two-node attach (C6 Leader + H2 Child) on C6/H2/C5 | — |
| 🟡 next: commission/join | **802.15.4 / Thread radio** | Scans + beacons + injection + relay + attach green (32/34/35/36/37). Still open: commissioning/join flows (datasets beyond the static test key) |
| 🟡 pump, radio open | **Web HCI pump + real Bumble radio** | Pump + toggle landed (33 green). Still open: USB dongle / `vhci_bridge.py` + root for phone-in-the-loop |
| 🟡 split, unrun | **CI** | `verify.yml` split 7 ways (wifi SKIP-gated, bumble non-blocking). Still to do: run it through on GitHub |
| ❌† | **Ethernet (WASM)** | No `eth_rx_push`/`eth_tx_drain` exports; native CLI has `--net tap/user` + `--thread-sim` localhost UDP bridge |
| ❌† | **C6 multi-instance flake** | Mitigated by 3× retry in `21/22/23-verify`; see `issue.md` #3 |
| ❌† | **S31 firmware** | No Arduino/IDF toolchain can target S31; shim bases unverified |
| 📝 | **File the upstream issues** | Needs human GitHub auth (no `gh` here) — `issue.md` packet is ready |

Matter: needs Thread-operational (above) or WiFi-operational (works) + BLE commissioning (BTP GATT over fabricated peer — unexplored) + commissioner (no `chip-tool` here).

**Suggested next work (ranked):**
1. **Thread commissioning/join:** datasets beyond the static test key (attach itself is green via relay with real OT stacks, no host crypto).
2. **Real Bumble radio** (USB dongle or `vhci_bridge.py` + root) for phone-in-the-loop (pump + toggle already landed).
3. **Run the split CI** on GitHub (wifi SKIP-gated, bumble non-blocking).
4. **Ethernet WASM glue** (if the native CLI path is worth porting).

---

## 8. WASM upkeep notes

- 0.42.0 intake done (`pkg.prev/` keeps 0.41.0, `pkg.prev-0.39` kept). Next drop: re-run full battery, `grep -n "^    [a-z_]*(" pkg/esp_emu.js` for new exports (BLE HCI / 802.15.4 / Ethernet / USB would flip ❌ rows), keep old `pkg/` in `pkg.prev/`.
- `CHIP_GPIO_COUNT` + badge (`app.js`/`index.html`), ROM override, dropdown option, `samples/<chip>/` + verify suite per new chip.
- `spike/sketches/ThreadDemo/` is the 15.4 bring-up fixture (kept for next phase even though its radio is currently a no-op).

---

## 9. Handy file list with the fix you will touch next

- `core/ble_shims.mjs` (+ `core/rvasm.mjs`, `core/ble_controller.mjs`, `core/ble_mirror.mjs`, `core/uart.mjs:113 B case`) — all BLE HCI routing.
- `core/esp32c3.mjs:82,182` — WASM isolation + `prepareBleShims`/`prepareIdfShims` glue.
- `spike/gen_spi_shims.py:745 shim_idf_i2c_probe_ops` — I2C probe `Q` frame.
- `spike/mpy_repl.mjs:53 calibrateGpioLive` — GPIO discovery; `spike/mk_mpy_p4c5.py` — P4/C5 boot composition.
- `spike/31-verify-wifi.mjs` + `spike/mqtt_broker.mjs` + `spike/sketches/WiFiDemo/WiFiDemo.ino` — WiFi E2E.
- `spike/bumble_hci_poc.py` / `spike/ble_bumble_fwd.mjs` — BLE-real-stack PoC.
- `spike/sketches/ThreadDemo/ThreadDemo.ino` — Thread probe (Phase 1b live: energy in setup, active retried from loop; 1c target = beacon RxDone).
- `core/thread_{shims,controller}.mjs` + `spike/32-verify-thread.mjs` + `spike/34-verify-thread-gw.mjs` + `spike/35-verify-thread-inject.mjs` + `spike/36-verify-thread-multi.mjs` + `samples/threaddemo_{c6,h2,c5}.*` — Thread Phase 1b+1c+1d.
- `core/ble_hci_pump.mjs` + `spike/33-verify-ble-pump.mjs` — HCI pump (worker + headless).
- `openhw-studio-gateway/ESP-EMU-INTEGRATION.md` — gateway contract (don't edit gateway source for esp-emu fixes).

Good luck — the repo is in a clean, all-green state on `ef37025`. Keep bisecting with the harness scripts; they are the source of truth, not the docs.
