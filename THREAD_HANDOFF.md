# THREAD HANDOFF — esp-emu Thread attach / multihop (2026-09-15)

> Fresh-agent entry point. Read this + `HANDOVER.md` §2 Waves E–J, then run the green suites before touching anything.
> Repo: `/home/danish1075/Documents/espc3 wasm` — branch `main` @ `224ed2c`, clean vs `origin/main`.
> Scope of this file: Thread 802.15.4 virtual-radio + attach/multihop only. For BLE/WiFi/MPY/GPIO see `HANDOVER.md` §3.

---

## 1. TL;DR (30 seconds)

1. Two-node Thread attach is GREEN: `spike/37-verify-thread-attach.mjs` — C6 Leader + H2 Child (role=2) via harness relay, real OT stacks both ends, no host crypto.
2. Dataset agility is GREEN: `spike/39-verify-thread-key2.mjs` — same flow with reversed network key (`THREAD_KEY2` /tmp builds).
3. Gateway E2E is GREEN: `spike/34-verify-thread-gw.mjs` with live Go gateway on `:5095` (guest TX → room → peer).
4. Scan/inject/multi are GREEN: `32` (energy+active+beacons), `35` (RX injection C6/H2/C5), `36` (C6 TX → relay → H2 report).
5. Three-node multihop is BLOCKED (not failed): `spike/38-verify-thread-multihop.mjs` — C6 leader + C6B router + H2 child via router, A↔C firewalled. Healthy C6-B retries Parent Reqs every ~750 ms with fresh challenges, deterministically invalidating A's ~700 ms in-flight Parent Response (challenge race). H2 wins 37 only by accident (its loop is half-dead, never retries).
6. Root fix hypothesis: real `otPlatAlarmMilliStartAt` programs a dead FRC/esp_timer, so the OT attacher never actually waits — retries are event-driven spam. A StartAt shim (record deadline LP + return OK) was built, regressed 37 (timing shift), and reverted with a note in `core/thread_shims.mjs`. Next agent should retry it more carefully (see §9.1).
7. Samples in `samples/threaddemo_{c6,h2,c5,c6b}.*` are current (rebuilt 2026-09-11). Key2 builds live only in `/tmp/thrbuild_{c6,h2}k2/` (NOT committed — rebuild with `-DTHREAD_KEY2`).
8. Sketch is `spike/sketches/ThreadDemo/ThreadDemo.ino` (alarm pump + rescan probe + diag + upgrade hooks + pump gating). Rebuild after ANY sketch edit, else verifiers test stale binaries.

---

## 2. Repo map (Thread-relevant files only)

```
core/thread_shims.mjs          # RV32I radio parks (THE file: ~1000 lines, see §4)
core/thread_controller.mjs     # host-side TX/scan tap log (G/H frames, frame.n cursors)
core/esp32c3.mjs               # MCU class, loadFirmware + shim application
core/uart.mjs                  # G/H frame routing
elf.mjs                        # symbol resolve + vaddr map
espimage.mjs                   # flash surgery (writeAtVaddr + reseal)
shims.mjs                      # I2C_CELL_BASE etc (HP bases; LP split lives in thread_shims)
index.mjs                      # SDK re-export (ESP32C3.create({chip}))
spike/sketches/ThreadDemo/ThreadDemo.ino   # OT bring-up + alarm pump + hooks
spike/32-verify-thread.mjs     # Phase 1b+1c: energy + active + fabricated beacons (57 asserts)
spike/33-verify-ble-pump.mjs   # BLE pump (unrelated, keep green)
spike/34-verify-thread-gw.mjs  # gateway E2E (SKIP-gated without live gw)
spike/35-verify-thread-inject.mjs  # host-staged beacon delivery C6/H2/C5
spike/36-verify-thread-multi.mjs   # C6 TX → relay → H2 report
spike/37-verify-thread-attach.mjs  # 2-node attach C6+H2 (SELF-RETRYING, see §6)
spike/37b-verify-thread-attach-b.mjs # C6+C6B variant probe (fails: challenge race)
spike/38-verify-thread-multihop.mjs  # 3-node firewalled (BLOCKED, see §7)
spike/39-verify-thread-key2.mjs      # 2-node attach, reversed key (/tmp builds)
spike/probe-*.mjs              # one-off debug probes (crib, decrypt, youngA, copy, ...)
samples/threaddemo_c6.*        # C6 stock (leader/A; also 38's A)
samples/threaddemo_h2.*        # H2 stock (37's B; no upgrade hook)
samples/threaddemo_c5.*        # C5 stock (C5-gated upgrade hook present)
samples/threaddemo_c6b.*       # C6 + -DTHREAD_NODE_B (38's B: slow timers, upgrade hook)
HANDOVER.md                    # canonical repo handover (Waves A–J)
THREAD_HANDOFF.md              # THIS file (Thread continuation focus)
```

---

## 3. Git state (what is committed, what is not)

- HEAD `224ed2c` — "chore: drop StartAt shim remnant, note timing regression".
- `e3673dc` — multihop race trials + C6B pump/loop variants.
- `914dca5` — multihop probe trials + pump gating + C6B samples.
- `24b5044` — key2 agility (39 green) + gateway E2E (34 green) + 38 blocked.
- `55c7de6` — multihop WIP + alarm pump + wedge fixes + C5/C6B samples.
- `5018107` — two-node attach + full radio bring-up stack.
- Working tree is CLEAN (this handoff adds only `THREAD_HANDOFF.md`).
- Remote `origin/main` is in sync (pushed with keepalive SSH; large ELF pushes need `GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30 ..."`).
- Key2 `/tmp/thrbuild_{c6,h2}k2/` builds are EPHEMERAL — rebuild, never commit (see §8).

---

## 4. Virtual radio architecture (read before editing shims)

### 4.1 Big picture

- Principle: zero guest modifications. Unmodified Arduino OT binaries; ELFs used only for load-time symbol patching.
- Shims are pure RV32I (`addi/lui/slli/srli/andi/or/lw/sw/sb/bne/beq/jalr`) — same bytes on all cores.
- UART0 FIFO at `0x60000000` carries APC frames: `G<ch><len><psdu nibbles>` (TX tap), `H<ch>` (energy-scan tap). Nibble-encoded (`'a'+nibble`) because UART→JS is UTF-8.
- `core/thread_controller.mjs` logs every TX as `{n, channel, len, psdu}`. `n` is the ABSOLUTE sequence — relay cursors MUST use `f.n`, never array indices (frames[] is a 256-cap ring; indices shift).
- No reply polling anywhere; FRAME DISCIPLINE: chained parks must leave exactly the frames their downstream epilogue pops.

### 4.2 Hooked symbols (`THREAD_HOOKS` in `core/thread_shims.mjs`)

- `esp_ieee802154_enable/disable` → ret0 (real driver starves: "No free interrupt inputs for ZB_MAC").
- `otPlatRadioReceive` → ret0.
- `otPlatRadioGetState` → `j getstatePark` (WEAK 6B stub; always reports RECEIVE=2).
- `otPlatRadioTransmit` → `j` to main shim at +0x5A (`TX_MAIN_OFF=90`; ALL MAC traffic enters via Radio::Transmit tail-jump there).
- `otPlatRadioEnergyScan` → `j energyPark` (emits `H`, sets pending flag, returns — NEVER completes synchronously; sync completion wedges SubMac at state 5 → `mac_links.hpp:536` assert; root-caused by disassembly).
- `otPlatRadioTxDone / EnergyScanDone / ReceiveDone` — callee targets, never hooked.
- `ieee802154_mac_init` (266B, dead — only caller esp-enable is stubbed) hosts energyPark + getstatePark + copySub.
- `ieee802154_transmit` (250B IRAM, dead) hosts emitSub + inboundPark.
- `ieee802154_transmit_at` (254B IRAM, dead) hosts beaconPark.
- `otPlatAlarmMilliGetNow` (32B) → inline-hooked to dead-box `alarmNowPark` (returns `xTaskGetTickCount()`; ticks are alive, FRC/esp_timer ISR is starved dead).
- `esp_ieee802154_enh_ack_generator` (436B) else `receive_done` (344B) = the roomy dead LL IRAM box hosting deliverPark + copySub + alarmNowPark + inbound2Park (absolute `li`+`jalr` links; flash↔IRAM ~24 MB, JAL impossible).
- `otPlatAlarmMilliStartAt/Stop` are NOT hooked (deliberate; see §9.1).

### 4.3 Parks (what each does)

- `emitSub` — G-frame leaf (`jal ra,emit`); a0/a1 read-only, t-regs only.
- `txMainProg` — at Transmit+0x5A: save ra/s0/a0/a1, s0=TX channel, emit, TxDone(instance,frame,NULL,NONE), then FRAME-TYPE GATE (see §4.4), jump to inboundPark (scan) or inbound2Park (MLE).
- `energyPark` — emit `H<ch>`, flag=1, ret0.
- `getstatePark` — if flag: clear + EnergyScanDone(instance,-60); conditional-init inbound slot ONCE (magic+len0+mPsdu; never clobbers live, never resurrects consumed); idle-delivery hop → deliverPark if staged (returns); always RECEIVE. Saves/restores a0 across EnergyScanDone (its return value clobbers the instance pointer → Mac-borrow-from-garbage fault if skipped).
- `copySub` — word-copy 40 words (160B struct+psdu) slot→rxBase. Baked addresses, leaf (T1/T2/T3 only; caller's T0/a0 survive).
- `inboundPark` (transmit box, after emit) — staged? (magic + len≠0 + mPsdu==slot+32) → copy, consume (clear magic+len), ReceiveDone(rxBase), double-pop return to SubMac. Else pop-own-frame → beaconPark. Has mPsdu phantom gate.
- `inbound2Park` (dead box) — same as inbound but NO beacon fallback: empty → clean single-return (pop own + txMain's). Used for MLE-data TXs only.
- `beaconPark` (transmit_at box) — crafts 23B beacon (FCF 0xD000, seq 0x5A, PAN 0x1234, ext C4:22:…, superframe 0x00FF, payload FF 0F 00 00, FCS pad) + full otRadioFrame in scratch, ReceiveDone, double-pop. ALSO plants the LP mirror anchor (+0x200, idempotent) for per-run JS LP discovery.
- `deliverPark` (dead box) — GetState-hop idle delivery WITHOUT a transmit (silent nodes never TX again). Own frame, single-pop return to getstate hop. FCF gate (beacons held unless Mac+1==1 dwelling; data/commands eager), mPsdu gate (phantoms held pristine, never consumed), NO Mac borrow (natural state correct for data; borrow poisons data), fixes copied struct's mPsdu to the LP copy, delivery-counter++ at LP+0x28.
- `alarmNowPark` (dead box) — `xTaskGetTickCount()` passthrough as alarm timebase.

### 4.4 Frame-type gate (the SubMac-busy wedge fix)

- Fabricated beacons on MLE-data TXs wedge SubMac busy forever (rescans rc=5 BUSY, TX frozen; proven by no-beacon-stub unblocking retries/election/ads).
- txMain double-derefs the TX frame (`frame→mPsdu→FCF`), masks type: 3 (MAC-command = beacon req) → scan path (dwell borrow + inboundPark + beacon fallback); 1 (data = MLE) → inbound2Park (never a beacon).
- Scan path keeps the dwell borrow (Mac+1==1; nested-TX delivery runs before OT advances it). MLE path has no borrow.

### 4.5 Scratch split (coherence vs heap — hard-won)

- HP I2C cell `0x40820000`: JS↔guest COHERENT on all chips (proven by 35/36) but HEAP-OWNED (slot eaten by 60k-step runs; staging into live heap poisoned MLD with beacon bytes at tx=0).
- LP SRAM `0x50000000` (shared C6/H2/C5; heap-excluded by capability): park-RW reliable everywhere, but JS→guest staging UNRELIABLE on H2 (Bdel freeze / A2solo del=0 with live polls; C6 fine).
- Split: staging slot HP+0x180 on H2/C5 (transient ≤ poll period, fail-closed gates), LP+0x180 on C6 (per-chip `slotAddrFor`; separate MCU instances never share memory). Delivery scratch rxBase LP+0x100, counter LP+0x28, LP mirror LP+0x200 (clear of copySub's LP+0x100+160B blast radius ending 0x1A0). Flag HP+0x20 (clobber-harmless: spurious EnergyScanDone, tolerated).
- `slotAddrFor(chip)`: `esp32c6 → LP+0x180`, else HP+0x180. Verifiers mirror this via `HOME` map + `guestFor/mpsduFor`.

### 4.6 Telemetry (how to observe without guessing)

- `deliveries(mcu)`: LP delivery counter via LP mirror scan (magic + LP mPsdu `0x50000220`, counter at mirror−0x1d8). Proves consumption vs staging. NOTE: mirror is flaky under heap pressure (comes and goes); −1 means "not found", not "zero".
- Slot inspect: `findSlot` (magic + len0 + mPsdu match; rejects heap phantoms) → lin; read len@+4, magic@+160.
- Sketch `[THREAD] diag heap=… tick=… etime=… now=…` every 2nd loop: heap stable (~362K C6), ticks+etime march, `now`==tick (proves GetNow shim live).
- Rescan probe (`rescan-start rc=`): rc=0 alive, rc=5 BUSY wedged.
- `Adel/Bdel` in 37/38 round prints = LP delivery counters per node.

---

## 5. Sketch (`spike/sketches/ThreadDemo/ThreadDemo.ino`, 177 lines)

- `provisionThreadNetwork()`: `initNew()` + name ESP-EMU + extpan 1122334455667788 + key 0011…EEFF (or reversed under `THREAD_KEY2`) + ch15 + pan 0x1234 → commit. Always passes validation (starts from a complete dataset).
- `setup()`: begin(false) (no NVS autoload) → link-enable → raw driver probe → energy scan (callback sets flag) → dataset commit → netif up → thread start.
- `loop()`: pump `otPlatAlarmMilliFired()` EVERY iteration (except C6B-gated half-rate: `(n%2)==0`); poll GetState (drives deferred energy completion); print role/radio/diag every 2nd; first energy-done → active scan; C6/C5-gated immediate `otThreadBecomeRouter()` on first poll as child (38 hook; H2 never trips it, so 37 pins role 2); rescan probe every 50th; `delay(100)` (fast).
- `THREAD_NODE_B` (`-DTHREAD_NODE_B`, C6B binary only): half-rate alarm pump + (historically) slow loop trials — current build keeps fast loop + half-rate pump. 37/39 never use C6B.
- `THREAD_KEY2` (`-DTHREAD_KEY2`, /tmp builds only): reversed key. Never commit these binaries.
- Rebuild matrix (isolated TMPDIR; see §11 commands): stock C6/H2/C5 → `samples/`; C6B (`-DTHREAD_NODE_B`) → `samples/threaddemo_c6b.*`; key2 (`-DTHREAD_KEY2`) → `/tmp/thrbuild_{c6,h2}k2/` only.
- Gotchas: `vTaskSuspendAll` around Fired DEADLOCKS boot (roles stuck 0,1 + Guru); `esp_base_mac_addr_set` EUI override is IGNORED by OT (per-build random EUIs differ anyway) and may poison MAC — removed; `otPlatAlarmFired` does not exist (it's `otPlatAlarmMilliFired`).

---

## 6. Verifier matrix (status + how to run)

| # | File | What | Status |
|---|------|------|--------|
| 32 | `spike/32-verify-thread.mjs` | energy + active + fabricated beacons, 57 asserts, C6/H2/C5 | GREEN |
| 33 | `spike/33-verify-ble-pump.mjs` | BLE pump (unrelated) | GREEN |
| 34 | `spike/34-verify-thread-gw.mjs` | guest TX → gateway room → peer (needs live gw `:5095`) | GREEN with gw, else SKIP |
| 35 | `spike/35-verify-thread-inject.mjs` | host-staged beacon pan=0x5678, fabricated suppressed, C6/H2/C5 | GREEN |
| 36 | `spike/36-verify-thread-multi.mjs` | C6 TX → relay → H2 reports 0xAAAA | GREEN |
| 37 | `spike/37-verify-thread-attach.mjs` | C6 Leader + H2 Child via relay | GREEN (self-retrying ≤5 attempts; timing-flaky ~2/3 solo) |
| 37b | `spike/37b-verify-thread-attach-b.mjs` | C6 + C6B variant probe | FAILS (challenge race — diagnostic only) |
| 38 | `spike/38-verify-thread-multihop.mjs` | C6 + C6B router + H2 via router, A↔C firewalled | BLOCKED (see §7) |
| 39 | `spike/39-verify-thread-key2.mjs` | 37 flow, reversed key (/tmp builds) | GREEN (needs /tmp key2 builds present) |

- 37 design: A boots solo → Leader (≤60k batches); B boots; relay loop ≤4000 rounds × 200 steps/node; per-direction queues, stage-only-if-slot-free; TX-driven + GetState-hop idle delivery; cursors `frame.n`; latest-wins ParentReq replacement + 3 s in-flight hold; asserts B role 2 seen, A still 3/4, no crash. Self-retries whole attach ≤5× with fresh instances (C6 solo-boot flakes like 21/22/23, see `issue.md` #3).
- 38 design: same + firewalled pairs (no relay(a,c)/relay(c,a) — C can ONLY hear B, proving topology); B=C6B (upgrade hook); C=H2 booted after B router; finer rounds (3000×100 steps) for 2× relay resolution; Adel/Bdel + polls printed.
- 39 design: 37 clone with `loadSample` preferring `/tmp/thrbuild_<tag>k2/` then `samples/`, prints `using …`.
- Probes (`spike/probe-*.mjs`): `crib` (CTR-crib host decrypt of Parent Req — the MLE-wire proof), `decrypt/brute` (failed AAD attempts — superseded by crib), `youngA` (replay captured req into young leader — A answers when timers align), `copy` (100B pattern integrity — 0/100 mismatch when unraced), `state/polls/slot/mle/attach/eui/A2solo` (superseded diagnostics, keep for reference).

---

## 7. The blocked front: 38 multihop challenge race (full detail)

- Symptom: B (healthy C6B) never attaches. Trace shows B ParentReq TX#2,3,4… every ~750 ms, each with a FRESH 8B challenge; A answers exactly one (unicast len-113 Parent Response, `61dc…`) but B has already moved on — answer references a stale challenge → dropped. A-TX#12 len-113 repeats; B roles stuck [0,1,4]→[4]?? actually B shows [0,1,4] (sees A beacons?) but never role 2; C never boots (gated on B router).
- Why H2 wins 37: H2's loop is half-dead (tick decay — polls crawl), so it sends exactly ONE ParentReq and waits; A's ~700 ms response lands on the still-current challenge. Health is the enemy here.
- Attempted (all in git log, all insufficient): latest-wins queue replacement (drop older queued PRs), 3 s in-flight hold after Parent-Response sighting, 5–8 s optimistic hold (forward first, hold rest), pump gating (freeze child pump / windowed n<200/500 / role-gated / half-rate), slow loop (1000 ms), finer relay rounds (2× resolution), LP/HP home splits, per-pair cursors.
- Decisive experiment: `probe-youngA.mjs` replays a captured H2 req into a YOUNG leader → A answers (TX#10+ len-113) and keeps living (ads, scans). A is healthy; the race is purely B-side churn vs A-latency.
- Host-decrypted wire (CTR crib, `probe-crib.mjs` HIT `macRawRev level=5`): Parent Req = cmd `09` + Mode `01` + Challenge(8) + ScanMask + Version; ScanMask `0x80` = routers-only confirmed — A MUST answer, and does when the challenge is stable.
- What remains: §9.1 StartAt shim (proper waits) is the prime candidate; §9.2 OT-side stable-challenge retry (guest change, heavier); §9.3 harness time-dilation (slow B's OT clock vs A's — unexplored).

---

## 8. MLE wire reference (host-verified, not guessed)

- 802.15.4 data frame (63B ParentReq example): FCF `41d8` (type 1 data, pan-comp), seq, dstpan `ffff`?? actually dst `3412`=0x1234? (see hex below), dst short `ffff` (broadcast), src ext 8B, 6LoWPAN `7f3b02f04d4c4d4c…` (10B), MLE from offset 25.
- MLE: suite `0x00` (0 IS the secured suite; 255 = unsecured) + secCtl `0x15` (KeyIdMode2/Mic32) + counter LE + keySeq BE + keyIdx (`(seq&0x7f)+1`) + enc(cmd+TLVs) + MIC4.
- Key: `HMAC-SHA256(masterKey, BE32(seq) || "Thread")[0:16]`; seq 0 → `5445f415…`, seq 1 → `8f4cd1a2…` (node e2e verified both).
- Nonce (the trap): ext is IID-derived with MAC bytes REVERSED (`macRawRev`) + LE32(0) counter + level 5 — NOT the over-the-air ext order. Standard AES-CCM AAD attempts all fail; CTR-crib on known header (`09 01 01 0f…`) hits.
- Captured frames: H2 req `41d83d3412ffff03c9c589d428a512 7f3b02f04d4c4d4c 738d0015 00000000 00000000 01 <enc27> <mic4>` (`/tmp/mle63.bin`, 63B); A resp len-113 `61dc…`; H2 ad len-69 `41d8bc34…` (`/tmp/h2_ad.bin`).
- IPv6: sender link-local from EUI (flip U/L bit), receiver `ff02::1/2` per dst byte `frame[17]`.

---

## 9. Next work (ordered; §9.1 is the big win)

### 9.1 StartAt shim — the multihop unblock (proper 750 ms waits → stable challenges → B attaches → upgrades → C attaches). Parks + sketch, no emu-core.

- Background: real `otPlatAlarmMilliStartAt` (22B @ `0x42038d6e`) programs a dead FRC/esp_timer and returns; OT's Timer scheduler still queues off GetNow(ticks)+pumped Fired, BUT the attacher's 750 ms ParentReq wait never actually paces — retries fire event-driven back-to-back. A StartAt shim recording (t0,dt,armed) to LP+0x3c and returning OK was built (function `alarmStartPark`, boxSym2 secondary-box placement, THREAD_HOOKS entry, inline hook with nop pad) — it regressed 37 (attach windows shifted, all-FAIL runs) and was fully reverted; only a 4-line NOTE remains in `core/thread_shims.mjs`. Re-attempt surgically:
  1. Re-add `alarmStartPark` (leaf, own frame: `li T0,LP+0x3c; sw a1,+0; sw a2,+4; li T1,1; sw T1,+8; ret`) + THREAD_HOOKS entry + placement AFTER in2At in the box cursor (never disturb deliver/copy/alarmNow/inbound2 addresses — address stability is timing stability).
  2. Prefer the SECONDARY dead box (`receive_done` when primary is `enh_ack_generator` and vice versa) so primary-box layout is bit-identical with/without the shim (A/B test clean).
  3. Inline-hook StartAt with `li t0,startAt; jalr x0,t0` + `0x13` nop pad to `startSym.size` (22B needs ≥12B; verified fits).
  4. Validate: 32/35 green first (no timing shift), then 37 solo ×3 (must stay ≥2/3), then 38 (expect B role 2 → 3 → C role 2).
  5. If 37 regresses again: gate the hook per-node — hook only B (C6B binary already carries `-DTHREAD_NODE_B`; use a second shim profile keyed by ELF marker string `node-b EUI`?? or env `THREAD_STARTAT=B-ONLY` plumbed through `prepareThreadShims(elf,chip,opts)` + `core/esp32c3.mjs` caller). A keeps real StartAt; B gets paced waits.
  6. Sketch side (optional): B already half-rate pumps (`(n%2)==0`); with real waits, restore full-rate pump on C6B and re-test (fewer moving parts).
- Success bar: 38 asserts `B role 2 → B role 3 → C role 2 (A firewalled)` green; 37/39 stay green; 32/35/36 unbroken.

### 9.2 H2/C5 tick-death root cause (their loops die fast; C6 lives). Peripheral/emu-core digging.

- DISPROVEN so far: ticks/etime/`now` march fine on H2 solo (diag identical to C6); heap stable (165K H2 vs 362K C6 — smaller RAM, not leaking); no Guru. "Death" is OT-progress death (no TX after batch ~500, roles frozen), not CPU death.
- Hypotheses left: SYSTICK/per-chip timer wiring (tick ISR rate differs → alarm timebase skews → timers pile up); 15.4 LL interrupt path differences (H2/C5 share HP staging; C6 uses LP — re-test H2 staging in LP with a coherence retry?); RF coexistence stubs per-chip.
- Probes: `probe-state.mjs` (instance+Mac0/1 via LP mirror — Mac stuck 5/dwell 1 post-election?), solo rescan-BUSY test per chip (rescan rc=5 ⇒ wedged; rc=0 ⇒ alive), long-solo TX census per chip (TX# timeline to 100k batches).
- Payoff: H2/C5 could route (38 with H2-B instead of C6B), long runs stabilize, tick-decay workaround (upgrade hook immediacy) removable.

### 9.3 Commissioning/join slice — PSKc/joiner flows, in-network rekey (key seq++). Needs commissioner-side design first.

- Done: key2 agility (39) proves dataset swap works end-to-end with real crypto.
- Open: PSKc/joiner-requester flow (which OT APIs? `OThread` wrapper exposes dataset commit only — check `OThread.h` for joiner hooks), commissioner on A (register PSKc, accept joiner), in-network rekey (bump key seq, both ends re-derive via KDF — host-verified KDF makes assertions checkable), confirm `keyIdx=(seq&0x7f)+1` rotation on the wire.
- Design-first: no commissioner code exists in sketch or harness; do NOT start by coding — write the 3-message flow (discovery → PSKc auth → dataset deliver) against OT docs, then slice minimal (joiner-only first, commissioner stubbed by harness-held PSKc? or full OT commissioner?).

### 9.4 CI results + Bumble radio (both need the human/GH UI — agent checks, human acts).

- CI: `.github/workflows/verify.yml` split 7 ways (ble, c3, multichip, mpy, thread-pump, wifi SKIP-gated, bumble non-blocking) was pushed with 5018107/55c7de6/24b5044 — auto-ran on push. Agent: NO `gh` binary here — check via git log + ask user to paste GH Actions URLs/results; fix only what CI flags.
- Bumble/phone-in-the-loop: BLOCKED — uid 1000 (no VHCI), no `/dev/vhci*`, no dongle in `~/platform-tools`. Pump + toggle already landed (33 green); real radio needs hardware or `vhci_bridge.py` + root. Agent: re-verify absence, do not burn cycles; document in HANDOVER if anything changes.

---

## 10. Opencode todo list (paste into `todowrite`; mirrors §9 + regression gates)

```json
[
  {"content": "Re-add alarmStartPark leaf (LP+0x3c record, own frame) + THREAD_HOOKS entry", "status": "pending", "priority": "high"},
  {"content": "Place StartAt in secondary dead box (primary layout bit-identical)", "status": "pending", "priority": "high"},
  {"content": "Inline-hook StartAt (li+jalr+nop pad, size>=12 check)", "status": "pending", "priority": "high"},
  {"content": "32+35 green with StartAt (no timing shift)", "status": "pending", "priority": "high"},
  {"content": "37 solo x3 (>=2/3 green) with StartAt", "status": "pending", "priority": "high"},
  {"content": "38 multihop green (B 2->3, C 2 via B, A firewalled)", "status": "pending", "priority": "high"},
  {"content": "Fallback: per-node StartAt (B-only via C6B marker/env)", "status": "pending", "priority": "medium"},
  {"content": "H2/C5 tick-death: solo TX census to 100k batches per chip", "status": "pending", "priority": "high"},
  {"content": "H2/C5 tick-death: rescan-BUSY wedge test per chip", "status": "pending", "priority": "high"},
  {"content": "H2/C5 tick-death: Mac state/dwell via probe-state post-election", "status": "pending", "priority": "medium"},
  {"content": "Commissioning design: joiner flow doc (3-message slice)", "status": "pending", "priority": "medium"},
  {"content": "Commissioning: joiner-only minimal build + verify", "status": "pending", "priority": "medium"},
  {"content": "Rekey: key seq++ in-network rotation check (keyIdx wire assert)", "status": "pending", "priority": "medium"},
  {"content": "CI: collect GH Actions results from user, fix flagged jobs", "status": "pending", "priority": "medium"},
  {"content": "Bumble: re-verify VHCI/dongle absence, document", "status": "pending", "priority": "low"},
  {"content": "Regression: 32/35/36/37/39 green after every shim change", "status": "pending", "priority": "high"},
  {"content": "Push: commit + push with keepalive SSH after each green slice", "status": "pending", "priority": "high"}
]
```

- [ ] Re-add `alarmStartPark` leaf (LP+0x3c record, own frame) + `THREAD_HOOKS` entry (`core/thread_shims.mjs`)
- [ ] Secondary-box placement (primary layout bit-identical with/without shim)
- [ ] Inline hook (`li t0,startAt; jalr x0,t0` + nop pad; assert `startSym.size >= 12`)
- [ ] 32 + 35 green (no timing shift from the new hook)
- [ ] 37 solo ×3 (≥2/3 green; self-retry ≤5 covers flakes)
- [ ] 38 GREEN (B role 2 → 3, C role 2 via B, A firewalled, no crash)
- [ ] Fallback if 37 regresses: B-only StartAt (C6B ELF marker or env opt through `prepareThreadShims`)
- [ ] H2/C5: solo TX census to 100k batches (per-chip liveness timeline)
- [ ] H2/C5: rescan-BUSY wedge test per chip (rc=5 wedged vs rc=0 alive)
- [ ] H2/C5: Mac state/dwell via `probe-state.mjs` post-election
- [ ] Commissioning design doc (joiner 3-message slice before coding)
- [ ] Joiner-only minimal build + verify
- [ ] In-network rekey (seq++, `keyIdx` wire assert via CTR crib)
- [ ] CI results triage (needs user-pasted GH URLs; no `gh` here)
- [ ] Bumble re-check (VHCI/dongle; expect still blocked)
- [ ] Full regression (32/35/36/37/39) after every shim edit
- [ ] Commit + push (keepalive SSH) after each green slice

### 10.1 Item handbook (why → how → gate → rollback; §9.1 detail)

1. **Re-add `alarmStartPark` leaf + `THREAD_HOOKS` entry.** WHY: §7 race — attacher waits never pace (StartAt programs dead FRC). HOW: leaf per §16 (`li T0,LP+0x3c; sw a1,+0; sw a2,+4; li T1,1; sw T1,+8; ret`, own 16B frame, no S0, no T4-live clash); add `'otPlatAlarmMilliStartAt'` to `THREAD_HOOKS`. GATE: `node --check` + load-all-chips (no `skip` warns). ROLLBACK: delete function + entry (v1 did exactly this).
2. **Secondary-box placement.** WHY: v1 disturbed primary layout → 37 regressed. HOW: resolve both dead boxes; primary keeps deliver/copy/alarmNow/inbound2 at identical addresses; StartAt goes to the OTHER box (`receive_done` if primary is `enh_ack_generator` and vice versa); skip cleanly if either unmapped. GATE: diff box addresses with/without the shim (log + compare). ROLLBACK: `boxSym2 = null` forces primary-tail (still identical? No — re-diff).
3. **Inline hook.** WHY: redirect OT's calls into the park. HOW: `li t0,startAt; jalr x0,t0` + `0x13` nop pad sliced to `startSym.size`; assert `>= 12` (22B actual). GATE: file-offset dump shows jump at StartAt vaddr; 32 still green. ROLLBACK: remove the two `extra.push` lines.
4. **32 + 35 green.** WHY: timing-shift canary (fast, deterministic). HOW: run both fully; any FAIL = address/timing disturbance, not flake (these two don't flake). GATE: both PASSED. ROLLBACK: revert hook, keep park (park without hook is inert).
5. **37 solo ×3.** WHY: the flake gate (self-retry ≤5; ≥2/3 = pass). HOW: three full runs; log attempt counts. GATE: ≥2 PASSED. ROLLBACK: if 0–1/3, go to item 7 (B-only) before touching anything else.
6. **38 GREEN.** WHY: the actual unblock. HOW: full 3000-round run; watch B-TX# lens (want 69/75/113s, not endless 63s), A-TX#113s, Adel/Bdel, B polls. GATE: `B role 2 → B role 3 → C role 2 (A firewalled)` + no crash. ROLLBACK: none — on success, update 38 STATUS header + HANDOVER Wave J + §1/§7 here.
7. **Fallback: B-only StartAt.** WHY: v1 regressed ALL nodes; B alone may pace retries without shifting A. HOW: key off C6B ELF marker (string `node-b EUI`?? — C6B still carries it as a print? No — EUI override removed but the print string may remain; else add a fresh `-D` marker section) or env `THREAD_STARTAT=B-ONLY` through `prepareThreadShims(elf,chip,opts)` + caller in `core/esp32c3.mjs`. GATE: 37 green + 38 green. ROLLBACK: env default = all-nodes (current behavior).
8. **H2/C5 solo TX census.** WHY: is "tick death" CPU or OT-progress death? HOW: solo boot each chip, log TX# {n,len,hex16} to 100k batches (see §11 probe pattern). GATE: timeline showing last-TX batch per chip. ROLLBACK: n/a (read-only).
9. **H2/C5 rescan-BUSY test.** WHY: distinguishes wedge (rc=5) from silence. HOW: rescan-probe sketch already emits `rescan-start rc=`; run solo per chip, collect rc series. GATE: rc=0 alive / rc=5 wedged verdict per chip. ROLLBACK: n/a.
10. **H2/C5 Mac state/dwell.** WHY: Mac stuck 5/dwell 1 post-election would explain silence. HOW: `probe-state.mjs` LP-mirror read post-60k run. GATE: Mac0/1 numbers per chip. ROLLBACK: n/a.
11. **Commissioning design doc.** WHY: no commissioner code exists; coding blind wastes builds. HOW: `doc-coauthoring` skill workflow; 3-message slice (discovery → PSKc auth → dataset deliver) against OT docs; check `OThread.h` joiner hooks first. GATE: reviewed doc, not code. ROLLBACK: n/a.
12. **Joiner-only build.** WHY: smallest comm slice. HOW: sketch joiner flow, harness holds PSKc (stub commissioner?) — decide in doc first. GATE: new verifier green (name it `40-…`). ROLLBACK: keep stub out of stock sketch (flag-gated like THREAD_KEY2).
13. **In-network rekey.** WHY: proves key agility beyond swap (seq++ rotation). HOW: bump seq on leader, assert `keyIdx=(seq&0x7f)+1` on wire via CTR-crib method (§8). GATE: crib HIT on rotated frames + both nodes stay attached. ROLLBACK: n/a (additive test).
14. **CI triage.** WHY: 7-way split auto-ran on recent pushes. HOW: ask user for GH Actions URLs (no `gh` binary here); fix only flagged jobs. GATE: user confirms green or pastes failures. ROLLBACK: n/a.
15. **Bumble re-check.** WHY: cheap to confirm still-blocked. HOW: `id -u` (=1000, no VHCI), `ls /dev/vhci*`, `ls ~/platform-tools | grep -i ble`. GATE: documented still-blocked (or new hardware → new plan). ROLLBACK: n/a.
16. **Full regression after every shim edit.** WHY: shims are timing-critical; 32/35/36/37/39 each guard a different layer (§19). HOW: run in that order (fast→slow); stop at first red. GATE: all PASSED. ROLLBACK: `git stash` the shim, re-run to confirm green baseline.
17. **Commit + push per green slice.** WHY: ELFs are large; small packs push reliably. HOW: stage verifier + sketch + samples together; keepalive SSH (§11); confirm `## main...origin/main` clean. GATE: remote in sync. ROLLBACK: `git reset --soft HEAD~1` if pushed wrong (then force-push is FORBIDDEN — ask user).

---

## 11. Command cheat sheet (copy-paste; repo root = `/home/danish1075/Documents/espc3 wasm`)

```bash
# --- suites (headless, real firmware) ---
node spike/32-verify-thread.mjs        # scans+beacons, ~2 min
node spike/35-verify-thread-inject.mjs # injection C6/H2/C5, ~4 min
node spike/36-verify-thread-multi.mjs  # relay C6->H2, ~5 min
node spike/37-verify-thread-attach.mjs # attach (self-retry ≤5), ~5-9 min
node spike/39-verify-thread-key2.mjs   # key2 attach (needs /tmp key2 builds)
node spike/38-verify-thread-multihop.mjs # BLOCKED (expect 3 FAILs until §9.1)
node spike/34-verify-thread-gw.mjs     # SKIP without live gateway

# --- gateway (for 34) ---
go build -o /tmp/openhw-gw ./...       # run in openhw-studio-gateway/
GW_PORT=5095 /tmp/openhw-gw &          # then 34 goes live (no SKIP)

# --- sketch rebuilds (ALWAYS after .ino edits) ---
export TMPDIR=/tmp/isolated_path; mkdir -p /tmp/isolated_path
arduino-cli compile --fqbn esp32:esp32:esp32c6 spike/sketches/ThreadDemo --build-path /tmp/thrbuild_c6
cp /tmp/thrbuild_c6/ThreadDemo.ino.{merged.bin,elf} samples/threaddemo_c6.
... repeat h2/c5 (samples/) ...
arduino-cli compile --fqbn esp32:esp32:esp32c6 --build-property build.extra_flags=-DTHREAD_NODE_B spike/sketches/ThreadDemo --build-path /tmp/thrbuild_c6b
cp /tmp/thrbuild_c6b/ThreadDemo.ino.{merged.bin,elf} samples/threaddemo_c6b.
arduino-cli compile --fqbn esp32:esp32:esp32c6 --build-property build.extra_flags=-DTHREAD_KEY2 spike/sketches/ThreadDemo --build-path /tmp/thrbuild_c6k2  # /tmp only!
chmod 755 samples/threaddemo_*.elf

# --- probes ---
F=/tmp/c6a_req.bin node spike/probe-crib.mjs   # host-decrypt a ParentReq (crib HIT expected)
node spike/probe-decrypt.mjs                   # AAD attempts (expected FAIL; superseded)
node spike/probe-youngA.mjs                    # replay req into young leader (answers if healthy)

# --- git (large ELFs; keepalive or push dies mid-pack) ---
export GIT_SSH_COMMAND="ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=20 -o TCPKeepAlive=yes"
git push origin main
```

- Toolchain: `arduino-cli` 1.5.1+, core `esp32:esp32 3.3.10`, node v22, go 1.26. `TMPDIR=/tmp/isolated_path` avoids PyInstaller sandbox collisions.
- Timeouts: tool calls cap ~590 s; 37/38 need the full window. Never shorten verifier loops to "save time" — timing IS the test.
- `claude` CLI is NOT installed here (`which claude` → nothing); background-agent handoff via `claude --bg` is unavailable — this file IS the handoff.

---

## 12. Suggested skills (next agent: call `Skill` tool for these)

- `webapp-testing` — if you touch `index.html`/`app.js`/gateway UI or need to verify the monitor pipeline headlessly.
- `playwright-interactive` — if you must click through the browser REPL/monitor to prove a UI-visible Thread state.
- `doc-coauthoring` — if you write the commissioning/joiner design doc (§9.3) — use its structured workflow, don't free-form it.
- `customize-opencode` — ONLY if you edit opencode's own config (you won't for this task; application code uses normal tools).

---

## 13. Gotchas checklist (do not relearn these)

1. `lui` op takes the FULL base (`0x60000000`); `rvasm` shifts itself. Passing `0x60000` faults at Transmit+8.
2. Sync EnergyScanDone wedges SubMac (state 5 → `mac_links.hpp:536`). Always deferred via GetState poll.
3. Fabricated beacons on MLE TXs wedge SubMac BUSY forever. Frame-gate TX paths (§4.4).
4. JS-staged bytes aren't guest-visible in place (H2 especially). Always guest-copy slot→rxBase before ReceiveDone.
5. Heap phantoms match magic+len+type. Always verify mPsdu==slot+32 park-side AND JS-side; never consume phantoms.
6. `frame.n` cursors only. Array indices break on the 256-cap ring shift.
7. a0 must survive EnergyScanDone in getstatePark (save/restore) — its return clobbers instance.
8. `vTaskSuspendAll` around Fired deadlocks boot. Never re-add.
9. EUI override via `esp_base_mac_addr_set` is ignored by OT. Don't rely on it for identity.
10. Rebuild samples after EVERY `.ino` change; `chmod 755` ELFs; key2 builds stay in /tmp.
11. Push with keepalive SSH; expect ~500 objects / large packs (ELFs).
12. `otPlatAlarmFired` doesn't exist; it's `otPlatAlarmMilliFired`. `delay(100)` fast everywhere except deliberate C6B trials.
13. Mirror (`deliveries()`) returning −1 usually means "not found this run", not "zero deliveries" — re-scan, don't conclude.
14. 37 is timing-flaky by nature (~2/3 solo); its ≤5 self-retry is load-bearing, not cowardice. Don't "fix" flakes by shortening loops.
15. `spike/37-verify-thread-attach.mjs:32-38` `elfCandidates` has a copy-paste oddity (`merged.bin` in an elf list, shadowed by `elfC2`) — harmless but don't cargo-cult it into new files.

---

## 14. Redaction / sensitivity note

- No API keys, passwords, or PII in this repo or handoff. The Thread test master key (`0011…EEFF` + reversed key2) is the public Thread spec test key, shared with the harness by design — safe to keep in-tree.
- Gateway runs localhost-only (`127.0.0.1:5095`); no external credentials involved.

---

## 15. Where to start (first 30 minutes for the fresh agent)

1. `git status -sb; git log --oneline -5` — confirm clean @ `224ed2c`.
2. `node --check core/thread_shims.mjs` — syntax sanity.
3. Run `32` (fastest green) to prove the rig, then `35`, then `37` (budget ~15 min total).
4. Read `core/thread_shims.mjs:720-880` (box layout + hook placement) with the §4.3 park list open.
5. Implement §9.1 steps 1–3, then gates 4–6. Commit + push per green slice.
6. If 38 goes green: update `spike/38-…` STATUS header, `HANDOVER.md` Wave J (38 → green, new wave K), and this file §1/§7.

*End of handoff — `THREAD_HANDOFF.md`. Primary sources: `HANDOVER.md` (Waves E–J), `core/thread_shims.mjs`, `spike/37|38|39-verify-thread-*.mjs`, `spike/sketches/ThreadDemo/ThreadDemo.ino`, git log `5018107..224ed2c`.*

---

## 16. Park register contracts (exact; write new parks to match)

- Conventions: `A0-A3` args/return, `T0-T6` scratch (caller-saved, dead across `jalr_ra`), `S0` callee-saved (only txMain/beacon use it; deliverPark deliberately avoids S0 now), `SP` 16B-aligned frames, `RA` handling per entry type.
- `emitSub` (leaf, `jal ra,emit`): reads A1 (frame) read-only; uses T0 (UART base), T1 (byte), T2 (nibble/out), T3 (psdu cursor), T4 (len counter). Returns via `ret`. Never touches SP/s0/a-regs.
- `txMainProg` (at Transmit+0x5A, entered via `j` so RA = OT's return): builds 16B frame (`ra, s0, a0, a1`), s0 = TX channel (`lbu s0,6(a1)`), calls emit (PH_EL), TxDone (PH_DL, a2=a3=0), reloads a0 = saved instance, then frame-type gate uses T1/T2/T4 (T4 = Mac+1 addr via `li 0x2f8c; add`), sets a1 = s0 (channel, ignored by inbound2), jumps via PH_IN/PH_J with `jalr x0` (RA preserved = OT's return). `tx_skip` epilogue: restore ra/s0, SP+=16, a0=0, ret.
- `inboundPark/inbound2Park` (entered via `jalr x0`, RA = OT's return still): own 16B frame; T0 = slot, T1/T2 = checks; copySub call via PH_CP (`jalr_ra t5`); consume (sw 0 @+160 and @+4); mPsdu fix (`li T0,rxBase; addi T1,T0,32; sw T1,0(T0)` — inbound2 only; inbound lacks room, documented 6B short); a0 intact for inbound (t-regs only) while deliver/inbound2 reload a0 from stack; ReceiveDone via `li T1,done; jalr_ra`; epilogue pops BOTH frames (`lw ra,28(sp); SP+=32; a0=0; ret`). inbound2-empty path: pop own (`SP+=16`) then pop txMain's (`lw ra,12(sp); SP+=16; a0=0; ret`) — single-returns, never double-pops.
- `beaconPark` (entered via `j`, same double-pop discipline as inbound-taken path): own 16B frame; T0 = rxBase; zero @+8/+12/+16; beacon words BEACON_W0..W4 @+32..+48; pad 0 @+52; mPsdu = T0+32; len/ch word @+4 (`slli T1,a1,16; addi len`); rssilqi @+20; LP mirror anchor @LP+0x200 (magic/len0/mPsdu, idempotent); ReceiveDone; epilogue double-pop (assumes exactly txMain's frame beneath — inbound-fallback pre-pops its own).
- `deliverPark` (entered via `jalr ra` from getstate hop; RETURNS there): own 16B frame (`ra, a0-save`); T4 = Mac+1 addr (recomputed, never saved — no borrow); T3 = Mac+1 (gate); T0 = slot; mPsdu gate (`lw T1,0(T0); li T2,slot+32; bne→hold`); FCF gate (`lbu T1,32(T0); andi 7; bne→deliver; beacon+idle→hold`); copySub via PH_CP; consume; mPsdu fix; ReceiveDone (a0 reloaded); counter++ @LP+0x28; pop own, `ret` (single-pop to getstate hop). `dv_hold`: leave slot pristine, pop own, ret.
- `getstatePark` (entered via `j`, RA = OT's return): own 16B frame (`ra, a0-save` @+8); flag check (T0=flag, T1=word); EnergyScanDone path (`sw 0; a1=-60; li T1,done; jalr_ra`); restore a0 from stack; slot conditional-init (magic absent → plant magic+len0+mPsdu; present → skip to status); delivery hop (magic + len≠0 → `PH_DV jalr_ra t5`, returns); status (`lw ra; SP+=16; a0=2; ret`).
- `copySub(slot,rxBase)` (leaf, `jalr_ra t5`): T1=slot, T2=rxBase, T3=40, loop `lw T4,0(T1); sw T4,0(T2); T1+=4; T2+=4; T3--`; uses T4 as data temp — callers must not hold live values in T4 across the call (deliverPark recomputes Mac addr AFTER? No — deliverPark reads Mac BEFORE copySub into T3/slot-T0; T0 survives (callee uses T1-T4… wait T0 not touched by copySub — safe; a0-save is on STACK — safe).
- `alarmNowPark(tickAddr)` (entered via `jalr x0` from hooked GetNow): own 16B frame; `li T1,tick; jalr_ra` (a0 = ticks); restore ra; SP+=16; ret (a0 = ticks to OT).
- `patchPairs` mechanics: placeholders are RAW words (PH_*0/1 pairs = `li` two-word sequences); `li(rd,val)` in `rvasm.mjs` emits `lui+addi`; scan blob for pair, overwrite both words. Missing pair → throw `txMain placeholders missing` → layer degrades (see 1c history: HACK probe once broke this — keep PH_BC markers even in dead code).
- Adding a new park: assemble standalone → size-check vs box BEFORE placing → cursor-append (`boxNext`) → patch its PH_CP/PH_DV → push `{addr,bytes}` extras → wire caller placeholder. Never reorder existing box residents (address stability = timing stability).

---

## 17. Harness relay cookbook (how 37/38/39 move frames)

- Each MCU: `slotState` (buf-identity-checked cache: `{buf, lin, fwdN/queue}`), `findSlot` (linear magic scan + len0 + mPsdu match), `slotFree`, `stageInto` (psdu≤127 cap, struct fill: mPsdu=guest+32, len, channel, rssi/lqi bytes, magic), `deliveries` (LP mirror scan).
- Forward: per-source cursor over `src.thread.frames` using `f.n` (absolute). New frames → optional latest-wins filter (ParentReq len-63 type-1 replaces older queued PRs) → optional in-flight hold (drop PRs <3 s after a len-100..120 unicast sighting) → `dstSt.queue.push`.
- Flush: `while (queue.length && slotFree(dst)) stageInto(dst, queue.shift())`. Queue cap 64 with WARN + drop-oldest (backpressure signal — if you see WARNs, the peer isn't consuming; check wedge/BUSY).
- Stepping: `mcu.step(100000)` batches; 37/39 use 200 steps/node/round (≤4000 rounds); 38 uses 100 steps × 3000 rounds (2× relay resolution, same OT). UART windows sliced to 30–80KB (`out.slice(-30000)`) — role assertions use regex over the window; boot-phase roles scroll out, so 37 latches `bChildAt` incrementally per round (never window-at-end).
- Ordering: A boots solo → Leader asserted; THEN B boots (deterministic; avoids dual-election). 38: C boots only after B router (gated in-loop).
- Firewall (38 only): simply never call relay(a,c)/relay(c,a). Per-ordered-pair cursors (`sst[key]`) so dropped pairs don't advance live pairs. C can ONLY hear B ⇒ C parenting B is topologically proven.
- In-flight pause (37/39; 38 has optimistic-hold variant): Parent Response sighting = any NEW frame len 100–120, FCF type 1. On sight, hold B→A ParentReqs 3 s (37) — gives Child-ID exchange a stable challenge. If holds starve (no sight ever), safety: 38 forwards first then holds 5 s per-pair (`sst[key+':fwdpr']`).
- Self-retry (37 only, ≤5 attempts): whole-attach loop with FRESH `ESP32C3.create` instances per attempt (`peers.clear(); HOME.clear(); failures=0`). C6 solo-boot flakes (~1/3, `issue.md` #3 pattern) make this load-bearing. 39 inherits it (clone). 38 has NO retry (3-node state too expensive to rebuild blindly — restart manually).
- Logging: `relay` prints every staged frame (`len n hex8 qleft`); round prints every 200th (37/39) / 400th (38) with `A.tx/B.tx/C.tx roles Aq/Bq Adel/Bdel`. Keep these — they are the flight recorder.

---

## 18. Failure-mode field guide (symptom → cause → check)

1. `FAIL: became Leader (roles seen: 0,1)` → C6 solo-boot flake (not your shim). Check: retry (37 self-retries; solo probes need manual 3×). See `issue.md` #3.
2. `B roles=[0,1,4] forever, B.tx frozen after ~2` → challenge race (38) or missed window (37 flake). Check: B-TX# lens (63s repeating = retrying; 69/75/113s = progressing), A-TX#113s present? (A answering), `Adel/Bdel` moving? (delivery alive).
3. `rescan-start rc=5` + `tx frozen` → SubMac-busy wedge (beacon on MLE path). Check: did txMain gate get bypassed? (custom build? `mleAt` fallback when in2At=0 → wedge risk documented). Fix: ensure inbound2 placed (box fit) — never force fallback.
4. `active-scan pan=` repeats hundreds/runaway + `done=false` → beaconPark double-frame (the duplicate `addi SP,-16` bug class). Check: beaconPark prologue has exactly ONE frame alloc. (Fixed once; regression pattern to watch.)
5. `Guru Load access fault @ deliverPark/copySub` → staging incoherence (H2 LP) or slot clobbered (HP heap). Check: which chip? H2+LP-home = incoherent (use HP); C6-long-run+HP-home = heap-eaten (use LP). `slotAddrFor` table is the fix; don't invert it.
6. `Adel runaway (2→22)` → heap phantoms (magic+len+type colliding in live heap). Check: mPsdu gates present park-side AND discovery-side? Consume path clears magic+len (exactly-once)? Never consume on gate-fail.
7. `roles stuck 0,1 + Guru` after sketch edit → `vTaskSuspendAll` re-added or alarm pump deleted. Check: loop() pump present, no scheduler lock, `delay(100)` intact.
8. `THREAD ATTACH: FAILURE after 5 attempts` (37, rare) → genuine bad-luck streak OR host under load (CI). Check: run again; if repeatable ×3, suspect shim regression → bisect with 32 first.
9. `elfCandidates merged.bin oddity` → known copy-paste in 37:32-38 (elf list contains a `.merged.bin`, shadowed by `elfC2`). Harmless; don't propagate.
10. Push dies mid-pack (`send-pack: unexpected disconnect`) → missing keepalive. Check: `GIT_SSH_COMMAND` exported with ServerAliveInterval=30.
11. `Cannot find module ... thrbuild...k2` (39) → /tmp key2 builds absent (reboot/volume wipe). Check: rebuild with `-DTHREAD_KEY2` (§11), never commit.
12. `34 SKIP` → gateway not running. Check: `GW_PORT=5095 /tmp/openhw-gw &` then rerun.

---

## 19. Per-verifier internals (what green actually proves)

- 32 (57 asserts): enable ret0 + radio RECEIVE + energy result −60 + energy-done + active-scan start after retry (no BUSY/assert) + TX tap (beacon `030800ffffffff070000`) + fabricated beacon report (pan 0x1234) + scan-done + no crash, on C6/H2/C5. Guards: shim presence, deferred completion, beacon synthesis, dwell borrow.
- 35: stages a 23B beacon (pan 0x5678) into a post-link-enable node; asserts injected reported + fabricated suppressed (slot consumed exactly once) + scan completes, per chip. Guards: slot discovery, guest-copy coherence, consume-exactly-once, FCF hold (beacon held off-scan, picked up during scan TX).
- 36: A=C6 scans/TXs; harness relays A's beacon-req-shaped relay PSDU (pan 0xAAAA) into H2's slot; asserts H2 reports 0xAAAA while A keeps 0x1234. Guards: cross-instance relay + per-chip homes (C6-LP staging? No — 36 stages into H2-HP; A is stock C6).
- 37: full attach (see §17). Asserts B role-2 SEEN (history latch), A still 3/4, no crash. Guards: idle delivery (silent A consumes B's reqs via GetState hop), TX-path delivery, latest-wins + in-flight hold, alarm pump pacing.
- 39: 37 with reversed key. Guards: harness key-agnosticism (no key baked into relay/parks — crypto stays in-guest).
- 38: 3-node firewalled (see §7/§17). Currently asserts B-2, B-3, C-2 — all FAIL until §9.1. Its value now is as a RACE INSTRUMENT (B-TX#/A-TX# traces), not a gate.
- 34: guest TX → `thread-gateway` WS room → peer sees PSDU. Guards: controller tap → gateway serialization (not the radio model itself).

---

## 20. Magic-number glossary (every constant, one line)

- `0x54485244` THRD: slot magic @+160 (planted disarmed, consumed on delivery).
- `HP_BASE 0x40820000` (I2C cell, coherent-but-heap), `LP_BASE 0x50000000` (heap-clean SRAM), `SLOT_OFF 0x180`, `RX_SCRATCH_OFF 0x100`, `FLAG_WORD_OFF 0x20`, counter LP+0x28, LP mirror LP+0x200 (+32 mPsdu, counter at mirror−0x1d8).
- `RX`: rxBase mPsdu fix = rxBase+32; copySub = 40 words/160B; otRadioFrame struct 32B (psdu@0, len u16@4, ch@6, rssi@21, lqi@22).
- `TX_MAIN_OFF 90/0x5A`; GetState WEAK 6B; mac_init 266B box; transmit 250B / transmit_at 254B boxes; enh_ack 436B / receive_done 344B fallback boxes.
- `Mac* = instance + 0x2F8C`, dwell byte Mac+1; `BEACON_W0..W4/LEN 23/RSSI −50/LQI 200/seq 0x5A/PAN 0x1234/ext C4:22:…`; energy RSSI −60; RELAY_RSSI −50/LQI 200.
- `MLE`: suite 0x00 secured, secCtl 0x15, KDF `HMAC(master,BE32(seq)||"Thread")[0:16]`, nonce = reversed-ext + LE32(0) + level 5, cmd 09 ParentReq, ScanMask 0x80 routers, keyIdx `(seq&0x7f)+1`.
- `OT roles`: 0 disabled, 1 detached, 2 child, 3 router, 4 leader. B-TX cadence ~750 ms; A response latency ~700 ms (the race margin).
- `lo`ops: step batch 100000 insns; 37/39: 200 steps × 4000 rounds; 38: 100 × 3000; A-leader boot ≤60000 batches; queue cap 64; PR holds 3 s (37) / 5 s optimistic (38); self-retry ≤5 (37/39).
- `net`: ch 15, PAN 0x1234, extpan 1122334455667788, name ESP-EMU, key 0011…EEFF (key2 reversed), MLE port 19788 (unused by harness — raw 802.15.4 only).
- `addrs`: GetNow @0x42038cc6 (32B), StartAt @0x42038d6e (22B), Stop @0x42038d84 (10B) — C6 build; re-resolve per ELF, never hardcode in new code.

---

## 21. Known-bad ideas log (tried, failed, WHY — do not retry without new evidence)

1. Sync EnergyScanDone (complete inside EnergyScan shim) → SubMac state 5 → `mac_links.hpp:536`. (Disassembly-proven; deferred completion is the fix.)
2. Fabricated beacons on MLE-data TXs → SubMac BUSY forever. (Frame gate is the fix; fallback `mleAt=beaconAt` is documented risk.)
3. Single shared staging home (all-HP or all-LP) → HP eaten on C6-long-runs; LP incoherent on H2. (Per-chip split is the fix.)
4. Beacons delivered off-scan via idle path → 35-inject eats scan beacons early. (FCF dwell gate is the fix.)
5. Mac borrow in idle delivery → data poisoned (Adel runaway 2→22 with borrow; clean without). (No-borrow is the fix; borrow stays TX-path-only.)
6. `vTaskSuspendAll` around Fired → boot deadlock (roles 0,1 + Guru). (Never re-add.)
7. EUI override for node identity → ignored by OT (per-build random EUIs). (C6 vs C6B differ naturally; override removed.)
8. Time-throttle ParentReqs (8 s wall-clock hold) → deterministically starves (drops the good retry too). (Latest-wins + response-gated hold is the fix direction.)
9. Pump freeze by loop-count windows (n<200/500) → retries are event-driven; windows miss. (Role-gated pump is current; half-rate on C6B.)
10. StartAt shim v1 (record + hook all nodes) → 37 regresses (timing shift breaks attach windows). (Retry per §9.1 steps 1–5: secondary-box + optional B-only.)
11. Array-index relay cursors → 256-cap ring shift skips/dupes frames. (`frame.n` cursors are the fix.)
12. Consuming slots on gate-fail (phantoms) → heap corruption + runaway counters. (Hold-pristine is the fix.)
13. Shortening verifier loops to "save time" → timing IS the test; short runs false-red/false-green. (Keep loop budgets.)

---

## 22. Reading order + first-day checklist (fresh agent)

1. This file §1–§3 (state), §11 cheat sheet (commands), §13 gotchas (don't relearn).
2. `HANDOVER.md` §2 Waves E–J (full narrative) + §5.2–5.3 (build/test copy-paste).
3. `core/thread_shims.mjs` header comment (layout) → §16 park contracts → lines 720–880 (box/hook placement).
4. `spike/37-verify-thread-attach.mjs` fully (the reference harness), then `38` diff-vs-37 (firewall + C-boot gating), then `39` diff-vs-37 (loadSample only).
5. `spike/sketches/ThreadDemo/ThreadDemo.ino` (177 lines, all of it).
6. Run gates: `node --check core/thread_shims.mjs` → 32 → 35 → 37. Budget ~15 min. Do NOT start with 38 (blocked instrument, not gate).
7. Implement §9.1; after EVERY shim edit re-run 32/35/36/37/39 before pushing.

